"""
collector/gps_quality.py

Area-wide GPS quality monitor.  Runs as a background sweep thread and
analyses every tracked aircraft for signs of GPS degradation:

  1. NACp degradation  — Navigation Accuracy Category (position) ≤ threshold.
     Sourced from TC=29 / TC=31 ADS-B messages decoded by receiver.py.
     NACp 0–6 = accuracy worse than ~0.1 NM; operationally significant.

  2. Position freeze   — lat/lon unchanged across GPS_FREEZE_POLLS consecutive
     sweeps while groundspeed exceeds GPS_MIN_GS_KT.  The aircraft is clearly
     moving but its GPS output is stuck at the last valid fix.

  3. Position gap      — no ADS-B position message received for GPS_GAP_SEC
     seconds while EHS (altitude + groundspeed) data is still arriving.
     The transponder is alive but the GPS source has dropped out.

Hourly bucket data is persisted to the SQLite ``gps_quality_hours`` table
so that history survives process restarts.  Only *completed* hours are
written — exactly 24 rows per day — so the write load is negligible.
On startup the tracker reloads the last MAX_BUCKETS hours (currently 6
months) from the DB, restoring the time-series chart and heatmap instantly.
The current (incomplete) hour lives in RAM only and is lost on an unplanned
restart, but that is an acceptable trade-off (≤ 59 minutes of data).
The heatmap response is capped independently at HEATMAP_MAX_BUCKETS (31
days) since the heatmap canvas only ever renders the most recent 14 days —
no need to ship 6 months of buckets for a field that gets truncated anyway.

Thread safety
-------------
  GpsQualityTracker._lock (RLock) protects all mutable state.
  The Flask endpoint calls get_state() which acquires the lock briefly
  to take a snapshot; the sweep thread holds the lock only during update().
"""

import json
import math
import threading
import time
import logging
from collections import deque

from database.db import get_db

log = logging.getLogger("modes.gps_quality")

# ── FL band definitions ───────────────────────────────────────────────────────
# Each entry: (lower_ft, upper_ft, label)
# Altitude is pressure altitude in feet (ADS-B barometric altitude).
# FL = pressure altitude / 100, so FL050 = 5 000 ft.
FL_BANDS = [
    ( 1_000,  3_000, "010-030"),
    ( 3_000,  5_000, "030-050"),
    ( 5_000,  8_000, "050-080"),
    ( 8_000, 10_000, "080-100"),
    (10_000, 15_000, "100-150"),
    (15_000, 20_000, "150-200"),
    (20_000, 25_000, "200-250"),
    (25_000, 30_000, "250-300"),
    (30_000, 99_999, "300+"),
]
FL_BAND_LABELS = [b[2] for b in FL_BANDS]
# NOTE: the former single "050-100" band was split into "050-080" / "080-100"
# on 2026-09-07. Historical gps_quality_hours / gps_quality_zone_hours rows
# written before that date still have their events keyed under the old
# "050-100" label inside the stored fl_bands JSON blob. Those events are not
# lost, but they will not appear under either new band — fl.get(lbl, 0) in
# _load_from_db / _load_zones_from_db simply returns 0 for a label that
# doesn't exist in an old row. Only new events recorded after the split are
# correctly split between the two new bands.

# ── Bucket duration ───────────────────────────────────────────────────────────
BUCKET_SEC    = 3_600          # one hour per bucket
MAX_BUCKETS   = 180 * 24       # 6 months rolling — covers the GPS Quality page's
                                # longest time-series selector (6m); also the DB
                                # reload cutoff on startup (_load_from_db / _load_zones_from_db)
HEATMAP_MAX_BUCKETS = 31 * 24  # heatmap only ever renders the most recent 14 days
                                # client-side (HEATMAP_MAX_DAYS in gps_quality.js) —
                                # capped independently so its payload doesn't grow
                                # with the longer time-series window above

# ── Counting-method version ───────────────────────────────────────────────────
# Stored with every hourly bucket so charts can mark where the way events are
# counted changed (numbers before and after a change are not comparable).
#   1 — until 2026-09-25 11:00 UTC: live_state was never pruned; an aircraft
#       returning hours/days later carried its old ADS-B timestamp and position,
#       inflating ADS-B loss (and Freeze) the longer the app ran
#   2 — 2026-09-25 11:00 UTC: live_state pruned after 10 min of silence
#   3 — 2026-09-26: ADS-B loss counted per visit (aircraft must be transmitting
#       extended squitters now); current hour survives restarts (checkpoint)
#   4 — 2026-09-26: all signals require the aircraft to be heard by our own
#       receiver; Freeze = own ADS-B positions keep arriving with identical
#       coordinates; Gap = no position update from any source; new NIC
#       (integrity) signal; NACp version-aware and only while fresh
METHOD_VERSION = 4

# ── ADS-B loss (per visit) ────────────────────────────────────────────────────
# An aircraft counts as ADS-B-active if any DF17 extended squitter was
# received within ES_ACTIVE_SEC.  ADS-B loss = ADS-B-active, position known
# (e.g. MLAT) but no own ADS-B position for ≥ gap_sec during this visit.
ES_ACTIVE_SEC = 30.0

# ── Own-reception / freshness windows (METHOD_VERSION 4) ──────────────────────
HEARD_SEC        = 60.0   # aircraft counted only if our receiver heard it within this window
QUALITY_FRESH_SEC = 30.0  # NACp / NIC values older than this are ignored
FREEZE_POS_SEC   = 10.0   # own ADS-B position must be this recent for a Freeze check

# ── Current-hour checkpoint ───────────────────────────────────────────────────
CHECKPOINT_SEC = 60.0     # write the in-progress hour to gps_quality_live

# ── Distance-zone filtering ───────────────────────────────────────────────────
# Zone names and their radius limits in nautical miles.
# 'all' zone uses the existing gps_quality_hours table (no filtering).
# Distance zones use gps_quality_zone_hours and count only aircraft whose
# last-known position is within the specified radius from the airport.
ZONE_LIMITS_NM: dict[str, float] = {
    "50nm": 50.0,
    "20nm": 20.0,
}
# Maximum age of a last-known position to be used for zone assignment when
# the current position is absent (Position Gap events).  2 minutes is enough
# for an aircraft on final approach to remain within the zone boundary.
LAST_POS_MAX_AGE_SEC = 120.0

# ── ADS-B loss detection ──────────────────────────────────────────────────────
# Fires when the aircraft still has a visible position (kept alive by MLAT) but
# its own Beast-feed ADS-B GPS position timestamp has not been updated for
# ≥ gap_sec seconds.  The timestamp is maintained by receiver.py whenever a
# TC=9-18/20-22 airborne-position message arrives in the Beast feed.
# No debounce counter is needed — the gap_sec time threshold is sufficient.


def _haversine_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Return the great-circle distance in nautical miles between two points."""
    R_NM = 3_440.065   # Earth mean radius in nautical miles
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return R_NM * 2 * math.asin(math.sqrt(a))


def _fl_band(altitude_ft: float | None) -> str | None:
    """Return the FL band label for a pressure altitude, or None if unknown."""
    if altitude_ft is None:
        return None
    for lo, hi, label in FL_BANDS:
        if lo <= altitude_ft < hi:
            return label
    return FL_BAND_LABELS[-1]   # ≥ FL300


def _empty_bucket(ts: float) -> dict:
    """Return a zeroed hourly bucket starting at timestamp ts."""
    return {
        "ts":            int(ts),
        "total":         0,                        # unique aircraft seen this hour
        "degraded":      0,                        # aircraft with ≥1 event this hour
        "events":        0,                        # total event count this hour
        "nacp_events":      0,   # events from NACp signal
        "nic_events":       0,   # events from NIC (integrity) signal
        "freeze_events":    0,   # events from Freeze signal
        "gap_events":       0,   # events from Gap signal
        "adsb_loss_events": 0,   # events from ADS-B loss (MLAT covering GPS dropout)
        "fl_bands": {lbl: 0 for lbl in FL_BAND_LABELS},   # events per FL band
        "method":  METHOD_VERSION,                 # counting-method version
        "_seen":   set(),                          # transient: icaos seen this hour
        "_deg":    set(),                          # transient: icaos with event
    }


def _bucket_hour(ts: float) -> float:
    """Truncate timestamp to the start of its UTC hour."""
    return math.floor(ts / BUCKET_SEC) * BUCKET_SEC


# ── GpsQualityTracker ─────────────────────────────────────────────────────────

class GpsQualityTracker:
    """
    Thread-safe in-RAM GPS quality monitor.

    Instantiated once in run.py.  The background sweep thread calls
    update(ac) for every live aircraft then prune_stale() to drop
    aircraft not seen recently.  Flask reads get_state() for the API.
    """

    def __init__(
        self,
        nacp_threshold: int   = 6,
        nic_threshold:  int   = 6,
        freeze_polls:   int   = 3,
        gap_sec:        float = 45.0,
        min_gs_kt:      float = 50.0,
        min_alt_ft:     float = 500.0,
        db_path:        str   = "",
        airport_lat:    float | None = None,
        airport_lon:    float | None = None,
    ):
        self.nacp_threshold = nacp_threshold
        self.nic_threshold  = nic_threshold
        self.freeze_polls   = freeze_polls
        self.gap_sec        = gap_sec
        self.min_gs_kt      = min_gs_kt
        self.min_alt_ft     = min_alt_ft
        self._db_path       = db_path
        self._airport_lat   = airport_lat
        self._airport_lon   = airport_lon

        # Per-aircraft tracking state
        # icao → {last_lat, last_lon, last_pos_ts, freeze_count, last_seen}
        self._ac_state: dict[str, dict] = {}

        # Live degraded aircraft (rebuilt every sweep)
        self._live_events: list[dict] = []

        # Rolling hourly buckets for 'all' zone — oldest first
        self._buckets: deque = deque(maxlen=MAX_BUCKETS)

        # Rolling hourly buckets for each distance zone
        self._zone_buckets: dict[str, deque] = {
            zone: deque(maxlen=MAX_BUCKETS) for zone in ZONE_LIMITS_NM
        }

        self._lock = threading.RLock()
        self._last_checkpoint = 0.0

        # Restore history from DB (completed hours only), plus the hour that
        # was in progress when the process last stopped (checkpoint).
        if db_path:
            current_ckpt = self._flush_old_checkpoints()
            self._load_from_db()
            self._load_zones_from_db()
            self._restore_current_hour(current_ckpt)

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _current_bucket(self) -> dict:
        """Return the bucket for the current hour, creating it if needed.

        When the hour rolls over, the previous bucket is complete: flush it
        to the DB before opening the new one.  Flush is called without the
        lock so it doesn't block the sweep thread while waiting for disk I/O.
        """
        now_hour = _bucket_hour(time.time())
        if not self._buckets or self._buckets[-1]["ts"] < now_hour:
            # Capture and persist the completed bucket before replacing it
            if self._buckets and self._db_path:
                completed = self._buckets[-1]
                flush_copy = {
                    "ts":               completed["ts"],
                    "events":           completed["events"],
                    "total":            completed["total"],
                    "degraded":         completed["degraded"],
                    "fl_bands":         dict(completed["fl_bands"]),
                    "nacp_events":      completed.get("nacp_events",      0),
                    "nic_events":       completed.get("nic_events",       0),
                    "freeze_events":    completed.get("freeze_events",    0),
                    "gap_events":       completed.get("gap_events",       0),
                    "adsb_loss_events": completed.get("adsb_loss_events", 0),
                    "method":           completed.get("method", METHOD_VERSION),
                }
                self._flush_to_db(flush_copy)
            self._buckets.append(_empty_bucket(now_hour))
        return self._buckets[-1]

    def _current_zone_bucket(self, zone: str) -> dict:
        """Return the current hourly bucket for a distance zone, flushing on rollover."""
        now_hour = _bucket_hour(time.time())
        zb = self._zone_buckets[zone]
        if not zb or zb[-1]["ts"] < now_hour:
            if zb and self._db_path:
                completed = zb[-1]
                flush_copy = {
                    "ts":               completed["ts"],
                    "events":           completed["events"],
                    "total":            completed["total"],
                    "degraded":         completed["degraded"],
                    "fl_bands":         dict(completed["fl_bands"]),
                    "nacp_events":      completed.get("nacp_events",      0),
                    "nic_events":       completed.get("nic_events",       0),
                    "freeze_events":    completed.get("freeze_events",    0),
                    "gap_events":       completed.get("gap_events",       0),
                    "adsb_loss_events": completed.get("adsb_loss_events", 0),
                    "method":           completed.get("method", METHOD_VERSION),
                }
                self._flush_zone_to_db(flush_copy, zone)
            zb.append(_empty_bucket(now_hour))
        return zb[-1]

    @staticmethod
    def _write_event_to_bucket(bucket: dict, icao: str,
                               altitude: float | None, flags: list[str]) -> None:
        """Increment event counters in an arbitrary bucket dict."""
        bucket["events"] += 1
        bucket["_deg"].add(icao)
        bucket["degraded"] = len(bucket["_deg"])
        if "nacp"      in flags: bucket["nacp_events"]      += 1
        if "nic"       in flags: bucket["nic_events"]       += 1
        if "freeze"    in flags: bucket["freeze_events"]    += 1
        if "gap"       in flags: bucket["gap_events"]       += 1
        if "adsb_loss" in flags: bucket["adsb_loss_events"] += 1
        fl = _fl_band(altitude)
        if fl:
            bucket["fl_bands"][fl] = bucket["fl_bands"].get(fl, 0) + 1

    def _record_event(self, icao: str, altitude: float | None,
                      flags: list[str], zones: list[str]) -> None:
        """Increment event counters in the 'all' bucket and any qualifying zone buckets."""
        self._write_event_to_bucket(self._current_bucket(), icao, altitude, flags)
        for zone in zones:
            self._write_event_to_bucket(
                self._current_zone_bucket(zone), icao, altitude, flags)

    def _record_seen(self, icao: str, zones: list[str]) -> None:
        """Mark an aircraft as seen in the 'all' bucket and any qualifying zone buckets."""
        bucket = self._current_bucket()
        bucket["_seen"].add(icao)
        bucket["total"] = len(bucket["_seen"])
        for zone in zones:
            zb = self._current_zone_bucket(zone)
            zb["_seen"].add(icao)
            zb["total"] = len(zb["_seen"])

    # ── Database persistence ──────────────────────────────────────────────────

    def _flush_to_db(self, bucket: dict) -> None:
        """
        Write one completed hourly bucket to gps_quality_hours.
        Uses INSERT OR REPLACE so repeated flushes of the same ts are safe.
        Called without the lock held (bucket is a completed, immutable row).
        """
        try:
            fl_json = json.dumps(bucket["fl_bands"])
            conn = get_db()
            conn.execute(
                """INSERT OR REPLACE INTO gps_quality_hours
                   (ts, events, total, degraded, fl_bands,
                    nacp_events, freeze_events, gap_events, adsb_loss_events, method, nic_events)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (bucket["ts"], bucket["events"], bucket["total"],
                 bucket["degraded"], fl_json,
                 bucket.get("nacp_events",      0),
                 bucket.get("freeze_events",    0),
                 bucket.get("gap_events",       0),
                 bucket.get("adsb_loss_events", 0),
                 bucket.get("method", METHOD_VERSION),
                 bucket.get("nic_events", 0)),
            )
            conn.commit()
            log.debug("GPS quality: persisted bucket ts=%d events=%d",
                      bucket["ts"], bucket["events"])
        except Exception as exc:
            log.warning("GPS quality: failed to persist bucket ts=%s: %s",
                        bucket.get("ts"), exc)

    def _flush_zone_to_db(self, bucket: dict, zone: str) -> None:
        """Write one completed zone hourly bucket to gps_quality_zone_hours."""
        try:
            fl_json = json.dumps(bucket["fl_bands"])
            conn = get_db()
            conn.execute(
                """INSERT OR REPLACE INTO gps_quality_zone_hours
                   (ts, zone, events, total, degraded, fl_bands,
                    nacp_events, freeze_events, gap_events, adsb_loss_events, method, nic_events)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (bucket["ts"], zone, bucket["events"], bucket["total"],
                 bucket["degraded"], fl_json,
                 bucket.get("nacp_events",      0),
                 bucket.get("freeze_events",    0),
                 bucket.get("gap_events",       0),
                 bucket.get("adsb_loss_events", 0),
                 bucket.get("method", METHOD_VERSION),
                 bucket.get("nic_events", 0)),
            )
            conn.commit()
            log.debug("GPS quality: persisted zone=%s bucket ts=%d events=%d",
                      zone, bucket["ts"], bucket["events"])
        except Exception as exc:
            log.warning("GPS quality: failed to persist zone=%s bucket ts=%s: %s",
                        zone, bucket.get("ts"), exc)

    def _load_from_db(self) -> None:
        """
        Reload historical hourly buckets from the DB at startup.
        Loads completed hours only (ts < current hour start).
        Populates _buckets so charts and heatmap are immediately available.
        """
        try:
            now_hour = _bucket_hour(time.time())
            cutoff   = now_hour - (MAX_BUCKETS - 1) * BUCKET_SEC
            conn     = get_db()
            rows     = conn.execute(
                """SELECT ts, events, total, degraded, fl_bands,
                          nacp_events, freeze_events, gap_events, adsb_loss_events, method, nic_events
                   FROM gps_quality_hours
                   WHERE ts >= ? AND ts < ?
                   ORDER BY ts ASC""",
                (int(cutoff), int(now_hour)),
            ).fetchall()
            for row in rows:
                fl   = json.loads(row["fl_bands"] or "{}")
                b    = _empty_bucket(row["ts"])
                b["events"]           = row["events"]
                b["total"]            = row["total"]
                b["degraded"]         = row["degraded"]
                b["fl_bands"]         = {lbl: fl.get(lbl, 0) for lbl in FL_BAND_LABELS}
                b["nacp_events"]      = row["nacp_events"]        or 0
                b["freeze_events"]    = row["freeze_events"]      or 0
                b["gap_events"]       = row["gap_events"]         or 0
                b["adsb_loss_events"] = row["adsb_loss_events"]   or 0
                b["method"]           = row["method"] or 1
                b["nic_events"]       = row["nic_events"] or 0
                self._buckets.append(b)
            log.info("GPS quality: loaded %d historical hour buckets from DB",
                     len(rows))
        except Exception as exc:
            log.warning("GPS quality: failed to load history from DB: %s", exc)

    def _load_zones_from_db(self) -> None:
        """Reload historical zone buckets from gps_quality_zone_hours at startup."""
        try:
            now_hour = _bucket_hour(time.time())
            cutoff   = now_hour - (MAX_BUCKETS - 1) * BUCKET_SEC
            conn     = get_db()
            for zone in ZONE_LIMITS_NM:
                rows = conn.execute(
                    """SELECT ts, events, total, degraded, fl_bands,
                              nacp_events, freeze_events, gap_events, adsb_loss_events, method, nic_events
                       FROM gps_quality_zone_hours
                       WHERE zone = ? AND ts >= ? AND ts < ?
                       ORDER BY ts ASC""",
                    (zone, int(cutoff), int(now_hour)),
                ).fetchall()
                for row in rows:
                    fl = json.loads(row["fl_bands"] or "{}")
                    b  = _empty_bucket(row["ts"])
                    b["events"]           = row["events"]
                    b["total"]            = row["total"]
                    b["degraded"]         = row["degraded"]
                    b["fl_bands"]         = {lbl: fl.get(lbl, 0) for lbl in FL_BAND_LABELS}
                    b["nacp_events"]      = row["nacp_events"]      or 0
                    b["freeze_events"]    = row["freeze_events"]    or 0
                    b["gap_events"]       = row["gap_events"]       or 0
                    b["adsb_loss_events"] = row["adsb_loss_events"] or 0
                    b["method"]           = row["method"] or 1
                    b["nic_events"]       = row["nic_events"] or 0
                    self._zone_buckets[zone].append(b)
                log.info("GPS quality: loaded %d zone=%s buckets from DB", len(rows), zone)
        except Exception as exc:
            log.warning("GPS quality: failed to load zone history from DB: %s", exc)

    def reload_from_db(self) -> None:
        """
        Reload all historical buckets from DB, replacing the in-RAM cache.
        Called after a maintenance purge so the live charts reflect the new
        DB state immediately without requiring a server restart.
        """
        now_hour = _bucket_hour(time.time())
        with self._lock:
            # Keep the in-progress hour (not in the DB yet) across the reload
            keep_all  = [b for b in self._buckets if b["ts"] >= now_hour]
            keep_zone = {z: [b for b in zb if b["ts"] >= now_hour]
                         for z, zb in self._zone_buckets.items()}
            self._buckets.clear()
            for zb in self._zone_buckets.values():
                zb.clear()
        self._load_from_db()
        self._load_zones_from_db()
        with self._lock:
            self._buckets.extend(keep_all)
            for z, bl in keep_zone.items():
                self._zone_buckets[z].extend(bl)
        log.info("GPS quality: in-RAM cache reloaded from DB after maintenance purge")

    # ── Current-hour checkpoint (restart safety) ──────────────────────────────

    @staticmethod
    def _bucket_to_json(b: dict) -> str:
        d = {k: v for k, v in b.items() if not k.startswith("_")}
        d["seen"] = sorted(b.get("_seen", ()))
        d["deg"]  = sorted(b.get("_deg", ()))
        return json.dumps(d)

    @staticmethod
    def _bucket_from_json(txt: str) -> dict:
        d = json.loads(txt)
        b = _empty_bucket(d["ts"])
        for k in ("total", "degraded", "events", "nacp_events", "nic_events", "freeze_events",
                  "gap_events", "adsb_loss_events", "method"):
            if k in d:
                b[k] = d[k]
        fl = d.get("fl_bands", {})
        b["fl_bands"] = {lbl: fl.get(lbl, 0) for lbl in FL_BAND_LABELS}
        b["_seen"] = set(d.get("seen", ()))
        b["_deg"]  = set(d.get("deg", ()))
        return b

    def checkpoint(self, force: bool = False) -> None:
        """Persist the in-progress hour of every zone to gps_quality_live.

        Called from rebuild_live() every sweep; writes at most every
        CHECKPOINT_SEC.  A restart then loses at most CHECKPOINT_SEC of data
        instead of everything counted so far in the current hour.
        """
        if not self._db_path:
            return
        now = time.time()
        if not force and now - self._last_checkpoint < CHECKPOINT_SEC:
            return
        self._last_checkpoint = now
        now_hour = _bucket_hour(now)
        with self._lock:
            rows = []
            if self._buckets and self._buckets[-1]["ts"] >= now_hour:
                rows.append(("all", self._buckets[-1]["ts"], self._bucket_to_json(self._buckets[-1])))
            for zone, zb in self._zone_buckets.items():
                if zb and zb[-1]["ts"] >= now_hour:
                    rows.append((zone, zb[-1]["ts"], self._bucket_to_json(zb[-1])))
        if not rows:
            return
        try:
            conn = get_db()
            conn.executemany(
                "INSERT OR REPLACE INTO gps_quality_live (zone, ts, data) VALUES (?, ?, ?)", rows)
            conn.commit()
        except Exception as exc:
            log.warning("GPS quality: checkpoint failed: %s", exc)

    def _flush_old_checkpoints(self) -> dict:
        """At startup: write checkpoints of hours that already ended to the
        hourly tables (only if that hour has no row yet), and return the
        checkpoints of the current hour as {zone: bucket} for restoring."""
        current: dict[str, dict] = {}
        try:
            now_hour = _bucket_hour(time.time())
            conn = get_db()
            for row in conn.execute("SELECT zone, ts, data FROM gps_quality_live").fetchall():
                b = self._bucket_from_json(row["data"])
                if row["ts"] >= now_hour:
                    current[row["zone"]] = b
                    continue
                if row["zone"] == "all":
                    exists = conn.execute("SELECT 1 FROM gps_quality_hours WHERE ts = ?",
                                          (row["ts"],)).fetchone()
                    if not exists:
                        self._flush_to_db(b)
                        log.info("GPS quality: saved interrupted hour %d from checkpoint", row["ts"])
                else:
                    exists = conn.execute("SELECT 1 FROM gps_quality_zone_hours WHERE ts = ? AND zone = ?",
                                          (row["ts"], row["zone"])).fetchone()
                    if not exists:
                        self._flush_zone_to_db(b, row["zone"])
        except Exception as exc:
            log.warning("GPS quality: reading checkpoints failed: %s", exc)
        return current

    def _restore_current_hour(self, current: dict) -> None:
        """Continue counting the hour that was in progress at shutdown."""
        if not current:
            return
        with self._lock:
            if "all" in current and (not self._buckets or self._buckets[-1]["ts"] < current["all"]["ts"]):
                self._buckets.append(current["all"])
            for zone, zb in self._zone_buckets.items():
                b = current.get(zone)
                if b is not None and (not zb or zb[-1]["ts"] < b["ts"]):
                    zb.append(b)
        log.info("GPS quality: resumed current hour from checkpoint (%s)", ", ".join(sorted(current)))

    # ── Signal helpers ────────────────────────────────────────────────────────

    def _signals(self, ac: dict, prev: dict, now: float) -> tuple[list[str], dict]:
        """Evaluate the GPS degradation signals for one aircraft (METHOD_VERSION 4).

        Returns (flags, per-aircraft state to keep for the next sweep).
        All signals rely on data received by our own receiver:

          nacp      — NACp ≤ threshold, from a status message (TC 29, or TC 31
                      with ADS-B version ≥ 1) received within QUALITY_FRESH_SEC
          nic       — NIC ≤ threshold (containment radius Rc too large), from an
                      airborne-position type code received within QUALITY_FRESH_SEC
          freeze    — own ADS-B positions keep arriving (latest within
                      FREEZE_POS_SEC) but the coordinates have not changed for
                      ≥ freeze_polls consecutive sweeps while groundspeed ≥ min
          adsb_loss — ADS-B active (DF17 within ES_ACTIVE_SEC), no own position
                      for ≥ gap_sec in this visit, but the position keeps
                      updating from another source (MLAT)
          gap       — ADS-B active, no position update from ANY source for
                      ≥ gap_sec in this visit
        adsb_loss and gap are mutually exclusive; freeze excludes both.
        """
        flags: list[str] = []
        gs = ac.get("groundspeed")

        # Self-reported quality (fresh values only)
        nacp, nacp_ts = ac.get("nac_p"), ac.get("nac_p_ts")
        if nacp is not None and nacp_ts is not None and now - nacp_ts <= QUALITY_FRESH_SEC \
                and nacp <= self.nacp_threshold:
            flags.append("nacp")
        nic, nic_ts = ac.get("nic"), ac.get("nic_ts")
        if nic is not None and nic_ts is not None and now - nic_ts <= QUALITY_FRESH_SEC \
                and nic <= self.nic_threshold:
            flags.append("nic")

        # Freeze: own ADS-B positions arriving with identical coordinates
        a_lat, a_lon, a_ts = ac.get("adsb_lat"), ac.get("adsb_lon"), ac.get("last_adsb_pos_ts")
        own_pos_fresh = a_ts is not None and now - a_ts <= FREEZE_POS_SEC
        freeze_count = 0
        if own_pos_fresh and gs is not None and gs >= self.min_gs_kt:
            if (a_lat, a_lon) == (prev.get("adsb_lat"), prev.get("adsb_lon")):
                freeze_count = prev.get("freeze_count", 0) + 1
            if freeze_count >= self.freeze_polls:
                flags.append("freeze")

        # ADS-B loss / Gap (per visit, aircraft must be transmitting ES now)
        last_es = ac.get("last_es_ts")
        if last_es is not None and now - last_es <= ES_ACTIVE_SEC and not own_pos_fresh:
            first_seen = ac.get("first_seen")
            own_ref = a_ts if a_ts is not None else first_seen
            if own_ref is not None and now - own_ref >= self.gap_sec:
                any_ref = ac.get("last_pos_update_ts") or first_seen
                if any_ref is not None and now - any_ref >= self.gap_sec:
                    flags.append("gap")          # no position from any source
                else:
                    flags.append("adsb_loss")    # MLAT still updating the position

        state = {
            "adsb_lat":     a_lat,
            "adsb_lon":     a_lon,
            "freeze_count": freeze_count,
            "last_seen":    ac.get("last_seen", now),
            "flags":        flags,
            "flags_ts":     now,
        }
        return flags, state

    def update(self, ac: dict) -> None:
        """
        Process one aircraft from the live_state snapshot.
        Called by the sweep thread for every aircraft seen in the last 60 s.
        Only aircraft heard by our own receiver within HEARD_SEC are counted
        (METHOD_VERSION 4) — aircraft kept alive solely by the Radarcape JSON
        list (MLAT network beyond our antenna's range) are ignored.
        """
        icao = ac.get("icao", "")
        if not icao:
            return
        now = time.time()
        last_rx = ac.get("last_rx_ts")
        if last_rx is None or now - last_rx > HEARD_SEC:
            return
        alt = ac.get("altitude")

        with self._lock:
            prev = self._ac_state.get(icao, {})

            # ── Zone membership ─────────────────────────────────────────
            # Uses the current position only while it is being updated
            # (any source); a position that stopped updating more than
            # LAST_POS_MAX_AGE_SEC ago no longer places the aircraft in a zone.
            active_zones: list[str] = []
            lat, lon = ac.get("lat"), ac.get("lon")
            pos_ts = ac.get("last_pos_update_ts") or ac.get("first_seen") or 0
            if (self._airport_lat is not None and lat is not None and lon is not None
                    and now - pos_ts <= LAST_POS_MAX_AGE_SEC):
                dist_nm = _haversine_nm(self._airport_lat, self._airport_lon, lat, lon)
                for zone, limit in ZONE_LIMITS_NM.items():
                    if dist_nm <= limit:
                        active_zones.append(zone)

            self._record_seen(icao, active_zones)

            # Skip degradation signal checks below the minimum altitude gate
            # (landing aircraft that the receiver loses at a few hundred ft).
            if alt is not None and alt < self.min_alt_ft:
                self._ac_state.pop(icao, None)
                return

            flags, state = self._signals(ac, prev, now)
            self._ac_state[icao] = state
            if flags:
                self._record_event(icao, alt, flags, active_zones)

    def prune_stale(self, max_age_sec: float = 90.0) -> None:
        """Remove aircraft not updated for max_age_sec seconds."""
        now    = time.time()
        cutoff = now - max_age_sec
        with self._lock:
            stale = [icao for icao, s in self._ac_state.items()
                     if s.get("last_seen", 0) < cutoff]
            for icao in stale:
                del self._ac_state[icao]

    def rebuild_live(self, live_state_snapshot: list[dict]) -> None:
        """
        Rebuild the live degraded-aircraft list from the current sweep, using
        the flags computed by update() in this sweep (no second evaluation).
        Called once per sweep after all update() calls are done.
        """
        now  = time.time()
        live = []
        with self._lock:
            for ac in live_state_snapshot:
                icao = ac.get("icao", "")
                st   = self._ac_state.get(icao)
                if not icao or not st or now - st.get("flags_ts", 0) > 10 or not st.get("flags"):
                    continue
                alt = ac.get("altitude")
                live.append({
                    "icao":        icao,
                    "callsign":    ac.get("callsign") or icao,
                    "altitude":    alt,
                    "fl_band":     _fl_band(alt),
                    "groundspeed": ac.get("groundspeed"),
                    "nac_p":       ac.get("nac_p"),
                    "nic":         ac.get("nic"),
                    "nic_rc_m":    ac.get("nic_rc_m"),
                    "nac_v":       ac.get("nac_v"),
                    "flags":       list(st["flags"]),
                    "last_seen":   ac.get("last_seen", now),
                })

            # Sort by altitude descending (highest first)
            live.sort(key=lambda x: x.get("altitude") or 0, reverse=True)
            self._live_events = live

        # Persist the in-progress hour periodically (restart safety)
        self.checkpoint()

    def get_state(self, zone: str = "all") -> dict:
        """
        Return a JSON-serialisable snapshot for the API endpoint.

        Args:
          zone: 'all' (default) uses the main bucket set; '50nm' or '20nm'
                uses the corresponding distance-filtered zone bucket set.

        Returns:
          live        — aircraft currently showing degraded GPS (list)
          time_series — hourly buckets for the requested zone (oldest first,
                        up to MAX_BUCKETS = 6 months, for the range selector)
          heatmap     — most recent buckets for the zone (up to
                        HEATMAP_MAX_BUCKETS = 31 days); capped independently
                        of time_series since the heatmap canvas only ever
                        renders the last 14 days regardless of how much is sent
          fl_bands    — ordered list of FL band label strings
          stats       — summary counts for the last 24 hours
          zone        — the active zone name (echoed back to the frontend)
        """
        with self._lock:
            if zone in self._zone_buckets:
                buckets = list(self._zone_buckets[zone])
            else:
                buckets = list(self._buckets)

        # Strip internal sets before serialising; freeze into plain counts
        def _clean(b: dict) -> dict:
            return {
                "ts":               b["ts"],
                "total":            b["total"],
                "degraded":         b["degraded"],
                "events":           b["events"],
                "nacp_events":      b.get("nacp_events",      0),
                "nic_events":       b.get("nic_events",       0),
                "freeze_events":    b.get("freeze_events",    0),
                "gap_events":       b.get("gap_events",       0),
                "adsb_loss_events": b.get("adsb_loss_events", 0),
                "fl_bands":         dict(b["fl_bands"]),
                "method":           b.get("method", 1),
            }

        cleaned = [_clean(b) for b in buckets]

        # Heatmap only ever displays the most recent 14 days client-side, so
        # cap its payload independently rather than sending up to 6 months
        # of buckets on every 30-second poll.
        heatmap_cleaned = cleaned[-HEATMAP_MAX_BUCKETS:]

        # Last 24 hours for stats
        now_hour = _bucket_hour(time.time())
        ts_24h   = [b for b in cleaned
                    if b["ts"] >= now_hour - (23 * BUCKET_SEC)]

        # Stats over last 24 h
        events_24h   = sum(b["events"]   for b in ts_24h)
        degraded_24h = sum(b["degraded"] for b in ts_24h)
        peak_hour    = None
        if ts_24h:
            peak = max(ts_24h, key=lambda b: b["events"])
            if peak["events"] > 0:
                import datetime
                peak_hour = datetime.datetime.utcfromtimestamp(
                    peak["ts"]
                ).strftime("%H:00 UTC")

        return {
            "live":        self._live_events,
            "time_series": cleaned,
            "heatmap":     heatmap_cleaned,
            "fl_bands":    FL_BAND_LABELS,
            "zone":        zone,
            "stats": {
                "events_24h":   events_24h,
                "degraded_24h": degraded_24h,
                "peak_hour":    peak_hour,
            },
        }
