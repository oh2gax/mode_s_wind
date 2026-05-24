"""
Batched SQLite writer and flight-session tracker.

Observations arrive from the decoder at high rate.  Rather than committing
on every message (which would saturate the SD-card), we accumulate them in
an in-memory list and flush every DB_WRITE_INTERVAL seconds.

Flight sessions
---------------
Two contacts with the same ICAO address are considered the same flight if
the gap between them is < FLIGHT_GAP_SEC.  We track last_seen per ICAO
in the `_sessions` dict so we can look up the current flight_id without
hitting the database on every message.
"""

import logging
import sqlite3
import time
from typing import Optional

from database.db import get_db

log = logging.getLogger("modes.writer")


class BatchWriter:
    """Accumulate decoded observations and flush to SQLite periodically."""

    def __init__(self, write_interval: float, flight_gap_sec: float,
                 storage_mode: str = "ALL",
                 write_min_interval: float = 0.0) -> None:
        self._interval          = write_interval
        self._flight_gap        = flight_gap_sec
        self._storage_mode      = storage_mode
        self._write_min_interval = write_min_interval
        self._buffer: list[dict] = []
        self._last_flush = time.monotonic()

        # ICAO → (flight_id, last_seen_ts)
        self._sessions: dict[str, tuple[int, float]] = {}
        # ICAO → unix timestamp of last observation written (for throttling)
        self._last_written: dict[str, float] = {}

    # ── Public API ────────────────────────────────────────────────────────

    def add(self, obs: dict) -> None:
        """Add one observation to the in-memory buffer.

        Two optional filters are applied before buffering:

        1. METEO_ONLY mode — drops observations with no meteo data.
        2. Per-aircraft write throttle — drops observations arriving sooner
           than WRITE_MIN_INTERVAL_SEC after the last stored one for the
           same ICAO.  Prevents dozens of near-identical cruise-level rows
           while still capturing altitude changes during climbs/descents.
        """
        if (self._storage_mode == "METEO_ONLY"
                and obs.get("meteo_source", "NONE") == "NONE"):
            return

        if self._write_min_interval > 0:
            icao = obs.get("icao", "")
            ts   = obs.get("ts", 0.0)
            last = self._last_written.get(icao, 0.0)
            if ts - last < self._write_min_interval:
                return
            self._last_written[icao] = ts

        self._buffer.append(obs)

        # Flush on time trigger
        if (time.monotonic() - self._last_flush) >= self._interval:
            self.flush()

    def flush(self) -> None:
        """Write the entire buffer to SQLite and clear it."""
        if not self._buffer:
            self._last_flush = time.monotonic()
            return

        batch = self._buffer[:]
        self._buffer.clear()

        try:
            db = get_db()
            self._write_batch(db, batch)
            db.commit()
            log.debug("Flushed %d observations to DB", len(batch))
        except sqlite3.Error as exc:
            log.error("DB write failed: %s — %d observations dropped", exc, len(batch))
        finally:
            self._last_flush = time.monotonic()

    # ── Internal helpers ──────────────────────────────────────────────────

    def _get_or_create_flight(
        self, db: sqlite3.Connection, obs: dict
    ) -> Optional[int]:
        """Return the flight_id for this observation, creating a new row if needed."""
        icao = obs["icao"]
        ts   = obs["ts"]

        if icao in self._sessions:
            flight_id, last_ts = self._sessions[icao]
            if (ts - last_ts) <= self._flight_gap:
                # Still the same flight — update last_seen
                self._sessions[icao] = (flight_id, ts)
                return flight_id
            # Gap too large → fall through to create new session

        # Check DB for an open session (in case of restart)
        row = db.execute(
            "SELECT id, last_seen FROM flights WHERE icao = ? "
            "ORDER BY last_seen DESC LIMIT 1",
            (icao,),
        ).fetchone()

        if row and (ts - row["last_seen"]) <= self._flight_gap:
            flight_id = row["id"]
            self._sessions[icao] = (flight_id, ts)
            return flight_id

        # New flight session
        cur = db.execute(
            """INSERT INTO flights (icao, callsign, first_seen, last_seen,
               first_lat, first_lon, max_altitude, min_altitude,
               obs_count, meteo_count)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)""",
            (
                icao,
                obs.get("callsign"),
                ts, ts,
                obs.get("lat"), obs.get("lon"),
                obs.get("altitude"), obs.get("altitude"),
            ),
        )
        flight_id = cur.lastrowid
        self._sessions[icao] = (flight_id, ts)
        log.info("New flight session  ICAO=%-6s  id=%d", icao, flight_id)
        return flight_id

    def _write_batch(self, db: sqlite3.Connection, batch: list[dict]) -> None:
        """Write a list of observation dicts to the database."""
        # Group by flight so we do one UPDATE per flight per batch
        flight_updates: dict[int, dict] = {}

        for obs in batch:
            try:
                fid = self._get_or_create_flight(db, obs)
            except Exception as exc:
                log.warning("Could not get flight_id for %s: %s", obs.get("icao"), exc)
                fid = None

            has_meteo = obs.get("meteo_source", "NONE") != "NONE"

            db.execute(
                """INSERT INTO observations (
                    flight_id, icao, ts,
                    lat, lon, altitude,
                    groundspeed, track, vert_rate,
                    mrar_wind_spd, mrar_wind_dir, mrar_temp,
                    mrar_pressure, mrar_humidity, mrar_turbulence, mrar_fom,
                    mhr_temp, mhr_pressure, mhr_turbulence,
                    mhr_wind_shear, mhr_icing, mhr_microburst, mhr_radio_height,
                    wind_spd, wind_dir, wind_qual,
                    bds50_true_track, bds50_groundspeed, bds50_true_airspeed, bds50_roll,
                    bds60_mag_heading, bds60_ias, bds60_mach,
                    best_wind_spd, best_wind_dir, best_temp, best_pressure,
                    meteo_source
                ) VALUES (
                    :flight_id, :icao, :ts,
                    :lat, :lon, :altitude,
                    :groundspeed, :track, :vert_rate,
                    :mrar_wind_spd, :mrar_wind_dir, :mrar_temp,
                    :mrar_pressure, :mrar_humidity, :mrar_turbulence, :mrar_fom,
                    :mhr_temp, :mhr_pressure, :mhr_turbulence,
                    :mhr_wind_shear, :mhr_icing, :mhr_microburst, :mhr_radio_height,
                    :wind_spd, :wind_dir, :wind_qual,
                    :bds50_true_track, :bds50_groundspeed, :bds50_true_airspeed, :bds50_roll,
                    :bds60_mag_heading, :bds60_ias, :bds60_mach,
                    :best_wind_spd, :best_wind_dir, :best_temp, :best_pressure,
                    :meteo_source
                )""",
                {
                    "flight_id": fid,
                    "icao":      obs.get("icao"),
                    "ts":        obs.get("ts"),
                    "lat":       obs.get("lat"),
                    "lon":       obs.get("lon"),
                    "altitude":  obs.get("altitude"),
                    "groundspeed": obs.get("groundspeed"),
                    "track":     obs.get("track"),
                    "vert_rate": obs.get("vert_rate"),
                    # MRAR
                    "mrar_wind_spd":   obs.get("mrar_wind_spd"),
                    "mrar_wind_dir":   obs.get("mrar_wind_dir"),
                    "mrar_temp":       obs.get("mrar_temp"),
                    "mrar_pressure":   obs.get("mrar_pressure"),
                    "mrar_humidity":   obs.get("mrar_humidity"),
                    "mrar_turbulence": obs.get("mrar_turbulence"),
                    "mrar_fom":        obs.get("mrar_fom"),
                    # MHR
                    "mhr_temp":        obs.get("mhr_temp"),
                    "mhr_pressure":    obs.get("mhr_pressure"),
                    "mhr_turbulence":  obs.get("mhr_turbulence"),
                    "mhr_wind_shear":  obs.get("mhr_wind_shear"),
                    "mhr_icing":       obs.get("mhr_icing"),
                    "mhr_microburst":  obs.get("mhr_microburst"),
                    "mhr_radio_height": obs.get("mhr_radio_height"),
                    # Computed wind
                    "wind_spd":  obs.get("wind_spd"),
                    "wind_dir":  obs.get("wind_dir"),
                    "wind_qual": obs.get("wind_qual"),
                    # BDS 5,0 raw
                    "bds50_true_track":    obs.get("bds50_true_track"),
                    "bds50_groundspeed":   obs.get("bds50_groundspeed"),
                    "bds50_true_airspeed": obs.get("bds50_true_airspeed"),
                    "bds50_roll":          obs.get("bds50_roll"),
                    # BDS 6,0 raw
                    "bds60_mag_heading": obs.get("bds60_mag_heading"),
                    "bds60_ias":         obs.get("bds60_ias"),
                    "bds60_mach":        obs.get("bds60_mach"),
                    # Best consolidated
                    "best_wind_spd": obs.get("best_wind_spd"),
                    "best_wind_dir": obs.get("best_wind_dir"),
                    "best_temp":     obs.get("best_temp"),
                    "best_pressure": obs.get("best_pressure"),
                    "meteo_source":  obs.get("meteo_source", "NONE"),
                },
            )

            # Accumulate flight update stats
            if fid is not None:
                upd = flight_updates.setdefault(fid, {
                    "last_seen": obs["ts"],
                    "obs_count": 0,
                    "meteo_count": 0,
                    "max_alt": obs.get("altitude"),
                    "min_alt": obs.get("altitude"),
                    "callsign": obs.get("callsign"),
                })
                upd["last_seen"] = max(upd["last_seen"], obs["ts"])
                upd["obs_count"] += 1
                if has_meteo:
                    upd["meteo_count"] += 1
                if obs.get("altitude") is not None:
                    if upd["max_alt"] is None or obs["altitude"] > upd["max_alt"]:
                        upd["max_alt"] = obs["altitude"]
                    if upd["min_alt"] is None or obs["altitude"] < upd["min_alt"]:
                        upd["min_alt"] = obs["altitude"]
                if obs.get("callsign") and not upd.get("callsign"):
                    upd["callsign"] = obs["callsign"]

        # Bulk-update flight rows
        for fid, upd in flight_updates.items():
            db.execute(
                """UPDATE flights SET
                    last_seen   = MAX(last_seen,   :last_seen),
                    obs_count   = obs_count   + :obs_count,
                    meteo_count = meteo_count + :meteo_count,
                    max_altitude = CASE WHEN max_altitude IS NULL THEN :max_alt
                                        WHEN :max_alt > max_altitude THEN :max_alt
                                        ELSE max_altitude END,
                    min_altitude = CASE WHEN min_altitude IS NULL THEN :min_alt
                                        WHEN :min_alt < min_altitude THEN :min_alt
                                        ELSE min_altitude END,
                    callsign = COALESCE(NULLIF(:callsign, ''), callsign)
                   WHERE id = :id""",
                {
                    "last_seen":   upd["last_seen"],
                    "obs_count":   upd["obs_count"],
                    "meteo_count": upd["meteo_count"],
                    "max_alt":     upd["max_alt"],
                    "min_alt":     upd["min_alt"],
                    "callsign":    upd.get("callsign"),
                    "id":          fid,
                },
            )
