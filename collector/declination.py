"""
collector/declination.py

Magnetic declination at the aircraft's position, from the World Magnetic
Model (WMM2025) via the `pygeomag` package.

Why it matters
--------------
BDS 6,0 reports the aircraft's MAGNETIC heading.  The wind calculation needs
TRUE heading, so declination is added.  Aircraft derive the magnetic heading
from their true heading plus a world-magnetic-model declination at their own
position, so reversing it with the model value at the same position is the
correct inverse.  Across a ~150 NM receiver range around EFHK declination
varies from about 8.7° (west/south-west) to 12.6° (north-east); a single
fixed value is off by up to ~2°, which at 450 kt TAS is a ~16 kt wind error.

Performance
-----------
Wind is recomputed on almost every message, so declination is not computed
per call.  Values are cached on a GRID_DEG grid (corners computed lazily on
first use) and bilinearly interpolated; the cache is rebuilt once per day so
the slow secular drift (~0.15°/year) is followed automatically.  Declination
varies so smoothly that the interpolation error is far below 0.1°.

Fallback
--------
If pygeomag is not installed, fails to load, or the position is unknown,
the fixed Config.MAG_DECLINATION value is returned — exactly the previous
behaviour.  After the model's validity period (WMM2025: 2025.0–2030.0) the
model is extrapolated with a one-time warning; update pygeomag to get the
next WMM release.
"""

import logging
import math
import threading
import time

log = logging.getLogger("modes.declination")

GRID_DEG          = 0.5        # cache grid spacing (degrees lat / lon)
CACHE_REFRESH_SEC = 86_400.0   # rebuild cache daily (secular drift)

_lock          = threading.Lock()
_cache: dict[tuple[int, int], float] = {}
_cache_built   = 0.0
_warned_expiry = False
_model         = None           # GeoMag instance, or None when unavailable
_model_state   = "unloaded"     # "unloaded" | "ok" | "unavailable"


def _load_model() -> None:
    """Load pygeomag's WMM2025 once; mark unavailable on any failure."""
    global _model, _model_state
    try:
        from pygeomag import GeoMag
        m = GeoMag(coefficients_file="wmm/WMM_2025.COF")
        m.calculate(glat=60.0, glon=25.0, alt=0.0, time=_decimal_year(),
                    allow_date_outside_lifespan=True)   # smoke test
        _model, _model_state = m, "ok"
        log.info("Magnetic declination: WMM2025 model (pygeomag) — position-based")
    except Exception as exc:
        _model, _model_state = None, "unavailable"
        log.warning("Magnetic declination: pygeomag not available (%s) — "
                    "using fixed MAG_DECLINATION from config.py", exc)


def _decimal_year(ts: float | None = None) -> float:
    t = time.gmtime(ts if ts is not None else time.time())
    days_in_year = 366 if (t.tm_year % 4 == 0 and (t.tm_year % 100 != 0 or t.tm_year % 400 == 0)) else 365
    return t.tm_year + (t.tm_yday - 1 + (t.tm_hour + t.tm_min / 60.0) / 24.0) / days_in_year


def _model_decl(lat: float, lon: float) -> float:
    """Declination (°, east positive) from the model at sea level, now."""
    global _warned_expiry
    yr = _decimal_year()
    try:
        return _model.calculate(glat=lat, glon=lon, alt=0.0, time=yr).d
    except ValueError:
        # Outside WMM2025's 5-year life span — extrapolate, warn once
        if not _warned_expiry:
            _warned_expiry = True
            log.warning("Magnetic declination: WMM2025 is outside its validity period "
                        "(year %.1f) — extrapolating; upgrade pygeomag for the next WMM", yr)
        return _model.calculate(glat=lat, glon=lon, alt=0.0, time=yr,
                                allow_date_outside_lifespan=True).d


def _corner(i: int, j: int) -> float:
    """Cached declination at grid corner (i*GRID_DEG, j*GRID_DEG). Lock held."""
    key = (i, j)
    v = _cache.get(key)
    if v is None:
        v = _model_decl(i * GRID_DEG, j * GRID_DEG)
        _cache[key] = v
    return v


def is_model_active() -> bool:
    """True when position-based (WMM) declination is in use."""
    with _lock:
        if _model_state == "unloaded":
            _load_model()
        return _model_state == "ok"


def declination(lat: float | None, lon: float | None, fallback: float) -> float:
    """
    Magnetic declination (degrees, east positive) at lat/lon.

    Returns `fallback` (Config.MAG_DECLINATION) when the position is unknown
    or the model is unavailable.
    """
    global _cache_built
    if lat is None or lon is None:
        return fallback
    with _lock:
        if _model_state == "unloaded":
            _load_model()
        if _model_state != "ok":
            return fallback
        now = time.time()
        if now - _cache_built > CACHE_REFRESH_SEC:
            _cache.clear()
            _cache_built = now
        try:
            x = lon / GRID_DEG
            y = lat / GRID_DEG
            i0, j0 = math.floor(y), math.floor(x)
            fy, fx = y - i0, x - j0
            d00 = _corner(i0,     j0)
            d01 = _corner(i0,     j0 + 1)
            d10 = _corner(i0 + 1, j0)
            d11 = _corner(i0 + 1, j0 + 1)
            return ((d00 * (1 - fx) + d01 * fx) * (1 - fy)
                    + (d10 * (1 - fx) + d11 * fx) * fy)
        except Exception as exc:
            log.debug("Declination lookup failed at %.3f,%.3f: %s", lat, lon, exc)
            return fallback
