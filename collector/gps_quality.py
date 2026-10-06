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

Per-band detail (since 2026-10-06)
----------------------------------
Each hourly row also stores ``band_detail`` (JSON): distinct aircraft seen
per FL band (``ac``), distinct degraded aircraft per band (``deg``) and the
signal mix per band (``sig``).  Older rows have NULL.

Degradation episode log (since 2026-10-06)
------------------------------------------
One ``gps_episodes`` row per aircraft per continuous degraded period
(clean gaps shorter than EPISODE_MERGE_SEC are merged), for aircraft within
episode_radius_nm (default 100 NM) of the airport when the episode starts.
Start / end / recovery snapshots (position, altitude, track, vertical rate,
groundspeed, distance), altitude range, lowest NACp / NIC, signals seen and
how the episode ended.  Closed episodes are buffered in RAM and written in
the same transaction as the 60-s current-hour checkpoint, so each row is
written once and no extra commits are needed.  The episodes still open are
saved in the same checkpoint (gps_quality_live row "_episodes"); after a
restart within EPISODE_RESTORE_MAX_SEC they continue, after a longer stop
they are written with end_reason "shutdown".  Never auto-purged; manual
purge on the Maintenance page.

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

# ── Degradation episode log ───────────────────────────────────────────────────
SIG_ORDER          = ("nacp", "nic", "freeze", "gap", "adsb_loss")
EPISODE_MERGE_SEC  = 120.0   # a clean period shorter than this does not end an episode
EPISODE_RADIUS_NM  = 100.0
EPISODE_BUF_MAX    = 20_000   # closed episodes kept for retry while the DB is unwritable
EPISODE_LIVE_KEY   = "_episodes"  # gps_quality_live row holding the open episodes
EPISODE_RESTORE_MAX_SEC = 600.0   # after a restart within this time, open episodes continue;
                                  # after a longer stop they are saved with end_reason "shutdown"   # default: episodes start only within this distance of the airport

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


def _seen_band(altitude_ft: float | None) -> str | None:
    """FL band for the per-band aircraft count; None below the lowest band."""
    if altitude_ft is None or altitude_ft < FL_BANDS[0][0]:
        return None
    return _fl_band(altitude_ft)


def _band_detail(b: dict) -> dict:
    """Per-band detail for one bucket: distinct aircraft seen / degraded and
    the signal mix per FL band (non-zero entries only)."""
    seen = b.get("_band_seen", {})
    deg  = b.get("_band_deg", {})
    sig  = b.get("band_sig", {})
    return {
        "ac":  {lbl: len(v) for lbl, v in seen.items() if v},
        "deg": {lbl: len(v) for lbl, v in deg.items() if v},
        "sig": {lbl: {k: n for k, n in d.items() if n}
                for lbl, d in sig.items() if any(d.values())},
    }


_TRANSIENT_KEYS = ("_seen", "_deg", "_band_seen", "_band_deg")


def _freeze_bucket(b: dict, detail: dict | None = None) -> None:
    """Turn a completed hour into a compact record (memory).

    Keeps the counts, stores the per-band detail as plain numbers and drops
    the per-aircraft sets and per-band signal dicts — they are only needed
    while the hour is being counted.  Completed buckets are kept in RAM for
    up to MAX_BUCKETS (6 months × 3 zones), so the sets would otherwise add
    up to a large amount of memory over a long uptime.
    """
    if detail is not None:
        b["band_detail"] = detail
    for k in _TRANSIENT_KEYS:
        b.pop(k, None)
    b.pop("band_sig", None)


def _load_detail(txt: str | None, ts: float, now_hour: float) -> dict | None:
    """band_detail JSON of a stored hour, only within the heatmap window."""
    if not txt or ts < now_hour - HEATMAP_MAX_BUCKETS * BUCKET_SEC:
        return None
    try:
        return json.loads(txt)
    except (TypeError, ValueError):
        return None


def _prune_band_detail(buckets: list, cutoff_ts: float) -> None:
    """Drop band_detail from buckets older than cutoff_ts (only the heatmap
    window uses it).  Buckets are in time order; stop at the first newer one."""
    for b in buckets:
        if b["ts"] >= cutoff_ts:
            break
        b.pop("band_detail", None)


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
        # per-band signal counts {band: {signal: n}}
        "band_sig": {lbl: {s: 0 for s in SIG_ORDER} for lbl in FL_BAND_LABELS},
        "_seen":   set(),                          # transient: icaos seen this hour
        "_deg":    set(),                          # transient: icaos with event
        "_band_seen": {lbl: set() for lbl in FL_BAND_LABELS},   # transient: icaos per band
        "_band_deg":  {lbl: set() for lbl in FL_BAND_LABELS},   # transient: degraded icaos per band
    }


def _bucket_hour(ts: float) -> float:
    """Truncate timestamp to the start of its UTC hour."""
    return math.floor(ts / BUCKET_SEC) * BUCKET_SEC


_EPISODE_INSERT_SQL = """INSERT OR IGNORE INTO gps_episodes
    (icao, callsign, registration, aircraft_type, t_start, t_end, duration_s, sweeps,
     signals, min_nacp, min_nic, min_alt, max_alt,
     start_lat, start_lon, start_alt, start_track, start_vrate, start_gs, start_dist_nm,
     end_lat, end_lon, end_alt, end_track, end_vrate, end_gs, end_dist_nm, end_pos_age,
     rec_lat, rec_lon, rec_alt, rec_dist_nm, end_reason, method)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"""


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
        episode_radius_nm: float = EPISODE_RADIUS_NM,
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
        self.episode_radius_nm = episode_radius_nm

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

        # Degradation episode log: open episodes per aircraft, and closed
        # episodes waiting to be written with the next checkpoint
        self._episodes:   dict[str, dict] = {}
        self._episode_buf: list[tuple]    = []

        self._lock = threading.RLock()
        self._last_checkpoint = 0.0

        # Restore history from DB (completed hours only), plus the hour that
        # was in progress when the process last stopped (checkpoint).
        if db_path:
            current_ckpt = self._flush_old_checkpoints()
            self._load_from_db()
            self._load_zones_from_db()
            self._restore_current_hour(current_ckpt)
            self._restore_episodes()

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
                    "band_detail":      _band_detail(completed),
                }
                self._flush_to_db(flush_copy)
            if self._buckets:
                _freeze_bucket(self._buckets[-1], _band_detail(self._buckets[-1]))
                _prune_band_detail(self._buckets, now_hour - HEATMAP_MAX_BUCKETS * BUCKET_SEC)
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
                    "band_detail":      _band_detail(completed),
                }
                self._flush_zone_to_db(flush_copy, zone)
            if zb:
                _freeze_bucket(zb[-1], _band_detail(zb[-1]))
                _prune_band_detail(zb, now_hour - HEATMAP_MAX_BUCKETS * BUCKET_SEC)
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
            bucket.setdefault("_band_deg", {}).setdefault(fl, set()).add(icao)
            sig = bucket.setdefault("band_sig", {}).setdefault(fl, {s: 0 for s in SIG_ORDER})
            for f in flags:
                if f in sig:
                    sig[f] += 1

    def _record_event(self, icao: str, altitude: float | None,
                      flags: list[str], zones: list[str]) -> None:
        """Increment event counters in the 'all' bucket and any qualifying zone buckets."""
        self._write_event_to_bucket(self._current_bucket(), icao, altitude, flags)
        for zone in zones:
            self._write_event_to_bucket(
                self._current_zone_bucket(zone), icao, altitude, flags)

    def _record_seen(self, icao: str, zones: list[str],
                     altitude: float | None = None) -> None:
        """Mark an aircraft as seen in the 'all' bucket and any qualifying zone
        buckets, and in the FL band of its current altitude."""
        band = _seen_band(altitude)
        bucket = self._current_bucket()
        bucket["_seen"].add(icao)
        bucket["total"] = len(bucket["_seen"])
        if band:
            bucket.setdefault("_band_seen", {}).setdefault(band, set()).add(icao)
        for zone in zones:
            zb = self._current_zone_bucket(zone)
            zb["_seen"].add(icao)
            zb["total"] = len(zb["_seen"])
            if band:
                zb.setdefault("_band_seen", {}).setdefault(band, set()).add(icao)

    # ── Database persistence ──────────────────────────────────────────────────

    def _flush_to_db(self, bucket: dict) -> None:
        """
        Write one completed hourly bucket to gps_quality_hours.
        Uses INSERT OR REPLACE so repeated flushes of the same ts are safe.
        Called without the lock held (bucket is a completed, immutable row).
        """
        try:
            fl_json = json.dumps(bucket["fl_bands"])
            detail  = bucket.get("band_detail") or _band_detail(bucket)
            conn = get_db()
            conn.execute(
                """INSERT OR REPLACE INTO gps_quality_hours
                   (ts, events, total, degraded, fl_bands,
                    nacp_events, freeze_events, gap_events, adsb_loss_events, method, nic_events,
                    band_detail)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (bucket["ts"], bucket["events"], bucket["total"],
                 bucket["degraded"], fl_json,
                 bucket.get("nacp_events",      0),
                 bucket.get("freeze_events",    0),
                 bucket.get("gap_events",       0),
                 bucket.get("adsb_loss_events", 0),
                 bucket.get("method", METHOD_VERSION),
                 bucket.get("nic_events", 0),
                 json.dumps(detail, separators=(",", ":"))),
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
            detail  = bucket.get("band_detail") or _band_detail(bucket)
            conn = get_db()
            conn.execute(
                """INSERT OR REPLACE INTO gps_quality_zone_hours
                   (ts, zone, events, total, degraded, fl_bands,
                    nacp_events, freeze_events, gap_events, adsb_loss_events, method, nic_events,
                    band_detail)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (bucket["ts"], zone, bucket["events"], bucket["total"],
                 bucket["degraded"], fl_json,
                 bucket.get("nacp_events",      0),
                 bucket.get("freeze_events",    0),
                 bucket.get("gap_events",       0),
                 bucket.get("adsb_loss_events", 0),
                 bucket.get("method", METHOD_VERSION),
                 bucket.get("nic_events", 0),
                 json.dumps(detail, separators=(",", ":"))),
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
                          nacp_events, freeze_events, gap_events, adsb_loss_events, method, nic_events,
                          band_detail
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
                _freeze_bucket(b, _load_detail(row["band_detail"], row["ts"], now_hour))
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
                              nacp_events, freeze_events, gap_events, adsb_loss_events, method, nic_events,
                              band_detail
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
                    _freeze_bucket(b, _load_detail(row["band_detail"], row["ts"], now_hour))
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
        d["band_seen"] = {lbl: sorted(v) for lbl, v in b.get("_band_seen", {}).items() if v}
        d["band_deg"]  = {lbl: sorted(v) for lbl, v in b.get("_band_deg", {}).items() if v}
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
        for lbl, v in d.get("band_seen", {}).items():
            b["_band_seen"].setdefault(lbl, set()).update(v)
        for lbl, v in d.get("band_deg", {}).items():
            b["_band_deg"].setdefault(lbl, set()).update(v)
        for lbl, sig in d.get("band_sig", {}).items():
            tgt = b["band_sig"].setdefault(lbl, {s: 0 for s in SIG_ORDER})
            for k, n in sig.items():
                tgt[k] = n
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
            # Open episodes, so that a restart continues them instead of
            # losing their first part (always written, also when empty)
            rows.append((EPISODE_LIVE_KEY, int(now), json.dumps({
                "saved":    now,
                "episodes": {icao: {**ep, "sig": sorted(ep["sig"])}
                             for icao, ep in self._episodes.items()},
            })))
            episodes = self._episode_buf
            self._episode_buf = []
        if not rows and not episodes:
            return
        try:
            conn = get_db()
            if rows:
                conn.executemany(
                    "INSERT OR REPLACE INTO gps_quality_live (zone, ts, data) VALUES (?, ?, ?)", rows)
            if episodes:
                conn.executemany(_EPISODE_INSERT_SQL, episodes)
            conn.commit()
        except Exception as exc:
            log.warning("GPS quality: checkpoint failed: %s", exc)
            if episodes:
                with self._lock:   # keep the closed episodes for the next attempt
                    self._episode_buf[:0] = episodes
                    # bound memory if the DB stays unwritable for a long time
                    if len(self._episode_buf) > EPISODE_BUF_MAX:
                        dropped = len(self._episode_buf) - EPISODE_BUF_MAX
                        del self._episode_buf[:dropped]
                        log.warning("GPS quality: %d unsaved episodes dropped", dropped)

    def _flush_old_checkpoints(self) -> dict:
        """At startup: write checkpoints of hours that already ended to the
        hourly tables (only if that hour has no row yet), and return the
        checkpoints of the current hour as {zone: bucket} for restoring."""
        current: dict[str, dict] = {}
        try:
            now_hour = _bucket_hour(time.time())
            conn = get_db()
            for row in conn.execute("SELECT zone, ts, data FROM gps_quality_live").fetchall():
                if row["zone"].startswith("_"):          # open-episode row, see _restore_episodes
                    continue
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

    def _restore_episodes(self) -> None:
        """At startup: take over the episodes that were open at the last
        checkpoint.  After a short stop (≤ EPISODE_RESTORE_MAX_SEC) they
        continue — the next sweeps extend, recover or close them as usual;
        after a longer stop they are saved as ended at their last degraded
        sweep with end_reason "shutdown"."""
        try:
            row = get_db().execute("SELECT data FROM gps_quality_live WHERE zone = ?",
                                   (EPISODE_LIVE_KEY,)).fetchone()
            if not row:
                return
            d = json.loads(row["data"])
        except Exception as exc:
            log.warning("GPS quality: reading open episodes failed: %s", exc)
            return
        now   = time.time()
        fresh = now - float(d.get("saved", 0)) <= EPISODE_RESTORE_MAX_SEC
        n = 0
        with self._lock:
            for icao, ep in (d.get("episodes") or {}).items():
                if not ep.get("sweeps") or "start" not in ep or "last" not in ep:
                    continue
                ep["sig"] = set(ep.get("sig") or ())
                self._episodes[icao] = ep
                n += 1
                if fresh:
                    ep["restored"] = now        # grace period before "lost"
                else:
                    self._close_episode(icao, "shutdown")
        if n:
            log.info("GPS quality: %s %d open episode(s) from checkpoint",
                     "continuing" if fresh else "saved (stop too long)", n)

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
            dist_nm: float | None = None
            lat, lon = ac.get("lat"), ac.get("lon")
            pos_ts = ac.get("last_pos_update_ts") or ac.get("first_seen") or 0
            if (self._airport_lat is not None and lat is not None and lon is not None
                    and now - pos_ts <= LAST_POS_MAX_AGE_SEC):
                dist_nm = _haversine_nm(self._airport_lat, self._airport_lon, lat, lon)
                for zone, limit in ZONE_LIMITS_NM.items():
                    if dist_nm <= limit:
                        active_zones.append(zone)

            self._record_seen(icao, active_zones, alt)

            # Skip degradation signal checks below the minimum altitude gate
            # (landing aircraft that the receiver loses at a few hundred ft).
            if alt is not None and alt < self.min_alt_ft:
                self._ac_state.pop(icao, None)
                if icao in self._episodes:
                    self._episodes[icao]["rec"] = self._snapshot(ac, now, dist_nm, pos_ts)
                    self._close_episode(icao, "below_min_alt")
                return

            flags, state = self._signals(ac, prev, now)
            self._ac_state[icao] = state
            if flags:
                self._record_event(icao, alt, flags, active_zones)
            self._episode_step(icao, ac, flags, now, dist_nm, pos_ts)

    def prune_stale(self, max_age_sec: float = 90.0) -> None:
        """Remove aircraft not updated for max_age_sec seconds."""
        now    = time.time()
        cutoff = now - max_age_sec
        with self._lock:
            stale = [icao for icao, s in self._ac_state.items()
                     if s.get("last_seen", 0) < cutoff]
            for icao in stale:
                del self._ac_state[icao]
            # Open episodes of aircraft no longer heard: contact lost while degraded
            for icao in [i for i, ep in self._episodes.items()
                         if max(ep["t_last"], ep.get("restored", 0.0)) < cutoff
                         and i not in self._ac_state]:
                self._close_episode(icao, "lost")

    # ── Degradation episode log ───────────────────────────────────────────────

    @staticmethod
    def _snapshot(ac: dict, now: float, dist_nm: float | None, pos_ts: float) -> dict:
        """Position / motion snapshot for an episode start, end or recovery."""
        def _r(v, nd=0):
            return None if v is None else round(v, nd) if nd else int(round(v))
        return {
            "t":       now,
            "lat":     _r(ac.get("lat"), 4),
            "lon":     _r(ac.get("lon"), 4),
            "alt":     _r(ac.get("altitude")),
            "trk":     _r(ac.get("track")),
            "vr":      _r(ac.get("vert_rate")),
            "gs":      _r(ac.get("groundspeed")),
            "dist":    _r(dist_nm, 1),
            "pos_age": _r(now - pos_ts) if pos_ts else None,
        }

    def _episode_step(self, icao: str, ac: dict, flags: list[str], now: float,
                      dist_nm: float | None, pos_ts: float) -> None:
        """Open, extend or close this aircraft's degradation episode (lock held)."""
        ep = self._episodes.get(icao)
        if flags:
            if ep is None:
                # Episodes start only within the episode radius (current position)
                if dist_nm is None or dist_nm > self.episode_radius_nm:
                    return
                snap = self._snapshot(ac, now, dist_nm, pos_ts)
                ep = self._episodes[icao] = {
                    "icao": icao, "t_start": now, "start": snap,
                    "min_alt": None, "max_alt": None, "min_nacp": None, "min_nic": None,
                    "sig": set(), "sweeps": 0, "rec": None,
                }
            snap = self._snapshot(ac, now, dist_nm, pos_ts)
            ep["t_last"] = now
            ep["last"]   = snap
            ep["rec"]    = None          # degraded again — no recovery yet
            ep["sweeps"] += 1
            ep["sig"].update(flags)
            ep["callsign"] = ac.get("callsign") or ep.get("callsign")
            ep["type"]     = ac.get("aircraft_type") or ep.get("type")
            ep["reg"]      = ac.get("registration") or ep.get("reg")
            alt = ac.get("altitude")
            if alt is not None:
                ep["min_alt"] = alt if ep["min_alt"] is None else min(ep["min_alt"], alt)
                ep["max_alt"] = alt if ep["max_alt"] is None else max(ep["max_alt"], alt)
            nacp, nacp_ts = ac.get("nac_p"), ac.get("nac_p_ts")
            if nacp is not None and nacp_ts is not None and now - nacp_ts <= QUALITY_FRESH_SEC:
                ep["min_nacp"] = nacp if ep["min_nacp"] is None else min(ep["min_nacp"], nacp)
            nic, nic_ts = ac.get("nic"), ac.get("nic_ts")
            if nic is not None and nic_ts is not None and now - nic_ts <= QUALITY_FRESH_SEC:
                ep["min_nic"] = nic if ep["min_nic"] is None else min(ep["min_nic"], nic)
        elif ep is not None:
            if ep["rec"] is None:        # first clean sweep after the last degraded one
                ep["rec"] = self._snapshot(ac, now, dist_nm, pos_ts)
            if now - ep["t_last"] >= EPISODE_MERGE_SEC:
                self._close_episode(icao, "recovered")

    def _close_episode(self, icao: str, reason: str) -> None:
        """Move an open episode to the write buffer (lock held)."""
        ep = self._episodes.pop(icao, None)
        if ep is None or ep.get("sweeps", 0) == 0:
            return
        st, en, rc = ep["start"], ep["last"], ep.get("rec") or {}
        self._episode_buf.append((
            icao, ep.get("callsign"), ep.get("reg"), ep.get("type"),
            round(ep["t_start"], 1), round(ep["t_last"], 1),
            int(round(ep["t_last"] - ep["t_start"])), ep["sweeps"],
            ",".join(s for s in SIG_ORDER if s in ep["sig"]),
            ep["min_nacp"], ep["min_nic"],
            None if ep["min_alt"] is None else int(ep["min_alt"]),
            None if ep["max_alt"] is None else int(ep["max_alt"]),
            st["lat"], st["lon"], st["alt"], st["trk"], st["vr"], st["gs"], st["dist"],
            en["lat"], en["lon"], en["alt"], en["trk"], en["vr"], en["gs"], en["dist"], en["pos_age"],
            rc.get("lat"), rc.get("lon"), rc.get("alt"), rc.get("dist"),
            reason, METHOD_VERSION,
        ))

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
          band_days   — {day_ts: {band: {ac, deg, sig}}} from band_detail
                        (aircraft-hours seen / degraded and signal events
                        per FL band and UTC day; days before 2026-10-06
                        have no entry)
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

        # Per-day, per-band aircraft counts and signal mix for the heatmap's
        # "% of aircraft degraded" mode and hover text (from band_detail; the
        # hour in progress is computed live).  Distinct aircraft are counted
        # per hour, so the day sums are aircraft-hours.
        band_days: dict = {}
        hm_cutoff = _bucket_hour(time.time()) - (HEATMAP_MAX_BUCKETS - 1) * BUCKET_SEC
        for b in buckets:
            if b["ts"] < hm_cutoff:
                continue
            det = b.get("band_detail")
            if det is None and "_band_seen" in b:
                det = _band_detail(b)
            if not det:
                continue
            day = str(int(b["ts"] // 86400 * 86400))
            dd = band_days.setdefault(day, {})
            for lbl, n in (det.get("ac") or {}).items():
                dd.setdefault(lbl, {"ac": 0, "deg": 0, "sig": {}})["ac"] += n
            for lbl, n in (det.get("deg") or {}).items():
                dd.setdefault(lbl, {"ac": 0, "deg": 0, "sig": {}})["deg"] += n
            for lbl, sig in (det.get("sig") or {}).items():
                tgt = dd.setdefault(lbl, {"ac": 0, "deg": 0, "sig": {}})["sig"]
                for k, n in sig.items():
                    tgt[k] = tgt.get(k, 0) + n

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
            "band_days":   band_days,
            "fl_bands":    FL_BAND_LABELS,
            "zone":        zone,
            "stats": {
                "events_24h":   events_24h,
                "degraded_24h": degraded_24h,
                "peak_hour":    peak_hour,
            },
        }
