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
On startup the tracker reloads the last 7 days from the DB, restoring the
time-series chart and heatmap instantly.  The current (incomplete) hour
lives in RAM only and is lost on an unplanned restart, but that is an
acceptable trade-off (≤ 59 minutes of data).

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
    ( 5_000, 10_000, "050-100"),
    (10_000, 15_000, "100-150"),
    (15_000, 20_000, "150-200"),
    (20_000, 25_000, "200-250"),
    (25_000, 30_000, "250-300"),
    (30_000, 99_999, "300+"),
]
FL_BAND_LABELS = [b[2] for b in FL_BANDS]

# ── Bucket duration ───────────────────────────────────────────────────────────
BUCKET_SEC    = 3_600          # one hour per bucket
MAX_BUCKETS   = 31 * 24        # 31 days rolling

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
        "nacp_events":   0,                        # events from NACp signal
        "freeze_events": 0,                        # events from Freeze signal
        "gap_events":    0,                        # events from Gap signal
        "fl_bands": {lbl: 0 for lbl in FL_BAND_LABELS},   # events per FL band
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
        freeze_polls:   int   = 3,
        gap_sec:        float = 45.0,
        min_gs_kt:      float = 50.0,
        min_alt_ft:     float = 500.0,
        db_path:        str   = "",
        airport_lat:    float | None = None,
        airport_lon:    float | None = None,
    ):
        self.nacp_threshold = nacp_threshold
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

        # Restore history from DB (completed hours only)
        if db_path:
            self._load_from_db()
            self._load_zones_from_db()

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
                    "ts":            completed["ts"],
                    "events":        completed["events"],
                    "total":         completed["total"],
                    "degraded":      completed["degraded"],
                    "fl_bands":      dict(completed["fl_bands"]),
                    "nacp_events":   completed.get("nacp_events",   0),
                    "freeze_events": completed.get("freeze_events", 0),
                    "gap_events":    completed.get("gap_events",    0),
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
                    "ts":            completed["ts"],
                    "events":        completed["events"],
                    "total":         completed["total"],
                    "degraded":      completed["degraded"],
                    "fl_bands":      dict(completed["fl_bands"]),
                    "nacp_events":   completed.get("nacp_events",   0),
                    "freeze_events": completed.get("freeze_events", 0),
                    "gap_events":    completed.get("gap_events",    0),
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
        if "nacp"   in flags: bucket["nacp_events"]   += 1
        if "freeze" in flags: bucket["freeze_events"] += 1
        if "gap"    in flags: bucket["gap_events"]    += 1
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
                    nacp_events, freeze_events, gap_events)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (bucket["ts"], bucket["events"], bucket["total"],
                 bucket["degraded"], fl_json,
                 bucket.get("nacp_events",   0),
                 bucket.get("freeze_events", 0),
                 bucket.get("gap_events",    0)),
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
                    nacp_events, freeze_events, gap_events)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (bucket["ts"], zone, bucket["events"], bucket["total"],
                 bucket["degraded"], fl_json,
                 bucket.get("nacp_events",   0),
                 bucket.get("freeze_events", 0),
                 bucket.get("gap_events",    0)),
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
                          nacp_events, freeze_events, gap_events
                   FROM gps_quality_hours
                   WHERE ts >= ? AND ts < ?
                   ORDER BY ts ASC""",
                (int(cutoff), int(now_hour)),
            ).fetchall()
            for row in rows:
                fl   = json.loads(row["fl_bands"] or "{}")
                b    = _empty_bucket(row["ts"])
                b["events"]        = row["events"]
                b["total"]         = row["total"]
                b["degraded"]      = row["degraded"]
                b["fl_bands"]      = {lbl: fl.get(lbl, 0) for lbl in FL_BAND_LABELS}
                b["nacp_events"]   = row["nacp_events"]   or 0
                b["freeze_events"] = row["freeze_events"] or 0
                b["gap_events"]    = row["gap_events"]    or 0
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
                              nacp_events, freeze_events, gap_events
                       FROM gps_quality_zone_hours
                       WHERE zone = ? AND ts >= ? AND ts < ?
                       ORDER BY ts ASC""",
                    (zone, int(cutoff), int(now_hour)),
                ).fetchall()
                for row in rows:
                    fl = json.loads(row["fl_bands"] or "{}")
                    b  = _empty_bucket(row["ts"])
                    b["events"]        = row["events"]
                    b["total"]         = row["total"]
                    b["degraded"]      = row["degraded"]
                    b["fl_bands"]      = {lbl: fl.get(lbl, 0) for lbl in FL_BAND_LABELS}
                    b["nacp_events"]   = row["nacp_events"]   or 0
                    b["freeze_events"] = row["freeze_events"] or 0
                    b["gap_events"]    = row["gap_events"]    or 0
                    self._zone_buckets[zone].append(b)
                log.info("GPS quality: loaded %d zone=%s buckets from DB", len(rows), zone)
        except Exception as exc:
            log.warning("GPS quality: failed to load zone history from DB: %s", exc)

    # ── Public interface ──────────────────────────────────────────────────────

    def update(self, ac: dict) -> None:
        """
        Process one aircraft from the live_state snapshot.
        Called by the sweep thread for every aircraft seen in the last 60 s.
        """
        icao     = ac.get("icao", "")
        if not icao:
            return

        now      = time.time()
        lat      = ac.get("lat")
        lon      = ac.get("lon")
        alt      = ac.get("altitude")
        gs       = ac.get("groundspeed")
        nacp     = ac.get("nac_p")
        last_seen = ac.get("last_seen", now)

        with self._lock:
            prev = self._ac_state.get(icao, {})

            # ── Zone membership ─────────────────────────────────────────
            # Determine which distance zones this aircraft qualifies for.
            # For Position Gap events (no current position) we fall back to
            # the last-known position if it is recent enough.
            active_zones: list[str] = []
            if self._airport_lat is not None:
                pos_lat = lat if lat is not None else prev.get("last_lat")
                pos_lon = lon if lon is not None else prev.get("last_lon")
                pos_ts  = now if lat is not None else (prev.get("last_pos_ts") or 0)
                if (pos_lat is not None and pos_lon is not None
                        and (now - pos_ts) <= LAST_POS_MAX_AGE_SEC):
                    dist_nm = _haversine_nm(
                        self._airport_lat, self._airport_lon, pos_lat, pos_lon)
                    for zone, limit in ZONE_LIMITS_NM.items():
                        if dist_nm <= limit:
                            active_zones.append(zone)

            self._record_seen(icao, active_zones)

            # Skip degradation signal checks below the minimum altitude gate.
            # Aircraft below ~500 ft are on very short final or have just landed;
            # the receiver loses them at 300–400 ft while their last-known GS is
            # still ~140 kt, which would cause spurious Freeze events.
            if alt is not None and alt < self.min_alt_ft:
                return

            flags: list[str] = []

            # ── Signal 1: NACp degradation ──────────────────────────────
            if nacp is not None and nacp <= self.nacp_threshold:
                flags.append("nacp")

            # ── Signal 2: Position freeze ───────────────────────────────
            # Position is frozen when lat/lon is identical to the last
            # recorded position while the aircraft is clearly moving.
            if (lat is not None and lon is not None
                    and gs is not None and gs >= self.min_gs_kt):
                if (prev.get("last_lat") == lat
                        and prev.get("last_lon") == lon):
                    freeze_count = prev.get("freeze_count", 0) + 1
                else:
                    freeze_count = 0
                if freeze_count >= self.freeze_polls:
                    flags.append("freeze")
            else:
                freeze_count = prev.get("freeze_count", 0)

            # ── Signal 3: Position gap ───────────────────────────────────
            if lat is None:
                last_pos_ts = prev.get("last_pos_ts")
                if last_pos_ts is not None and (now - last_pos_ts) >= self.gap_sec:
                    flags.append("gap")

            # Update per-aircraft state
            new_state = {
                "last_lat":    lat  if lat  is not None else prev.get("last_lat"),
                "last_lon":    lon  if lon  is not None else prev.get("last_lon"),
                "last_pos_ts": now  if lat  is not None else prev.get("last_pos_ts"),
                "freeze_count": freeze_count,
                "last_seen":   last_seen,
            }
            self._ac_state[icao] = new_state

            # Record events in 'all' bucket and any qualifying zone buckets
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
        Rebuild the live degraded-aircraft list from the current sweep.
        Called once per sweep after all update() calls are done.
        """
        now  = time.time()
        live = []
        with self._lock:
            for ac in live_state_snapshot:
                icao  = ac.get("icao", "")
                nacp  = ac.get("nac_p")
                lat   = ac.get("lat")
                lon   = ac.get("lon")
                alt   = ac.get("altitude")
                gs    = ac.get("groundspeed")
                cs    = ac.get("callsign") or icao

                if not icao:
                    continue

                # Same altitude gate as update() — skip signal checks below
                # minimum altitude to avoid false positives from landing aircraft
                # that the receiver has lost line-of-sight with.
                if alt is not None and alt < self.min_alt_ft:
                    continue

                prev  = self._ac_state.get(icao, {})
                flags = []

                if nacp is not None and nacp <= self.nacp_threshold:
                    flags.append("nacp")

                if (lat is not None and lon is not None
                        and gs is not None and gs >= self.min_gs_kt
                        and prev.get("freeze_count", 0) >= self.freeze_polls):
                    flags.append("freeze")

                last_pos_ts = prev.get("last_pos_ts")
                if (lat is None and last_pos_ts is not None
                        and (now - last_pos_ts) >= self.gap_sec):
                    flags.append("gap")

                if flags:
                    live.append({
                        "icao":       icao,
                        "callsign":   cs,
                        "altitude":   alt,
                        "fl_band":    _fl_band(alt),
                        "groundspeed": gs,
                        "nac_p":      nacp,
                        "flags":      flags,
                        "last_seen":  ac.get("last_seen", now),
                    })

            # Sort by altitude descending (highest first)
            live.sort(key=lambda x: x.get("altitude") or 0, reverse=True)
            self._live_events = live

    def get_state(self, zone: str = "all") -> dict:
        """
        Return a JSON-serialisable snapshot for the API endpoint.

        Args:
          zone: 'all' (default) uses the main bucket set; '50nm' or '20nm'
                uses the corresponding distance-filtered zone bucket set.

        Returns:
          live        — aircraft currently showing degraded GPS (list)
          time_series — hourly buckets for the requested zone (oldest first)
          heatmap     — all available buckets for the zone (up to 31 days)
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
                "ts":            b["ts"],
                "total":         b["total"],
                "degraded":      b["degraded"],
                "events":        b["events"],
                "nacp_events":   b.get("nacp_events",   0),
                "freeze_events": b.get("freeze_events", 0),
                "gap_events":    b.get("gap_events",    0),
                "fl_bands":      dict(b["fl_bands"]),
            }

        cleaned = [_clean(b) for b in buckets]

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
            "heatmap":     cleaned,
            "fl_bands":    FL_BAND_LABELS,
            "zone":        zone,
            "stats": {
                "events_24h":   events_24h,
                "degraded_24h": degraded_24h,
                "peak_hour":    peak_hour,
            },
        }
