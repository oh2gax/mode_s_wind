"""
web/api/radar.py — the FMI radar composite (rain rate) for the Live Map
weather overlay (from 2026-10-23).

FMI open data (CC BY 4.0): the national composite of the Finnish weather
radars, rain rate every 5 minutes (about 10 minutes after the scan).  The
download service (WFS stored query fmi::radar::composite::rr) lists the
composites of a period with a file reference each — a GeoTIFF in the
Finnish national grid ETRS-TM35FIN (EPSG:3067).  The reference is requested
at a quarter of its size, about 2 km per pixel (497 × 786 pixels, an
uncompressed 16-bit image of 0.8 MB: value × 0.01 = mm/h, 0 = no rain,
65535 = outside the radar coverage), so the Pi needs no image library.

Only on demand: the newest composite is fetched when a browser asks and at
most every 5 minutes (shared by all viewers, kept in memory, nothing written
to disk).  latest() returns the rainy cells only (sparse), the grid and the
time, and the radar coverage as runs of cells per row (so the page can tell
"dry" from "not seen" and, with Both on the Live Map, draw the model's rain
only outside the radar area); the page draws them itself (static/js/wx_layer.js).
"""

from __future__ import annotations

import array
import calendar
import html
import logging
import re
import struct
import sys
import threading
import time
import urllib.parse
import urllib.request

log = logging.getLogger("modes.web")

WFS = ("https://opendata.fmi.fi/wfs?service=WFS&version=2.0.0&request=getFeature"
       "&storedquery_id=fmi::radar::composite::rr&starttime={t0}&endtime={t1}")
SHRINK = 4                     # the file reference's width / height divided by this (≈ 2 km)
MIN_INTERVAL = 300             # s between looks for a newer composite
MIN_RAIN = 10                  # 0.1 mm/h (value × 0.01) — weaker echoes left out
UA = {"User-Agent": "MODE-S-Wind/1.0"}

_lock = threading.Lock()
_cache = {"checked": 0.0, "data": None, "error": None}


def _get(url: str, timeout: float = 40.0) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read()


def _newest_reference(now: float):
    t0 = time.strftime("%Y-%m-%dT%H:%M:00Z", time.gmtime(now - 45 * 60))
    t1 = time.strftime("%Y-%m-%dT%H:%M:00Z", time.gmtime(now + 300))
    xml = _get(WFS.format(t0=t0, t1=t1)).decode("utf-8", "replace")
    refs = [html.unescape(u) for u in re.findall(r"<gml:fileReference>([^<]+)</gml:fileReference>", xml)]
    best = None
    for u in refs:
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(u).query)
        t = (q.get("time") or [""])[0]
        if t and (best is None or t > best[0]):
            best = (t, u, q)
    return best


def _read_tiff16(b: bytes):
    """(width, height, array of uint16, row 0 = north) of an uncompressed
    16-bit single-band TIFF in strips."""
    bo = {b"MM": ">", b"II": "<"}.get(b[:2])
    if bo is None or struct.unpack(bo + "H", b[2:4])[0] != 42:
        raise ValueError("not a TIFF")
    ifd = struct.unpack(bo + "I", b[4:8])[0]
    n = struct.unpack(bo + "H", b[ifd:ifd + 2])[0]
    tags = {}
    size = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 16: 8}
    for k in range(n):
        e = ifd + 2 + 12 * k
        tag, typ, cnt = struct.unpack(bo + "HHI", b[e:e + 8])
        fmt = {3: "H", 4: "I"}.get(typ)
        nbytes = size.get(typ, 1) * cnt
        raw = b[e + 8:e + 12] if nbytes <= 4 else b[struct.unpack(bo + "I", b[e + 8:e + 12])[0]:][:nbytes]
        if fmt:
            tags[tag] = list(struct.unpack(bo + fmt * cnt, raw[:struct.calcsize(fmt) * cnt]))
    w, h = tags[256][0], tags[257][0]
    if tags.get(258, [16])[0] != 16 or tags.get(259, [1])[0] != 1 or tags.get(277, [1])[0] != 1:
        raise ValueError("unexpected TIFF layout (want uncompressed 16-bit, one band)")
    data = bytearray()
    for off, cnt in zip(tags[273], tags[279]):
        data += b[off:off + cnt]
    a = array.array("H")
    a.frombytes(bytes(data[:w * h * 2]))
    if (bo == ">") != (sys.byteorder == "big"):
        a.byteswap()
    if len(a) != w * h:
        raise ValueError("TIFF cut short")
    return w, h, a


def _fetch(now: float) -> dict:
    ref = _newest_reference(now)
    if not ref:
        raise ValueError("no radar composite listed for the last 45 min")
    t, url, q = ref
    if _cache["data"] and _cache["data"]["time"] == t:
        return _cache["data"]
    W = max(50, int(float(q["width"][0]) / SHRINK))
    H = max(50, int(float(q["height"][0]) / SHRINK))
    parts = urllib.parse.urlsplit(url)
    qs = {k: v[0] for k, v in q.items()}
    qs.update(width=str(W), height=str(H))
    body = _get(urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(qs, safe=":,/"))))
    w, h, a = _read_tiff16(body)
    x0, y0, x1, y1 = (float(v) for v in qs["bbox"].split(","))
    dx, dy = (x1 - x0) / w, (y1 - y0) / h
    # rows from the south (as the MEPS frames); rainy cells only: [index, value, …];
    # the radar coverage as runs of covered cells per row: [row, first, last, …]
    sparse = []
    cov = []
    covered = 0
    for j in range(h):
        row = a[(h - 1 - j) * w:(h - j) * w]
        base = j * w
        start = -1
        for i, v in enumerate(row):
            if v == 65535:
                if start >= 0:
                    cov += (j, start, i - 1)
                    start = -1
                continue
            if start < 0:
                start = i
            covered += 1
            if v >= MIN_RAIN:
                sparse.append(base + i)
                sparse.append(v)
        if start >= 0:
            cov += (j, start, w - 1)
    ts = calendar.timegm(time.strptime(t, "%Y-%m-%dT%H:%M:%SZ"))
    return {"time": t, "ts": ts,
            "grid": {"proj": "tm35fin", "x": [x0 + dx / 2, dx, w], "y": [y0 + dy / 2, dy, h]},
            "rs": sparse, "cov": cov, "covered": covered, "km": round(dx / 1000, 2),
            "source": "FMI radar composite (FMI open data, CC BY 4.0)"}


def latest(now: float = None) -> dict:
    """The newest composite (cached; a look for a newer one at most every 5 min)."""
    now = time.time() if now is None else now
    with _lock:
        if now - _cache["checked"] >= MIN_INTERVAL or (_cache["data"] is None and now - _cache["checked"] >= 60):
            _cache["checked"] = now
            try:
                _cache["data"] = _fetch(now)
                _cache["error"] = None
            except Exception as exc:                    # noqa: BLE001
                _cache["error"] = str(exc)
                log.warning("FMI radar: %s", exc)
        d = _cache["data"]
        out = dict(d) if d else {"ts": None}
        out["error"] = _cache["error"]
        if d:
            out["age_s"] = int(now - d["ts"])
        return out
