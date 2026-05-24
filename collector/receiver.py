"""
Main collection loop.

Connects to the Radarcape Beast TCP feed, decodes every message with
pyModeS PipeDecoder, runs a parallel MRAR/MHR check on DF20/21 payloads,
attempts wind computation from BDS 5,0 + 6,0 pairs, then hands observations
to BatchWriter for SQLite storage and to the shared live_state dict for the
web UI.

Threading model
---------------
This function runs in a daemon thread started by run.py.
It communicates with Flask via two shared objects:
    live_state  : dict  {icao: {...current aircraft state...}}
    live_lock   : RLock protecting live_state
"""

import logging
import time
import threading
from typing import Optional

import pyModeS as pms
from pyModeS import PipeDecoder
from pyModeS.cli._source import NetworkSource
from pyModeS.position._cpr import airborne_position_with_ref

from collector.filter import check_mrar, check_mhr, best_meteo, is_blocked_icao
from collector.wind_calc import try_compute_wind
from collector.writer import BatchWriter
from config import Config

log = logging.getLogger("modes.receiver")

# Per-ICAO short-term cache for BDS 5,0 + 6,0 pairing.
# Keeps the last decoded BDS 5,0 and 6,0 per aircraft so we can cross them
# even when they arrive in consecutive messages rather than the same one.
_BDS50_CACHE: dict[str, tuple[float, dict]] = {}   # icao → (ts, bds50_fields)
_BDS60_CACHE: dict[str, tuple[float, dict]] = {}   # icao → (ts, bds60_fields)
_CACHE_LOCK = threading.Lock()


def _update_bds_cache(icao: str, ts: float, result: dict) -> None:
    """Store BDS 5,0 or 6,0 fields into the per-ICAO cache."""
    bds = result.get("bds")
    with _CACHE_LOCK:
        if bds == "5,0":
            _BDS50_CACHE[icao] = (ts, {
                "true_track":    result.get("true_track"),
                "groundspeed":   result.get("groundspeed"),
                "true_airspeed": result.get("true_airspeed"),
                "roll":          result.get("roll"),
                "track_rate":    result.get("track_rate"),
            })
        elif bds == "6,0":
            _BDS60_CACHE[icao] = (ts, {
                "magnetic_heading":   result.get("magnetic_heading"),
                "indicated_airspeed": result.get("indicated_airspeed"),
                "mach":               result.get("mach"),
            })


def _try_pair_wind(icao: str, ts: float, cfg: Config,
                   altitude: Optional[float]) -> Optional[dict]:
    """
    Try to compute wind using cached BDS 5,0 + 6,0 for this aircraft.
    Returns a wind dict or None.
    """
    with _CACHE_LOCK:
        bds50_entry = _BDS50_CACHE.get(icao)
        bds60_entry = _BDS60_CACHE.get(icao)

    if bds50_entry is None or bds60_entry is None:
        return None

    ts50, bds50 = bds50_entry
    ts60, bds60 = bds60_entry

    # Both readings must be fresh and close in time
    age50 = abs(ts - ts50)
    age60 = abs(ts - ts60)
    pair_age = abs(ts50 - ts60)

    if pair_age > cfg.WIND_MAX_PAIR_AGE:
        return None
    if age50 > 60.0 or age60 > 60.0:    # don't use stale cache
        return None

    return try_compute_wind(
        bds50         = bds50,
        bds60         = bds60,
        altitude_ft   = altitude,
        mag_declination = cfg.MAG_DECLINATION,
        max_roll      = cfg.WIND_MAX_ROLL_DEG,
        max_track_rate = cfg.WIND_MAX_TRACK_RATE,
        max_wind_kt   = cfg.WIND_MAX_SPEED_KT,
    )


def _build_observation(icao: str, ts: float, result: dict,
                        msg_hex: str, wind: Optional[dict],
                        mrar: Optional[dict], mhr: Optional[dict]) -> dict:
    """Merge all decoded data into a flat observation dict."""
    obs: dict = {
        "icao":        icao,
        "ts":          ts,
        "callsign":    result.get("callsign") or None,  # "" → None (unset transponder)
        "lat":         result.get("latitude"),
        "lon":         result.get("longitude"),
        "altitude":    result.get("altitude"),
        "groundspeed": result.get("groundspeed"),
        "track":       result.get("track") or result.get("true_track"),
        "vert_rate":   result.get("vertical_rate"),
        "nac_p":       result.get("nac_p"),   # Navigation Accuracy Category (position) — decoded from TC=29/31
    }

    # ── Squawk (Mode-A identity code) from DF5 / DF21 messages ───────────────
    # pyModeS exposes the code as "squawk" or "ident" depending on message type.
    # Only write to obs when a valid code is decoded so that the live_state merge
    # does not overwrite a JSON-sourced squawk with None on non-squawk messages.
    _sqk_raw = result.get("squawk") or result.get("ident")
    if _sqk_raw is not None:
        _sqk_str = str(_sqk_raw).strip().zfill(4)[:4]
        if _sqk_str.isdigit() and _sqk_str != "0000":
            obs["squawk"] = _sqk_str

    # Merge MRAR fields
    if mrar:
        obs.update(mrar)

    # Merge MHR fields
    if mhr:
        obs.update(mhr)

    # Merge computed wind fields
    if wind:
        obs.update({
            "wind_spd":  wind["wind_spd"],
            "wind_dir":  wind["wind_dir"],
            "wind_qual": wind["wind_qual"],
            "bds50_true_track":    wind.get("bds50_true_track"),
            "bds50_groundspeed":   wind.get("bds50_groundspeed"),
            "bds50_true_airspeed": wind.get("bds50_true_airspeed"),
            "bds50_roll":          wind.get("bds50_roll"),
            "bds60_mag_heading":   wind.get("bds60_mag_heading"),
            "bds60_ias":           wind.get("bds60_ias"),
            "bds60_mach":          wind.get("bds60_mach"),
        })

    # Consolidated best-available fields
    obs.update(best_meteo(mrar, mhr, wind))

    return obs


def _is_worth_storing(obs: dict) -> bool:
    """
    Return True if an observation carries enough data to be worth writing.
    We skip messages that decoded to nothing useful (no position, no meteo).
    """
    has_position = obs.get("lat") is not None
    has_meteo    = obs.get("meteo_source", "NONE") != "NONE"
    has_motion   = obs.get("groundspeed") is not None or obs.get("altitude") is not None
    return has_position or has_meteo or has_motion


def run_collector(
    cfg: Config,
    live_state: dict,
    live_lock: threading.RLock,
    sse_queue,          # queue.Queue for SSE events (optional)
) -> None:
    """
    Main collection loop — runs forever in a daemon thread.

    Args:
        cfg        : Config instance
        live_state : shared dict  { icao: {current state} }  (read by Flask)
        live_lock  : RLock protecting live_state
        sse_queue  : queue.Queue for pushing live events to SSE clients
    """
    log.info("Collector starting — connecting to %s:%d",
             cfg.RADARCAPE_HOST, cfg.RADARCAPE_PORT)

    writer = BatchWriter(
        write_interval      = cfg.DB_WRITE_INTERVAL,
        flight_gap_sec      = cfg.FLIGHT_GAP_SEC,
        storage_mode        = cfg.STORAGE_MODE,
        write_min_interval  = cfg.WRITE_MIN_INTERVAL_SEC,
    )

    pipe = PipeDecoder(surface_ref=(cfg.RECEIVER_LAT, cfg.RECEIVER_LON))

    while True:
        try:
            source = NetworkSource(cfg.RADARCAPE_HOST, cfg.RADARCAPE_PORT)
            log.info("Connected to Radarcape at %s:%d",
                     cfg.RADARCAPE_HOST, cfg.RADARCAPE_PORT)

            msg_count = 0
            for msg_hex, ts in source:
                msg_count += 1

                # ── Decode with pyModeS PipeDecoder ──────────────────────
                try:
                    result = pipe.decode(msg_hex, timestamp=ts)
                except Exception as exc:
                    log.debug("Decode error: %s", exc)
                    continue

                if result.get("error"):
                    continue

                icao = result.get("icao", "")
                if not icao:
                    continue
                if is_blocked_icao(icao, cfg.BLOCKED_ICAO_PREFIXES):
                    continue

                df = result.get("df", 0)

                # ── NACp extraction from TC=29 / TC=31 DF17 messages ─────
                # Aircraft Operational Status (TC=31) and Target State &
                # Status (TC=29) carry the Navigation Accuracy Category for
                # Position.  These messages are broadcast periodically by
                # modern Mode S transponders.  The value persists in
                # live_state until the next TC=29/31 is received.
                if df == 17:
                    try:
                        _tc = pms.adsb.typecode(msg_hex)
                        if _tc in (29, 31):
                            _nacp, _, _ = pms.adsb.nac_p(msg_hex)
                            result["nac_p"] = _nacp
                    except Exception:
                        pass

                # Update BDS 5,0 / 6,0 cache for wind pairing
                bds = result.get("bds")
                if bds in ("5,0", "6,0"):
                    _update_bds_cache(icao, ts, result)

                # ── Parallel MRAR / MHR check (DF20/21 only) ────────────
                mrar: Optional[dict] = None
                mhr:  Optional[dict] = None
                if df in (20, 21):
                    mrar = check_mrar(msg_hex, min_fom=cfg.MRAR_MIN_FOM)
                    if mrar is None:
                        mhr = check_mhr(msg_hex)

                # ── Snapshot cached state for enrichment ─────────────────
                # BDS 5,0 / 6,0 messages carry no ADS-B position.
                # Read the last known position / altitude for this ICAO
                # so we can attach them to the observation and use the
                # best available altitude for the wind calculation.
                with live_lock:
                    cached = dict(live_state.get(icao, {}))

                # Best altitude: prefer freshly decoded, fall back to cache
                current_altitude = result.get("altitude") or cached.get("altitude")

                # ── Attempt wind calculation ──────────────────────────────
                wind: Optional[dict] = _try_pair_wind(
                    icao, ts, cfg, current_altitude
                )

                # ── Build observation ────────────────────────────────────
                obs = _build_observation(icao, ts, result, msg_hex, wind, mrar, mhr)

                # ── Enrich observation with cached position / motion ──────
                # When the current message is a BDS 5,0 / 6,0 reply it
                # carries no lat/lon/altitude; fill from last known state.
                for _field in ("lat", "lon", "altitude", "groundspeed",
                               "track", "vert_rate"):
                    if obs.get(_field) is None and cached.get(_field) is not None:
                        obs[_field] = cached[_field]

                # ── CPR fallback position (bypass PipeDecoder bootstrap) ──
                # PipeDecoder withholds lat/lon for the first 5 CPR pairs
                # per aircraft while running anti-phantom cluster analysis.
                # In a live stream this means newly seen aircraft have no
                # position for several seconds, and may never get one if
                # FRUIT interference near EFHK causes repeated resets.
                #
                # Fix: when PipeDecoder returned no lat/lon for a DF17
                # airborne-position message but the raw CPR fields are
                # present, decode immediately using the receiver position
                # as reference (valid within 180 NM ≈ 333 km — covers
                # all Finnish airspace traffic).
                if obs.get("lat") is None and df == 17:
                    _cpr_fmt = result.get("cpr_format")
                    _cpr_lat = result.get("cpr_lat")
                    _cpr_lon = result.get("cpr_lon")
                    if (_cpr_fmt is not None
                            and _cpr_lat is not None
                            and _cpr_lon is not None):
                        try:
                            _lat, _lon = airborne_position_with_ref(
                                _cpr_fmt, _cpr_lat, _cpr_lon,
                                cfg.RECEIVER_LAT, cfg.RECEIVER_LON,
                            )
                            # Sanity gate: must be within ~500 km of receiver
                            # (5° lat ≈ 555 km, 8° lon ≈ 440 km at 60°N).
                            if (abs(_lat - cfg.RECEIVER_LAT) < 5.0
                                    and abs(_lon - cfg.RECEIVER_LON) < 8.0):
                                obs["lat"] = round(_lat, 6)
                                obs["lon"] = round(_lon, 6)
                        except Exception:
                            pass

                # ── Update live state (for web UI) ───────────────────────
                with live_lock:
                    existing = live_state.get(icao, {})
                    # Merge: only overwrite with non-None values
                    merged = {k: v for k, v in {**existing, **obs}.items()
                              if v is not None}
                    merged["icao"] = icao
                    merged["last_seen"] = ts
                    live_state[icao] = merged

                # Push to SSE queue (non-blocking)
                if sse_queue is not None:
                    try:
                        sse_queue.put_nowait({
                            "icao": icao,
                            "lat":  obs.get("lat"),
                            "lon":  obs.get("lon"),
                        })
                    except Exception:
                        pass   # queue full — skip SSE event

                # ── Enrich obs with best-known callsign ──────────────────
                # Identification messages (TC 1-4) carry only the callsign
                # with no position/altitude, so _is_worth_storing() drops them.
                # Position messages (TC 9-18) carry no callsign at all.
                # The live_state merge already accumulates the callsign across
                # message types — back-fill it into obs before the DB write so
                # every stored observation carries the aircraft's callsign.
                if not obs.get("callsign") and merged.get("callsign"):
                    obs["callsign"] = merged["callsign"]

                # ── Write to DB ───────────────────────────────────────────
                if _is_worth_storing(obs):
                    writer.add(obs)

                # Periodic stats
                if msg_count % 5000 == 0:
                    with live_lock:
                        n_tracked = len(live_state)
                    log.info("Stats: %d messages processed, %d aircraft tracked",
                             msg_count, n_tracked)

        except KeyboardInterrupt:
            log.info("Collector stopping (KeyboardInterrupt)")
            writer.flush()
            break
        except Exception as exc:
            log.error("Collector error: %s — reconnecting in 10 s", exc)
            time.sleep(10)

    log.info("Collector thread exiting")
