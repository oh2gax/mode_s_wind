"""
Radiosonde profiles from FMI open data (Jokioinen) for comparison with the
Mode S area profile on the Skew-T diagrams.

A background thread fetches each new sounding of the station once it appears
in the FMI open data (launches at 00, 06 and 12 UTC, occasionally an extra one;
published about 1.5–2.5 h after launch) and stores it as one small gzipped
JSON file in data/soundings/ (`<station>_<YYYYMMDDHH>.json.gz`, 5–20 kB).
Files older than SONDE_KEEP_DAYS (default 365) are deleted.  Nothing is
written to the database; a few HTTPS requests and about four file writes a
day.

FMI WFS stored query fmi::observations::weather::sounding::multipointcoverage
(parameters place, starttime, endtime; without times the latest sounding).
The XML is read with the standard library.  Each level: latitude, longitude,
altitude (m), time, pressure, wind speed / direction, temperature, dew point.
Only the ascending part is kept, thinned to the levels needed for drawing
(about every 3 hPa plus the turning points of the temperature and dew point
curves).  Many FMI open-data profiles stop early (00 UTC flights usually near
350 hPa); the stored record keeps the lowest pressure reached (`min_p`), and
the diagram labels such profiles as partial.

Quality check (quality_cut, applied when a sounding is stored and when a
stored file is read): FMI open-data profiles sometimes have a data gap after
which the temperature is wrong — e.g. 12 Oct 2026 00 UTC: no data from 519 to
422 hPa (1.5 km), the temperature unchanged across the gap (−23.5 → −23.6 °C)
and the part above about 11 K too warm.  A profile is cut at a gap of at least
QC_GAP_HPA hPa (QC_GAP_M m) when the air below the gap cools with height (lapse
rate ≥ QC_MIN_LAPSE K/km over the last ~800 m) so that at least QC_MIN_EXPECT_K
of cooling is expected across the gap, but the temperature changes by less
than QC_FLAT_K, and the air above the gap again cools by at least
QC_MIN_LAPSE_ABOVE K/km (or less than 300 m of data is left above).  Gaps at
the tropopause (isothermal above or below) are kept.  The record then gets "qc" = {cut_p, gap, dropped, reason}.

Data: Finnish Meteorological Institute open data, CC BY 4.0.

Optional config keys (read with defaults):
  SONDE_FETCH = True            fetch and store soundings
  SONDE_PLACE = "Jokioinen"     FMI sounding station (place name)
  SONDE_KEEP_DAYS = 365         days to keep the files (0 = never delete)
  SONDE_DIR = "data/soundings"  folder (default next to the database)
"""

from __future__ import annotations

import gzip
import json
import logging
import math
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import Optional

log = logging.getLogger("modes.sondes")

BASE_URL = "https://opendata.fmi.fi/wfs"
QUERY = "fmi::observations::weather::sounding::multipointcoverage"
NS = {
    "wfs": "http://www.opengis.net/wfs/2.0",
    "gml": "http://www.opengis.net/gml/3.2",
    "gmlcov": "http://www.opengis.net/gmlcov/1.0",
    "swe": "http://www.opengis.net/swe/2.0",
    "ows": "http://www.opengis.net/ows/1.1",
}
CS_WMO = "http://xml.fmi.fi/namespace/locationcode/wmo"
CS_NAME = "http://xml.fmi.fi/namespace/locationcode/name"
FIELDS = {"PAP_PT1S_AVG": "p", "WSP_PT1S_AVG": "ws", "WDP_PT1S_AVG": "wd",
          "TAP_PT1S_AVG": "t", "TDP_PT1S_AVG": "td"}
KT_PER_MS = 1.943844

CHECK_SEC = 20 * 60          # check interval while a sounding is due
PUBLISH_DELAY_SEC = 80 * 60  # a sounding is looked for from launch + 80 min
DUE_WINDOW_SEC = 8 * 3600    # … until 8 h after its nominal time
BACKFILL_HOURS = 48          # on start: fill gaps of the last two days
LAUNCH_HOURS = (0, 6, 12)    # regular Jokioinen launches (no 18 UTC)

# Quality check (see quality_cut)
QC_GAP_HPA = 25.0            # a data gap: at least this many hPa …
QC_GAP_M = 500.0             # … or metres between two stored levels
QC_MIN_LAPSE = 5.0           # K/km cooling over the ~800 m below the gap
QC_MIN_EXPECT_K = 5.0        # cooling expected across the gap at that rate
QC_FLAT_K = 1.5              # … but the temperature changes less than this
QC_MIN_LAPSE_ABOVE = 4.0     # K/km cooling over ≤ 800 m above the gap (troposphere)


class FmiError(Exception):
    """FMI answered with an error (ExceptionReport / HTTP 4xx)."""


# ── Parsing ──────────────────────────────────────────────────────────────

def _t(s: Optional[str]) -> Optional[float]:
    if not s:
        return None
    return datetime.strptime(s.strip(), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()


def _nums(text: Optional[str]) -> list:
    out = []
    for v in (text or "").split():
        try:
            f = float(v)
        except ValueError:
            f = math.nan
        out.append(f if math.isfinite(f) else None)
    return out


def parse_soundings(xml_bytes: bytes) -> list:
    """FMI multipointcoverage XML → list of raw soundings
    {station, wmo, nominal, launch, end, lat, lon, levels: [dict]}."""
    root = ET.fromstring(xml_bytes)
    if root.tag.endswith("ExceptionReport"):
        raise FmiError(" | ".join(t.text or "" for t in root.iter(f"{{{NS['ows']}}}ExceptionText")))
    out = []
    for member in root.iter(f"{{{NS['wfs']}}}member"):
        s = {"station": None, "wmo": None}
        for name in member.iter(f"{{{NS['gml']}}}name"):
            cs = name.attrib.get("codeSpace")
            if cs == CS_WMO:
                s["wmo"] = name.text
            elif cs == CS_NAME:
                s["station"] = name.text
        s["nominal"] = _t(member.findtext(".//gml:timePosition", namespaces=NS))
        s["launch"] = _t(member.findtext(".//gml:beginPosition", namespaces=NS))
        s["end"] = _t(member.findtext(".//gml:endPosition", namespaces=NS))
        pos = _nums(member.findtext(".//gmlcov:positions", namespaces=NS))
        n = len(pos) // 4
        if n < 2 or s["nominal"] is None:
            continue
        data = _nums(member.findtext(".//gml:doubleOrNilReasonTupleList", namespaces=NS))
        names = [FIELDS.get(f.attrib.get("name"), f.attrib.get("name"))
                 for f in member.iter(f"{{{NS['swe']}}}field")]
        k = len(names)
        levels = []
        for i in range(n):
            lv = {"lat": pos[4 * i], "lon": pos[4 * i + 1], "z": pos[4 * i + 2]}
            row = data[i * k:(i + 1) * k] if k else []
            for j, nm in enumerate(names):
                lv[nm] = row[j] if j < len(row) else None
            levels.append(lv)
        s["levels"] = levels
        if levels:
            s["lat"], s["lon"] = levels[0]["lat"], levels[0]["lon"]
        out.append(s)
    return out


def _isa_alt_ft(p: float) -> float:
    """ISA pressure altitude (ft) of a pressure (hPa) — the Mode S scale."""
    return (1.0 - (p / 1013.25) ** 0.190263) * 145366.45


def compact(s: dict) -> Optional[dict]:
    """Raw sounding → stored record: ascending part only, thinned to about
    every 3 hPa plus the turning points of temperature and dew point."""
    rows = []
    last_p = None
    for lv in s["levels"]:
        p = lv.get("p")
        if p is None or p <= 0:
            continue
        if last_p is not None and p >= last_p:          # descent / repeat after burst
            continue
        rows.append(lv)
        last_p = p
    if len(rows) < 2:
        return None

    def val(lv, k):
        v = lv.get(k)
        return None if v is None else float(v)

    kept = [rows[0]]
    for i in range(1, len(rows) - 1):
        a, b, c = kept[-1], rows[i], rows[i + 1]
        dp = val(a, "p") - val(b, "p")
        turn = False
        for k, tol in (("t", 0.15), ("td", 0.5)):
            va, vb, vc = val(a, k), val(b, k), val(c, k)
            if None not in (va, vb, vc) and (vb - va) * (vc - vb) < 0 and abs(vb - va) >= tol:
                turn = True                               # local extreme: inversion base / top
        if dp >= 3.0 or (turn and dp >= 0.5):
            kept.append(b)
    kept.append(rows[-1])

    lv_out = []
    for lv in kept:
        p = val(lv, "p")
        ws = val(lv, "ws")
        wd = val(lv, "wd")
        t, td = val(lv, "t"), val(lv, "td")
        lv_out.append([round(p, 1), round(_isa_alt_ft(p)),
                       None if lv.get("z") is None else round(lv["z"]),
                       None if t is None else round(t, 1),
                       None if td is None else round(td, 1),
                       None if wd is None or ws is None else round(wd),
                       None if wd is None or ws is None else round(ws * KT_PER_MS, 1)])
    min_p = min(r[0] for r in lv_out)
    return quality_cut({
        "v": 1, "src": "FMI", "station": s.get("station"), "wmo": s.get("wmo"),
        "nominal": s["nominal"], "launch": s.get("launch") or s["nominal"], "end": s.get("end"),
        "lat": s.get("lat"), "lon": s.get("lon"),
        "n_raw": len(s["levels"]), "min_p": min_p,
        "cols": ["p", "alt_ft", "z_m", "t", "td", "wd", "ws_kt"],
        "lv": lv_out,
    })


def quality_cut(rec: dict) -> dict:
    """Cut the profile at the first data gap across which the temperature does
    not change although the air below cools with height (see module doc).
    Returns rec (changed in place: lv, min_p, qc).  Idempotent."""
    lv = rec.get("lv") or []

    def height(l):                                   # m: measured, else ISA
        return l[2] if l[2] is not None else l[1] * 0.3048

    for i in range(1, len(lv)):
        a, b = lv[i - 1], lv[i]
        if a[3] is None or b[3] is None:
            continue
        za, zb = height(a), height(b)
        if a[0] - b[0] < QC_GAP_HPA and zb - za < QC_GAP_M:
            continue
        # lapse rate over the ~800 m below the gap
        lo = None
        for j in range(i - 1, -1, -1):
            if lv[j][3] is not None and za - height(lv[j]) >= 800:
                lo = lv[j]
                break
        if lo is None or za - height(lo) > 2500:
            continue
        lapse = (lo[3] - a[3]) / ((za - height(lo)) / 1000.0)
        expect = lapse * (zb - za) / 1000.0
        if not (lapse >= QC_MIN_LAPSE and expect >= QC_MIN_EXPECT_K and abs(a[3] - b[3]) < QC_FLAT_K):
            continue
        # above the gap the air still cools like the troposphere: the flat step
        # is not an isothermal tropopause / stratosphere reached in the gap
        hi = None
        for j in range(i + 1, len(lv)):
            if lv[j][3] is not None and height(lv[j]) - zb >= 300:
                hi = lv[j]
                if height(lv[j]) - zb >= 800:
                    break
        if hi is None or (b[3] - hi[3]) / ((height(hi) - zb) / 1000.0) >= QC_MIN_LAPSE_ABOVE:
            rec["lv"] = lv[:i]
            rec["min_p"] = a[0]
            rec["qc"] = {"cut_p": a[0], "gap": [a[0], b[0]], "dropped": len(lv) - i,
                         "reason": (f"data gap {a[0]:.0f}–{b[0]:.0f} hPa without temperature change "
                                    f"({a[3]:.1f} → {b[3]:.1f} °C, about {expect:.0f} K cooling expected)")}
            return rec
    return rec


# ── Store ────────────────────────────────────────────────────────────────

class SondeStore:
    def __init__(self, folder: str, place: str = "Jokioinen", keep_days: float = 365,
                 base_url: str = BASE_URL, enabled: bool = True):
        self.folder = folder
        self.place = place
        self.prefix = re.sub(r"[^a-z0-9]+", "", place.lower()) or "sonde"
        self.keep_days = keep_days
        self.base_url = base_url
        self.enabled = enabled
        self._lock = threading.Lock()
        self._index: dict = {}          # key YYYYMMDDHH → meta (without levels)
        self.last_fetch = None          # (time, result text)
        self._scanned = False

    # files
    def _path(self, key: str) -> str:
        return os.path.join(self.folder, f"{self.prefix}_{key}.json.gz")

    @staticmethod
    def key_of(nominal: float) -> str:
        return datetime.fromtimestamp(nominal, timezone.utc).strftime("%Y%m%d%H")

    @staticmethod
    def _meta(rec: dict) -> dict:
        m = {k: rec.get(k) for k in ("station", "wmo", "nominal", "launch", "end", "min_p", "n_raw", "src")}
        m["n"] = len(rec.get("lv") or [])
        m["qc"] = (rec.get("qc") or {}).get("reason")
        return m

    def scan(self) -> None:
        """Build the index from the folder (once; later kept up to date)."""
        with self._lock:
            if self._scanned:
                return
            self._scanned = True
            if not os.path.isdir(self.folder):
                return
            for fn in os.listdir(self.folder):
                m = re.fullmatch(rf"{self.prefix}_(\d{{10}})\.json\.gz", fn)
                if not m:
                    continue
                try:
                    with gzip.open(os.path.join(self.folder, fn), "rt", encoding="utf-8") as f:
                        self._index[m.group(1)] = self._meta(quality_cut(json.load(f)))
                except Exception as exc:                    # noqa: BLE001
                    log.warning("Sonde file %s unreadable: %s", fn, exc)

    def keys(self) -> list:
        self.scan()
        with self._lock:
            return sorted(self._index)

    def items(self) -> list:
        """Metadata of the stored soundings, newest first."""
        self.scan()
        with self._lock:
            return [dict(self._index[k], key=k) for k in sorted(self._index, reverse=True)]

    def load(self, key: str) -> Optional[dict]:
        if not re.fullmatch(r"\d{10}", key or ""):
            return None
        try:
            with gzip.open(self._path(key), "rt", encoding="utf-8") as f:
                rec = quality_cut(json.load(f))      # also files stored before the check
            rec["key"] = key
            return rec
        except FileNotFoundError:
            return None

    def find(self, at: Optional[float] = None, max_age_h: float = 36) -> Optional[str]:
        """Key of the newest sounding launched at or before `at` (now when
        None) and at most max_age_h older."""
        at = time.time() if at is None else at
        for m in self.items():                             # newest first
            t0 = m.get("launch") or m.get("nominal")
            if t0 is not None and t0 <= at + 600:
                return m["key"] if at - t0 <= max_age_h * 3600 else None
        return None

    def save(self, rec: dict) -> bool:
        """Store a record unless the same sounding is already stored with as
        many levels.  Returns True when written."""
        key = self.key_of(rec["nominal"])
        self.scan()
        with self._lock:
            old = self._index.get(key)
            if old and (old.get("n_raw") or 0) >= rec.get("n_raw", 0):
                return False
            os.makedirs(self.folder, exist_ok=True)
            tmp = self._path(key) + ".tmp"
            with gzip.open(tmp, "wt", encoding="utf-8") as f:
                json.dump(rec, f, separators=(",", ":"))
            os.replace(tmp, self._path(key))
            self._index[key] = self._meta(rec)
        log.info("Sounding %s %s stored: %d levels to %.0f hPa%s%s", self.place, key,
                 len(rec["lv"]), rec["min_p"], " (updated)" if old else "",
                 f" — cut: {rec['qc']['reason']}" if rec.get("qc") else "")
        return True

    def prune(self) -> int:
        if not self.keep_days or self.keep_days <= 0:
            return 0
        cut = time.time() - self.keep_days * 86400
        n = 0
        for it in self.items():
            if (it.get("nominal") or 0) < cut:
                try:
                    os.remove(self._path(it["key"]))
                except FileNotFoundError:
                    pass
                with self._lock:
                    self._index.pop(it["key"], None)
                n += 1
        if n:
            log.info("Soundings older than %g days deleted: %d", self.keep_days, n)
        return n

    # network
    def _get(self, params: dict, timeout: float = 60) -> bytes:
        q = {"service": "WFS", "version": "2.0.0", "request": "getFeature",
             "storedquery_id": QUERY, "place": self.place}
        q.update(params)
        url = self.base_url + "?" + urllib.parse.urlencode(q, safe=":,")
        req = urllib.request.Request(url, headers={"User-Agent": "MODE-S-Wind/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as exc:
            body = exc.read()
            try:
                parse_soundings(body)
            except FmiError:
                raise
            except Exception:                              # noqa: BLE001
                pass
            raise FmiError(f"HTTP {exc.code}") if exc.code < 500 else ConnectionError(f"HTTP {exc.code}")

    def fetch(self, start: Optional[float] = None, end: Optional[float] = None,
              min_hours: float = 3) -> int:
        """Fetch the latest sounding (no times) or those in [start, end) and
        store new ones; a refused window is split.  Returns the number stored."""
        iso = lambda t: datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        params = {} if start is None else {"starttime": iso(start), "endtime": iso(end)}
        try:
            snds = parse_soundings(self._get(params))
        except FmiError as exc:
            if start is not None and end - start > min_hours * 3600:
                mid = start + (end - start) / 2
                return self.fetch(start, mid, min_hours) + self.fetch(mid, end, min_hours)
            log.warning("FMI refused the sounding request: %s", exc)
            return 0
        n = 0
        for s in snds:
            rec = compact(s)
            if rec and self.save(rec):
                n += 1
        return n

    # schedule
    @staticmethod
    def due_nominal(now: float) -> Optional[float]:
        """Nominal time of the newest regular launch that should be published
        by now (launch + PUBLISH_DELAY_SEC)."""
        day = now - now % 86400
        cands = [day + h * 3600 + d * 86400 for d in (-1, 0) for h in LAUNCH_HOURS]
        cands = [c for c in cands if c + PUBLISH_DELAY_SEC <= now]
        return max(cands) if cands else None

    def run(self) -> None:
        """Background loop: backfill the last two days once, then look for a
        due sounding every CHECK_SEC; prune once a day."""
        time.sleep(20)
        last_prune = 0.0
        try:
            now = time.time()
            n = self.fetch(now - BACKFILL_HOURS * 3600, now)
            self.last_fetch = (time.time(), f"backfill: {n} stored")
        except Exception as exc:                           # noqa: BLE001
            log.warning("Sounding backfill failed: %s", exc)
            self.last_fetch = (time.time(), f"backfill failed: {exc}")
        while True:
            now = time.time()
            if now - last_prune > 86400:
                try:
                    self.prune()
                except Exception as exc:                   # noqa: BLE001
                    log.warning("Sounding prune failed: %s", exc)
                last_prune = now
            due = self.due_nominal(now)
            if due is not None and now - due <= DUE_WINDOW_SEC and self.key_of(due) not in self.keys():
                try:
                    n = self.fetch()
                    self.last_fetch = (time.time(), f"latest: {n} stored")
                except Exception as exc:                   # noqa: BLE001
                    log.info("Sounding fetch failed (retry in %d min): %s", CHECK_SEC // 60, exc)
                    self.last_fetch = (time.time(), f"failed: {exc}")
            time.sleep(CHECK_SEC)


def levels_for_chart(rec: dict) -> list:
    """Stored record → level dicts in the Skew-T naming."""
    out = []
    for p, alt, z, t, td, wd, ws in rec.get("lv") or []:
        out.append({"pressure": p, "altitude": alt, "z_m": z, "temp": t, "dewpoint": td,
                    "wind_dir": wd, "wind_spd": ws})
    return out


_instance: Optional[SondeStore] = None


def init(cfg) -> SondeStore:
    """Create the store from the config (optional keys) — call once at start."""
    global _instance
    folder = getattr(cfg, "SONDE_DIR", None) or os.path.join(
        os.path.dirname(os.path.abspath(cfg.DB_PATH)), "soundings")
    _instance = SondeStore(folder, getattr(cfg, "SONDE_PLACE", "Jokioinen"),
                           float(getattr(cfg, "SONDE_KEEP_DAYS", 365)),
                           enabled=bool(getattr(cfg, "SONDE_FETCH", True)))
    return _instance


def get() -> Optional[SondeStore]:
    return _instance
