"""
collector/radarcape_json.py

Polls the Radarcape's aircraftlist.json endpoint every few seconds and
injects position and meteorological data into the shared live_state dict.

Why this matters for EFHK:
  Russian GPS jamming in the Baltic / Gulf of Finland region regularly
  suppresses ADS-B position broadcasts from aircraft overflying the area.
  The Radarcape is part of a Multilateration (MLAT) network that can
  locate these aircraft by timing their Mode-S replies at multiple ground
  stations — without any involvement from the aircraft's GPS.  The JSON
  endpoint exposes these MLAT positions alongside any MRAR-derived
  temperature and wind data the Radarcape has decoded.

Position injection priority
---------------------------
  MLAT  (src="M") : always written to live_state — supersedes any stale
                    ADS-B position because MLAT is immune to GPS spoofing.
  ADS-B (src="A") : written only when live_state has no position yet
                    (our Beast decoder may have already set one).

Meteo injection
---------------
  tmp            → best_temp   if no MRAR temperature is already present
  wsp / wdi      → best_wind   if no wind is already present
  Meteo source is tagged "JSON" so the map can colour it distinctly.

Wind-speed unit
---------------
  The Radarcape derives wsp from BDS 4,4 MRAR when available; MRAR
  encodes wind speed in knots.  For aircraft where the Radarcape
  computes wind from BDS 5,0 / 6,0 the unit is also knots.
  If values look systematically off after live comparison, divide by
  1.852 here to convert from km/h.
"""

import json as json_mod
import logging
import threading
import time
import urllib.request
from typing import Optional

log = logging.getLogger("modes.json_poller")

POLL_INTERVAL: float = 5.0   # seconds between HTTP requests
HTTP_TIMEOUT:  float = 4.0   # per-request timeout


# ── Entry parser ──────────────────────────────────────────────────────────────

def _parse_entry(entry: dict) -> Optional[dict]:
    """Convert one aircraftlist.json entry to a normalised dict.

    Returns None if the entry has no usable ICAO address.
    """
    hex_icao = entry.get("hex", "").upper().strip()
    if not hex_icao:
        return None

    # Position — require both lat and lon to be present and sane
    lat = entry.get("lat")
    lon = entry.get("lon")
    if lat is not None and lon is not None:
        if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
            lat = lon = None

    # Temperature sanity (−80 to +50 °C covers ground to stratosphere)
    tmp = entry.get("tmp")
    if tmp is not None and not (-80.0 <= tmp <= 50.0):
        tmp = None

    # Wind sanity (0–300 kt; direction 0–360)
    wsp = entry.get("wsp")
    wdi = entry.get("wdi")
    if wsp is not None and not (0.0 <= wsp <= 300.0):
        wsp = wdi = None
    if wdi is not None and not (0.0 <= wdi <= 360.0):
        wdi = None

    return {
        "icao":         hex_icao,
        "callsign":     entry.get("fli"),
        "lat":          lat,
        "lon":          lon,
        "altitude":     entry.get("alt"),     # ft
        "groundspeed":  entry.get("spd"),     # kt
        "track":        entry.get("trk"),     # °
        "vert_rate":    entry.get("vrt"),     # ft/min
        "json_src":     entry.get("src", "?"),# "A" / "M" / "?"
        "json_temp":    tmp,                  # °C
        "json_wind_spd": wsp,                 # kt
        "json_wind_dir": wdi,                 # °
        "registration":  entry.get("reg"),
        "aircraft_type": entry.get("typ"),
    }


# ── Main poller thread ────────────────────────────────────────────────────────

def run_json_poller(
    url: str,
    live_state: dict,
    live_lock: threading.RLock,
    source_mode: str = "HYBRID",
) -> None:
    """
    Daemon thread: polls the Radarcape JSON endpoint and merges data into
    live_state.

    Args:
        url         : full HTTP URL, e.g. "http://192.168.0.119/aircraftlist.json"
        live_state  : shared dict {icao: {...}} maintained by the collector
        live_lock   : RLock protecting live_state
        source_mode : "EHS" | "JSON" | "HYBRID" — controls meteo injection
                      EHS    → positions only, never inject JSON meteo
                      JSON   → always inject JSON meteo, overwrite EHS values
                      HYBRID → inject JSON meteo only when EHS has nothing yet
    """
    log.info("JSON poller starting — %s (every %.0f s) [source_mode=%s]",
             url, POLL_INTERVAL, source_mode)
    consecutive_errors = 0

    while True:
        try:
            with urllib.request.urlopen(url, timeout=HTTP_TIMEOUT) as resp:
                raw = resp.read()

            entries = json_mod.loads(raw)
            now = time.time()

            n_pos_mlat = 0
            n_pos_adsb = 0
            n_meteo    = 0

            with live_lock:
                for entry in entries:
                    parsed = _parse_entry(entry)
                    if parsed is None:
                        continue

                    icao    = parsed["icao"]
                    src     = parsed["json_src"]
                    existing = live_state.get(icao, {})
                    merged  = dict(existing)

                    # ── Basic fields (overwrite only with non-None) ──────────
                    for field in ("callsign", "altitude", "groundspeed",
                                  "track", "vert_rate",
                                  "registration", "aircraft_type"):
                        if parsed.get(field) is not None:
                            merged[field] = parsed[field]

                    # ── Position ─────────────────────────────────────────────
                    if parsed.get("lat") is not None:
                        if src == "M":
                            # MLAT: always preferred — GPS-jamming immune
                            merged["lat"]     = parsed["lat"]
                            merged["lon"]     = parsed["lon"]
                            merged["pos_src"] = "MLAT"
                            n_pos_mlat += 1
                        elif not existing.get("lat"):
                            # ADS-B from JSON: only fill if we have nothing yet
                            merged["lat"]     = parsed["lat"]
                            merged["lon"]     = parsed["lon"]
                            merged["pos_src"] = "JSON"
                            n_pos_adsb += 1

                    # ── Temperature ───────────────────────────────────────────
                    # EHS:    never inject — JSON feed is for positions only.
                    # JSON:   always inject, overwrite any EHS-derived value.
                    # HYBRID: inject only when no MRAR/EHS temperature present.
                    if parsed.get("json_temp") is not None and source_mode != "EHS":
                        if (source_mode == "JSON"
                                or (merged.get("mrar_temp") is None
                                    and merged.get("best_temp") is None)):
                            merged["best_temp"] = parsed["json_temp"]
                            merged["json_temp"] = parsed["json_temp"]
                            n_meteo += 1

                    # ── Wind ──────────────────────────────────────────────────
                    # EHS:    never inject.
                    # JSON:   always inject, overwrite any EHS-derived value.
                    # HYBRID: inject only when no EHS/COMPUTED wind present.
                    if (parsed.get("json_wind_spd") is not None
                            and parsed.get("json_wind_dir") is not None
                            and source_mode != "EHS"):
                        if (source_mode == "JSON"
                                or merged.get("best_wind_spd") is None):
                            merged["best_wind_spd"] = parsed["json_wind_spd"]
                            merged["best_wind_dir"] = parsed["json_wind_dir"]
                            merged["json_wind_spd"] = parsed["json_wind_spd"]
                            merged["json_wind_dir"] = parsed["json_wind_dir"]
                            # Tag source: always "JSON" in JSON mode;
                            # in HYBRID only if nothing else set it yet.
                            if (source_mode == "JSON"
                                    or merged.get("meteo_source", "NONE") == "NONE"):
                                merged["meteo_source"] = "JSON"
                            n_meteo += 1

                    merged["icao"]      = icao
                    merged["last_seen"] = max(merged.get("last_seen", 0.0), now)
                    live_state[icao]    = merged

            consecutive_errors = 0
            log.debug(
                "JSON poll: MLAT pos=%d  JSON pos=%d  meteo injected=%d",
                n_pos_mlat, n_pos_adsb, n_meteo,
            )

        except Exception as exc:
            consecutive_errors += 1
            # Log first 3 errors verbosely, then throttle to every 20th
            if consecutive_errors <= 3 or consecutive_errors % 20 == 0:
                log.warning("JSON poller error (#%d): %s", consecutive_errors, exc)

        time.sleep(POLL_INTERVAL)
