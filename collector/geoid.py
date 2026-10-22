"""
geoid.py — EGM96 geoid height (undulation) over southern Finland and the
surrounding sea areas (from 2026-10-22).

The GNSS height that aircraft broadcast (the ADS-B "GNSS − baro" difference)
is measured from the WGS84 ellipsoid, while heights of pressure surfaces,
the radiosonde's heights and the standard atmosphere are above mean sea
level.  The difference is the geoid height N: about 17.9 m at EFHK,
19.1 m at Jokioinen and 14.9 m east of Kotka — it falls by about 3 m per
100 km towards the east here.  A constant part would be absorbed by the
height calibration, but the slope would show up as a false east–west
slope of the pressure surfaces (about 5 kt of false geostrophic wind) and,
over a 20–30 km climb, as a few tenths of a metre in a layer thickness.

    height above mean sea level = ellipsoidal (GNSS) height − N(lat, lon)

Grid: EGM96 at 5′ (1/12°) spacing, 57.5–65.5° N, 16–34° E, in centimetres
(sampled from the full EGM96 model, NGA/NASA, public domain), stored below
as zlib-compressed int16 values, each row delta-coded along longitude;
bilinear interpolation (within a few cm of the full model).  Outside the
grid the nearest edge value is used.  Pure Python, about 12 kB.
"""

from __future__ import annotations

import base64
import struct
import zlib

LAT0, LON0, STEP = 57.5, 16.0, 1.0 / 12.0
NLAT, NLON = 97, 217

_DATA = (
    "eNqFXTuIbGtWrr2rqvucrjMzjGAmgpnBpCKmJkZGJkZGJmYGhjqIyWjohIoIYqImYjAKouAwiDCBiIOBIHPvuefRXdWPer/2"
    "y6r9P9b3rbV2395UdZ8+1d2197fX+1tr/e3svrvvHvpjcTkeu6fu5XIsu/Xl2FyO7eXY9c/b/t+ry7G8vOL5cjz2xyIe4V/P"
    "8PPXn9x1h8txuhzny1H3R3M52sujuzy3/XP4qumP6vKKc3+cuuPlOPTH/nKEr67fu/626+uuPzW6fJSjyeWYjm5Gb0a3l8fb"
    "/nF9vv779vI/12N8eV15ffko/LWqP07930l/Zdc/dv3fS38z/cV0VPT+jv2r9uYnwivDuwxn3MazTGdax0f6v9Go64r+bIrL"
    "YxwfZf/v68f1Kv3V7KF7yIg99og991d8FRHbZLS2PV7ry+OlR+z62oTWPGP2nH8+/OS+f/+n+P4TXvL+u/xVG8+i7s/z+vpj"
    "vJbHeDWPdPXC7+oiYuMes5vLcRtRS8f1O9fvX/9/HM/+8mPx7giY4ZVPeIW7TRA49tiGey+gfIL3to8/nV6bzjeda7gvOzjT"
    "Jp4BXpMunk9hMCv7741Gf3ZBbN49OFc8SImgdv1qDRL2FGVq3uM1z3J2/Z8lyNieZKLK760BtDq484IUprv5mK8mX7Uqoh/O"
    "MZzfJGN208vVbZSvgFiQsesRzrztMavjvZGkeR+xQtwYNXlHSS4PGat9vqPSO0xoBSTCI51vk/FK16WOrxbMyv4do6z96Wwe"
    "JeSq3Z764yUituolap2xWvdoLXtEn3rEFhGtOSB+ldFl/EnUiVU+B5QwlrIGzkA0T7qf5Q6vsrTK+ZU9ZuOo/27yEdC6PoKM"
    "JcTCVUt3h4+Y1o5JKx/gQLSG8BrljyKi1pGc1VnaBOGkHccRtXFE7XuzZH8eexSesx1KmKUjfCfYryfSh4hY+A1BJ27i+bJO"
    "rDNenh1rs5YImFVZ2k7ZgvDvsXdksGjTjF34HCSwzJYsIcaWbJ/14Q4wY9wEI3w+OPowvb8ivsMi3i3p7yfUGkKsiTKZXs+Y"
    "/f7sKUrWc0TrucclYZZwSlglbZhs17y3f/MopY8Rr2Uvl0EnHrIeO4PGFp0o+p11fLiadZTNKsuooNXEn0p3bwmojSNCeKS7"
    "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"
    "Mvp/ljLAww=="
)

_grid: list | None = None


def _load() -> list:
    global _grid
    if _grid is None:
        raw = zlib.decompress(base64.b64decode("".join(_DATA)))
        vals = struct.unpack("<%dh" % (NLAT * NLON), raw)
        rows = []
        for i in range(NLAT):
            acc, row = 0, []
            for d in vals[i * NLON:(i + 1) * NLON]:
                acc += d
                row.append(acc / 100.0)
            rows.append(row)
        _grid = rows
    return _grid


def undulation(lat: float, lon: float) -> float:
    """EGM96 geoid height N (m) at (lat, lon): ellipsoidal − mean-sea-level height."""
    g = _load()
    fi = min(NLAT - 1.000001, max(0.0, (lat - LAT0) / STEP))
    fj = min(NLON - 1.000001, max(0.0, (lon - LON0) / STEP))
    i, j = int(fi), int(fj)
    a, b = fi - i, fj - j
    return (g[i][j] * (1 - a) * (1 - b) + g[i + 1][j] * a * (1 - b)
            + g[i][j + 1] * (1 - a) * b + g[i + 1][j + 1] * a * b)
