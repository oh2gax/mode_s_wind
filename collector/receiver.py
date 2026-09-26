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

from pyModeS import PipeDecoder
from pyModeS.cli._source import NetworkSource
from pyModeS.position._cpr import airborne_position_with_ref

from collector.filter import check_mrar, check_mhr, best_meteo, is_blocked_icao, is_blocked_registration
from collector.wind_calc import try_compute_wind
from collector.declination import declination as mag_declination_at
from collector.writer import BatchWriter
from config import Config

log = logging.getLogger("modes.receiver")

# Per-ICAO short-term cache for BDS 5,0 + 6,0 pairing.
# Keeps the last decoded BDS 5,0 and 6,0 per aircraft so we can cross them
# even when they arrive in consecutive messages rather than the same one.
_BDS50_CACHE: dict[str, tuple[float, dict]] = {}   # icao → (ts, bds50_fields)
_BDS60_CACHE: dict[str, tuple[float, dict]] = {}   # icao → (ts, bds60_fields)
_CACHE_LOCK = threading.Lock()


# ── ADS-B integrity (NIC / containment radius Rc) ─────────────────────────
# NIC is not a message field: it is encoded in the airborne-position TYPE CODE
# plus supplement bits (DO-260A/B).  Key = NIC-A * 2 + NIC-B (version 2) or the
# single NIC supplement (version 1); key 0 is used when a supplement is unknown
# (and for version 0, where the TC maps to NUCp with the same radii).
# Value = (NIC, Rc in metres).  Rc None = unknown / > 20 NM.
_NIC_TABLE: dict[int, dict[int, tuple[int, float | None]]] = {
    9:  {0: (11, 7.5)},
    10: {0: (10, 25.0)},
    11: {0: (8, 185.2), 1: (9, 75.0), 3: (9, 75.0)},
    12: {0: (7, 370.4)},
    13: {0: (6, 926.0), 1: (6, 555.6), 2: (6, 1111.2)},
    14: {0: (5, 1852.0)},
    15: {0: (4, 3704.0)},
    16: {0: (2, 14816.0), 1: (3, 7408.0), 3: (3, 7408.0)},
    17: {0: (1, 37040.0)},
    18: {0: (0, None)},
    20: {0: (11, 7.5)},
    21: {0: (10, 25.0)},
    22: {0: (0, None)},
}


def nic_from_position(tc: int, version: int | None,
                      nic_a: int | None, nic_b: int | None) -> tuple[int, float | None] | None:
    """NIC and containment radius Rc (m) for an airborne-position type code.

    version 2: key = NIC-A (from TC 31) * 2 + NIC-B (position message bit).
    version 1: key = NIC supplement (TC 31); the position-message bit is not
               a NIC supplement in version 1.
    version 0 / unknown: key 0 (TC alone).
    Unknown supplement combinations fall back to key 0.
    """
    row = _NIC_TABLE.get(tc)
    if row is None:
        return None
    if version == 2 and nic_a is not None and nic_b is not None:
        key = (nic_a << 1) | nic_b
    elif version == 1 and nic_a is not None:
        key = nic_a
    else:
        key = 0
    return row.get(key, row[0])


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


def prune_bds_cache(max_age_sec: float = 120.0) -> int:
    """Drop BDS 5,0 / 6,0 cache entries older than max_age_sec.

    Entries older than 60 s are never used for pairing (_try_pair_wind), so
    they only occupy memory.  Called periodically by the housekeeping thread
    in run.py.  Returns the number of entries removed.
    """
    cutoff  = time.time() - max_age_sec
    removed = 0
    with _CACHE_LOCK:
        for cache in (_BDS50_CACHE, _BDS60_CACHE):
            for icao in [k for k, (ts, _) in cache.items() if ts < cutoff]:
                del cache[icao]
                removed += 1
    return removed


def _try_pair_wind(icao: str, ts: float, cfg: Config,
                   altitude: Optional[float],
                   lat: Optional[float] = None,
                   lon: Optional[float] = None) -> Optional[dict]:
    """
    Try to compute wind using cached BDS 5,0 + 6,0 for this aircraft.
    lat/lon (last known position) select the magnetic declination; without a
    position, or with USE_WMM_DECLINATION off, cfg.MAG_DECLINATION is used.
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

    if getattr(cfg, "USE_WMM_DECLINATION", True):
        decl = mag_declination_at(lat, lon, cfg.MAG_DECLINATION)
    else:
        decl = cfg.MAG_DECLINATION

    return try_compute_wind(
        bds50         = bds50,
        bds60         = bds60,
        altitude_ft   = altitude,
        mag_declination = decl,
        max_roll      = cfg.WIND_MAX_ROLL_DEG,
        max_track_rate = cfg.WIND_MAX_TRACK_RATE,
        max_wind_kt   = cfg.WIND_MAX_SPEED_KT,
        icao          = icao,
        ts            = ts,
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
        # Explicit None check — `or` would discard a valid 0° (due north) track
        "track":       (result.get("track") if result.get("track") is not None
                        else result.get("true_track")),
        "vert_rate":   result.get("vertical_rate"),
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
            "tas_source": wind.get("tas_source"),
            "mag_decl":   wind.get("mag_decl"),
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


def _update_quality_fields(merged: dict, tc, result: dict, ts: float) -> None:
    """Store ADS-B self-reported quality in live_state (one DF17 message).

      • TC 31 (operational status): ADS-B version, NIC supplement-A, NACp
        (NACp only for version ≥ 1 — undefined in version 0)
      • TC 29 (target state & status, version 1/2 only): NACp
      • TC 19 (airborne velocity): NACv
      • TC 9-18 / 20-22 (airborne position): NIC and containment radius Rc
    Each value gets its own timestamp so consumers can ignore stale values.
    """
    if tc is None:
        return
    if tc == 31:
        ver = result.get("version")
        if ver is not None:
            merged["adsb_version"] = ver
        if result.get("nic_supplement_a") is not None:
            merged["nic_a"] = result["nic_supplement_a"]
        if ver is not None and ver >= 1 and result.get("nac_p") is not None:
            merged["nac_p"]    = result["nac_p"]
            merged["nac_p_ts"] = ts
    elif tc == 29:
        if result.get("nac_p") is not None:
            merged["nac_p"]    = result["nac_p"]
            merged["nac_p_ts"] = ts
    elif tc == 19:
        if result.get("nac_v") is not None:
            merged["nac_v"] = result["nac_v"]
    elif 9 <= tc <= 18 or 20 <= tc <= 22:
        nic = nic_from_position(tc, merged.get("adsb_version"),
                                merged.get("nic_a"), result.get("nic_b"))
        if nic is not None:
            merged["nic"], merged["nic_rc_m"] = nic
            merged["nic_ts"] = ts


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

                # ADS-B type code (DF17 only) — used for the quality fields
                # (NACp / NIC / NACv / version) handled in the live_state merge.
                # (The former pms.adsb.nac_p() call used the removed pyModeS
                # v2 API and always failed silently; pyModeS v3 already
                # returns nac_p in the decoded result.)
                tc = result.get("typecode") if df == 17 else None

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
                current_altitude = (result.get("altitude") if result.get("altitude") is not None
                                    else cached.get("altitude"))

                # ── Attempt wind calculation ──────────────────────────────
                # Best position for the declination lookup (fresh or cached)
                _pos_lat = (result.get("latitude") if result.get("latitude") is not None
                            else cached.get("lat"))
                _pos_lon = (result.get("longitude") if result.get("longitude") is not None
                            else cached.get("lon"))
                wind: Optional[dict] = _try_pair_wind(
                    icao, ts, cfg, current_altitude, _pos_lat, _pos_lon
                )

                # ── Build observation ────────────────────────────────────
                obs = _build_observation(icao, ts, result, msg_hex, wind, mrar, mhr)

                # Track whether THIS message contains a fresh ADS-B GPS position
                # (decoded directly from TC=9-18/20-22 by pyModeS) before any
                # enrichment from cached state.  Used to maintain
                # last_adsb_pos_ts in live_state so the GPS quality tracker can
                # detect when MLAT is covering for a GPS/ADS-B position dropout.
                _fresh_adsb_pos = obs.get("lat") is not None

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
                # Condition on the decoder result (not obs, which was already
                # filled from cache above) and on airborne-position type codes
                # only — surface CPR (TC 5-8) needs a different decoder.
                if (result.get("latitude") is None and df == 17
                        and tc is not None and (9 <= tc <= 18 or 20 <= tc <= 22)):
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
                                _fresh_adsb_pos = True  # CPR decoded a fresh position
                        except Exception:
                            pass

                # ── Update live state (for web UI) ───────────────────────
                with live_lock:
                    existing = live_state.get(icao, {})
                    # Merge: only overwrite with non-None values
                    merged = {k: v for k, v in {**existing, **obs}.items()
                              if v is not None}
                    merged["icao"]      = icao
                    merged["last_seen"] = ts
                    # Start of this visit (entry re-created after live_state
                    # pruning) — used by the GPS quality ADS-B loss signal.
                    if not existing:
                        merged["first_seen"] = ts
                    # Heard by OUR receiver (Beast feed) — the JSON poller
                    # refreshes last_seen but never last_rx_ts.
                    merged["last_rx_ts"] = ts
                    # Any DF17 extended squitter (identification, velocity,
                    # status, position …) proves the aircraft is ADS-B
                    # equipped and transmitting during this visit.
                    if df == 17:
                        merged["last_es_ts"] = ts
                        _update_quality_fields(merged, tc, result, ts)
                    if _fresh_adsb_pos:
                        # Own ADS-B position: kept separately from lat/lon,
                        # which MLAT (JSON poller) may overwrite
                        merged["adsb_lat"] = obs["lat"]
                        merged["adsb_lon"] = obs["lon"]
                        merged["last_pos_update_ts"] = ts
                    # Record when the aircraft last transmitted its own GPS-derived
                    # ADS-B position (TC=9-18/20-22 in Beast feed).  Used by the
                    # GPS quality tracker to detect ADS-B position loss while MLAT
                    # continues to provide coverage (adsb_loss signal).
                    if _fresh_adsb_pos:
                        merged["last_adsb_pos_ts"] = ts

                    # ── Registration blocklist ───────────────────────────────
                    # Registration is provided by the JSON poller (not the Beast
                    # feed), so it may not be set on the very first messages.
                    # Once the JSON poller has populated it, drop the aircraft
                    # from live_state entirely and skip the DB write.
                    _reg = merged.get("registration") or ""
                    if is_blocked_registration(_reg, cfg.BLOCKED_REG_PREFIXES):
                        live_state.pop(icao, None)
                        continue

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
