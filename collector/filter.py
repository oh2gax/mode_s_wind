"""
Quality filtering for MRAR (BDS 4,4) and MHR (BDS 4,5) observations.

The pyModeS v3 commb.py hardcodes include_meteo=False, so we do our own
parallel pass on every DF20/21 MB payload using the low-level bds44/bds45
validators and decoders directly.
"""

import logging
from typing import Optional

from pyModeS.decoder.bds.bds44 import is_bds44, decode_bds44
from pyModeS.decoder.bds.bds45 import is_bds45, decode_bds45

log = logging.getLogger("modes.filter")


def is_blocked_icao(icao: str, prefixes: tuple | list) -> bool:
    """Return True if icao matches any blocked prefix.

    Used to silently drop non-aircraft Mode-S emitters — e.g. Finnish WAM
    ground interrogator stations whose ICAO24 codes start with 'T40'.
    Comparison is case-insensitive.
    """
    if not icao or not prefixes:
        return False
    upper = icao.upper()
    return any(upper.startswith(p.upper()) for p in prefixes)


def extract_mb(msg_hex: str) -> Optional[int]:
    """
    Extract the 56-bit MB (Message Block) payload from a DF20/21 hex string.

    DF20/21 frame layout (112 bits = 28 hex chars):
        bits  0– 4 : DF (5)
        bits  5– 7 : SL / FS (3)
        bits  8–31 : AC / ID field (24)
        bits 32–87 : MB – the 56-bit payload we want  ← hex chars 8..21
        bits 88–111: AP (CRC XOR'd with ICAO) (24)
    """
    if len(msg_hex) != 28:
        return None
    try:
        return int(msg_hex[8:22], 16)
    except ValueError:
        return None


def check_mrar(msg_hex: str, min_fom: int = 1) -> Optional[dict]:
    """
    Try to decode a DF20/21 message as BDS 4,4 MRAR.

    Returns a dict of decoded meteo fields (with prefix 'mrar_') if the
    message passes the validator and the Figure of Merit is acceptable,
    otherwise returns None.
    """
    mb = extract_mb(msg_hex)
    if mb is None:
        return None

    if not is_bds44(mb):
        return None

    raw = decode_bds44(mb)
    fom = raw.get("figure_of_merit", 0)

    if fom < min_fom:
        log.debug("MRAR rejected: FOM=%d < min %d", fom, min_fom)
        return None

    result: dict = {"mrar_fom": fom}

    wind_spd = raw.get("wind_speed")
    wind_dir = raw.get("wind_direction")
    if wind_spd is not None:
        result["mrar_wind_spd"] = round(float(wind_spd), 1)
    if wind_dir is not None:
        result["mrar_wind_dir"] = round(float(wind_dir), 1)

    temp = raw.get("static_air_temperature")
    if temp is not None:
        # Sanity range for Finland: −80°C (stratosphere) to +40°C (summer surface)
        if -80.0 <= temp <= 40.0:
            result["mrar_temp"] = round(float(temp), 2)
        else:
            log.debug("MRAR temp %.1f°C outside plausible range — discarded", temp)

    pressure = raw.get("static_pressure")
    if pressure is not None:
        if 100.0 <= pressure <= 1050.0:
            result["mrar_pressure"] = round(float(pressure), 1)
        else:
            log.debug("MRAR pressure %.0f hPa outside plausible range — discarded",
                      pressure)

    humidity = raw.get("humidity")
    if humidity is not None:
        result["mrar_humidity"] = round(float(humidity), 1)

    turbulence = raw.get("turbulence")
    if turbulence is not None:
        result["mrar_turbulence"] = int(turbulence)

    return result if len(result) > 1 else None   # must have more than just FOM


def check_mhr(msg_hex: str) -> Optional[dict]:
    """
    Try to decode a DF20/21 message as BDS 4,5 MHR.

    Returns a dict of decoded hazard fields (with prefix 'mhr_') or None.
    """
    mb = extract_mb(msg_hex)
    if mb is None:
        return None

    if not is_bds45(mb):
        return None

    raw = decode_bds45(mb)
    result: dict = {}

    temp = raw.get("static_air_temperature")
    if temp is not None and -80.0 <= temp <= 40.0:
        result["mhr_temp"] = round(float(temp), 2)

    pressure = raw.get("static_pressure")
    if pressure is not None and 100.0 <= pressure <= 1050.0:
        result["mhr_pressure"] = round(float(pressure), 1)

    for key in ("turbulence", "wind_shear", "icing", "microburst", "wake_vortex"):
        val = raw.get(key)
        if val is not None:
            result[f"mhr_{key}"] = int(val)

    radio_height = raw.get("radio_height")
    if radio_height is not None:
        result["mhr_radio_height"] = int(radio_height)

    return result if result else None


def best_meteo(mrar: Optional[dict], mhr: Optional[dict],
               wind: Optional[dict]) -> dict:
    """
    Consolidate MRAR, MHR, and computed-wind into 'best_*' fields.

    Priority: MRAR direct > MHR > computed wind
    """
    best: dict = {}

    # Wind: MRAR > computed
    if mrar and "mrar_wind_spd" in mrar:
        best["best_wind_spd"] = mrar["mrar_wind_spd"]
        best["best_wind_dir"] = mrar.get("mrar_wind_dir")
    elif wind:
        best["best_wind_spd"] = wind["wind_spd"]
        best["best_wind_dir"] = wind["wind_dir"]

    # Temperature: MRAR > MHR
    if mrar and "mrar_temp" in mrar:
        best["best_temp"] = mrar["mrar_temp"]
    elif mhr and "mhr_temp" in mhr:
        best["best_temp"] = mhr["mhr_temp"]

    # Pressure: MRAR > MHR
    if mrar and "mrar_pressure" in mrar:
        best["best_pressure"] = mrar["mrar_pressure"]
    elif mhr and "mhr_pressure" in mhr:
        best["best_pressure"] = mhr["mhr_pressure"]

    # Source label
    if mrar:
        best["meteo_source"] = "MRAR"
    elif mhr:
        best["meteo_source"] = "MHR"
    elif wind:
        best["meteo_source"] = "COMPUTED"
    else:
        best["meteo_source"] = "NONE"

    return best
