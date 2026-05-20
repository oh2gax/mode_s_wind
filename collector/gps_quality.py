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
    (     0,  5_000, "000-050"),
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
MAX_BUCKETS   = 7 * 24         # 7 days rolling


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
        "ts":      int(ts),
        "total":   0,                          # unique aircraft seen this hour
        "degraded": 0,                         # aircraft with ≥1 event this hour
        "events":  0,                          # total event count this hour
        "fl_bands": {lbl: 0 for lbl in FL_BAND_LABELS},   # events per FL band
        "_seen":   set(),                      # transient: icaos seen this hour
        "_deg":    set(),                      # transient: icaos with event
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
        db_path:        str   = "",
    ):
        self.nacp_threshold = nacp_threshold
        self.freeze_polls   = freeze_polls
        self.gap_sec        = gap_sec
        self.min_gs_kt      = min_gs_kt
        self._db_path       = db_path

        # Per-aircraft tracking state
        # icao → {last_lat, last_lon, last_pos_ts, freeze_count, last_seen}
        self._ac_state: dict[str, dict] = {}

        # Live degraded aircraft (rebuilt every sweep)
        self._live_events: list[dict] = []

        # Rolling hourly buckets — oldest first
        self._buckets: deque = deque(maxlen=MAX_BUCKETS)

        self._lock = threading.RLock()

        # Restore history from DB (completed hours only)
        if db_path:
            self._load_from_db()

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
                # Flush outside the lock; take a shallow copy so the sets
                # (_seen, _deg) are not needed — only the scalar fields.
                flush_copy = {
                    "ts":       completed["ts"],
                    "events":   completed["events"],
                    "total":    completed["total"],
                    "degraded": completed["degraded"],
                    "fl_bands": dict(completed["fl_bands"]),
                }
                self._flush_to_db(flush_copy)
            self._buckets.append(_empty_bucket(now_hour))
        return self._buckets[-1]

    def _record_event(self, icao: str, altitude: float | None) -> None:
        """Increment event counters in the current hourly bucket."""
        bucket = self._current_bucket()
        bucket["events"] += 1
        bucket["_deg"].add(icao)
        bucket["degraded"] = len(bucket["_deg"])
        fl = _fl_band(altitude)
        if fl:
            bucket["fl_bands"][fl] = bucket["fl_bands"].get(fl, 0) + 1

    def _record_seen(self, icao: str) -> None:
        """Mark an aircraft as seen in the current bucket."""
        bucket = self._current_bucket()
        bucket["_seen"].add(icao)
        bucket["total"] = len(bucket["_seen"])

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
                   (ts, events, total, degraded, fl_bands)
                   VALUES (?, ?, ?, ?, ?)""",
                (bucket["ts"], bucket["events"], bucket["total"],
                 bucket["degraded"], fl_json),
            )
            conn.commit()
            log.debug("GPS quality: persisted bucket ts=%d events=%d",
                      bucket["ts"], bucket["events"])
        except Exception as exc:
            log.warning("GPS quality: failed to persist bucket ts=%s: %s",
                        bucket.get("ts"), exc)

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
                """SELECT ts, events, total, degraded, fl_bands
                   FROM gps_quality_hours
                   WHERE ts >= ? AND ts < ?
                   ORDER BY ts ASC""",
                (int(cutoff), int(now_hour)),
            ).fetchall()
            for row in rows:
                fl   = json.loads(row["fl_bands"] or "{}")
                b    = _empty_bucket(row["ts"])
                b["events"]   = row["events"]
                b["total"]    = row["total"]
                b["degraded"] = row["degraded"]
                b["fl_bands"] = {lbl: fl.get(lbl, 0) for lbl in FL_BAND_LABELS}
                self._buckets.append(b)
            log.info("GPS quality: loaded %d historical hour buckets from DB",
                     len(rows))
        except Exception as exc:
            log.warning("GPS quality: failed to load history from DB: %s", exc)

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
            self._record_seen(icao)

            prev = self._ac_state.get(icao, {})
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
            # Aircraft has altitude or groundspeed (EHS alive) but no
            # position message for GPS_GAP_SEC seconds.
            has_ehs = alt is not None or gs is not None
            if has_ehs and lat is None:
                last_pos_ts = prev.get("last_pos_ts")
                if last_pos_ts is not None and (now - last_pos_ts) >= self.gap_sec:
                    flags.append("gap")
                elif last_pos_ts is None:
                    # First time we see this aircraft without a position;
                    # note the time so we can flag it after GPS_GAP_SEC.
                    pass   # will be gated on next sweep

            # Update per-aircraft state
            new_state = {
                "last_lat":    lat  if lat  is not None else prev.get("last_lat"),
                "last_lon":    lon  if lon  is not None else prev.get("last_lon"),
                "last_pos_ts": now  if lat  is not None else prev.get("last_pos_ts"),
                "freeze_count": freeze_count,
                "last_seen":   last_seen,
            }
            self._ac_state[icao] = new_state

            # Record events in hourly buckets
            if flags:
                self._record_event(icao, alt)

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

                prev  = self._ac_state.get(icao, {})
                flags = []

                if nacp is not None and nacp <= self.nacp_threshold:
                    flags.append("nacp")

                if (lat is not None and lon is not None
                        and gs is not None and gs >= self.min_gs_kt
                        and prev.get("freeze_count", 0) >= self.freeze_polls):
                    flags.append("freeze")

                has_ehs     = alt is not None or gs is not None
                last_pos_ts = prev.get("last_pos_ts")
                if (has_ehs and lat is None and last_pos_ts is not None
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

    def get_state(self) -> dict:
        """
        Return a JSON-serialisable snapshot for the API endpoint.

        Returns:
          live        — aircraft currently showing degraded GPS (list)
          time_series — last 24 hourly buckets (list, oldest first)
          heatmap     — all buckets with FL-band breakdown (list)
          fl_bands    — ordered list of FL band label strings
          stats       — summary counts for the last 24 hours
        """
        with self._lock:
            buckets = list(self._buckets)

        # Strip internal sets before serialising; freeze into plain counts
        def _clean(b: dict) -> dict:
            return {
                "ts":      b["ts"],
                "total":   b["total"],
                "degraded": b["degraded"],
                "events":  b["events"],
                "fl_bands": dict(b["fl_bands"]),
            }

        cleaned = [_clean(b) for b in buckets]

        # Last 24 hours for time series
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
            "time_series": ts_24h,
            "heatmap":     cleaned,       # all available buckets (up to 7 days)
            "fl_bands":    FL_BAND_LABELS,
            "stats": {
                "events_24h":   events_24h,
                "degraded_24h": degraded_24h,
                "peak_hour":    peak_hour,
            },
        }
