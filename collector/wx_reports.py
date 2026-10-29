"""
collector/wx_reports.py — METAR archive and pilot reports (from 2026-10-29).

METAR archive (table metar_reports)
    Every METAR of the airport is stored once, with its full text and the
    parsed values: wind / gust / variation, visibility, present weather, the
    lowest cloud, temperature / dewpoint, QNH and the windshear group.  The
    live METARs come from the WX poll thread (web/app.py, NOAA, every
    10 min; only a new text is written, about 48 rows a day); the history is
    loaded from the Iowa Environmental Mesonet archive with
    tools/load_metar_history.py.  One row per station, observation time and
    correction (COR), so the two sources never duplicate.

    The windshear group (FMI: "Lentosääpalvelut Suomessa" §2.1.5) is only in
    the manual METARs: windshear reported during a landing or a take-off
    between the surface and 1600 ft AGL, "WS R22L" / "WS ALL RWY" (also seen
    as "WS RWY22L", "WS RWY 22L", after RMK).  Stored as "R22L" (several:
    "R22L R22R") or "ALL".  Finland publishes no SPECI (half-hourly METARs).

Pilot reports (table pilot_reports)
    ARS (special air-report: moderate / severe turbulence or icing, severe
    mountain wave, thunderstorm, volcanic ash, heavy sandstorm) and the
    national WXREP (pilot reports below the ARS criteria: light turbulence,
    light icing, light windshear, inversion, CB tops), with the SIGMETs of
    the same list, from the FMI aviation weather page ilmailusaa.fi
    ("Varoitukset" → SIGMET+ARS+WXREP, area Finland, the last 24 h).  Polled
    gently (PILOT_REPORTS_INTERVAL_MIN, default 30 min; one request per
    poll — the page keeps 24 h, so nothing is missed); each message stored
    once.  Parsed: kind, callsign or aircraft type, phenomena, position,
    place, heights, observation time and "near" = within PILOT_REPORTS_NEAR_NM
    (default 30 NM) of the airport or naming it, from the surface up to
    10 000 ft (or no height given).

Both tables are small (tens of kB a month) and are never purged.
"""

from __future__ import annotations

import calendar
import json
import logging
import math
import re
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

log = logging.getLogger("modes.wx_reports")

# ── METAR parsing ────────────────────────────────────────────────────────────

_WIND_RE = re.compile(r"\b(VRB|\d{3})(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)\b")
_TIME_RE = re.compile(r"\b(\d{2})(\d{2})(\d{2})Z\b")
_VAR_RE  = re.compile(r"\b(\d{3}V\d{3})\b")
_TT_RE   = re.compile(r"(?<![\w/])(M?\d{2})/(M?\d{2})?(?![\w/])")
_Q_RE    = re.compile(r"\bQ(\d{4})\b")
_A_RE    = re.compile(r"\bA(\d{4})\b")
_CLD_RE  = re.compile(r"\b(FEW|SCT|BKN|OVC|VV)(\d{3}|///)")
_WS_RE   = re.compile(r"\bWS\s+(ALL\s+RWY|(?:R(?:WY)?\s?\d{2}[LRC]?\s*)+)")
_WX_RE   = re.compile(r"^(?:[-+]|VC)?(?:MI|BC|PR|DR|BL|SH|TS|FZ)?"
                      r"(?:DZ|RA|SN|SG|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PO|SQ|FC|SS|DS)*$")
_TREND   = re.compile(r"\s(NOSIG|TEMPO|BECMG|RMK)\b")


def _f(v: str | None) -> float | None:
    if v is None:
        return None
    return -float(v[1:]) if v.startswith("M") else float(v)


def ws_group(text: str) -> str | None:
    """The windshear group of a METAR as "R22L" / "R22L R22R" / "ALL", or None."""
    out = []
    for m in _WS_RE.finditer(text or ""):
        g = m.group(1)
        if g.startswith("ALL"):
            return "ALL"
        for r in re.findall(r"R(?:WY)?\s?(\d{2}[LRC]?)", g):
            if "R" + r not in out:
                out.append("R" + r)
    return " ".join(out) or None


def parse_metar(text: str) -> dict | None:
    """Parse one METAR text (with or without the "METAR" / "SPECI" word).

    Returns {"station", "kind", "cor", "auto", "day", "hh", "mi", "wdir",
    "wspd", "wgst", "wvar", "vis", "wx", "cld", "tt", "td", "qnh", "ws",
    "raw"} or None when there is no station / time.  Speeds in kt.
    """
    raw = " ".join((text or "").replace("=", " ").split())
    if not raw:
        return None
    toks = raw.split()
    kind = "METAR"
    while toks and toks[0] in ("METAR", "SPECI", "COR"):
        if toks[0] == "SPECI":
            kind = "SPECI"
        toks = toks[1:]
    if not toks or not re.fullmatch(r"[A-Z]{4}", toks[0]):
        return None
    station = toks[0]
    tm = _TIME_RE.search(raw)
    if not tm:
        return None
    m = _TREND.search(raw)
    main = raw[:m.start()] if m else raw          # without the trend / remarks
    head = main.split()
    rec = {"station": station, "kind": kind, "raw": raw,
           "cor": 1 if re.search(r"\bCOR\b", raw[:40]) else 0,
           "auto": 1 if "AUTO" in head else 0,
           "day": int(tm.group(1)), "hh": int(tm.group(2)), "mi": int(tm.group(3)),
           "wdir": None, "wspd": None, "wgst": None, "wvar": None, "vis": None,
           "wx": None, "cld": None, "tt": None, "td": None, "qnh": None,
           "ws": ws_group(raw)}
    w = _WIND_RE.search(main)
    if w:
        k = 1.943844 if w.group(4) == "MPS" else 1.0
        rec["wdir"] = None if w.group(1) == "VRB" else int(w.group(1))
        rec["wspd"] = int(round(int(w.group(2)) * k))
        rec["wgst"] = int(round(int(w.group(3)) * k)) if w.group(3) else None
    v = _VAR_RE.search(main)
    rec["wvar"] = v.group(1) if v else None
    if "CAVOK" in head:
        rec["vis"], rec["cld"] = 9999, "CAVOK"
    else:
        for t in head[2:]:
            if re.fullmatch(r"\d{4}", t):
                rec["vis"] = int(t)
                break
    wx = [t for t in head[2:] if len(t) >= 2 and _WX_RE.match(t) and not re.fullmatch(r"\d+", t)
          and t not in ("AUTO", "COR", "NSC", "NCD", "CLR", "SKC") and not t.endswith("KT")]
    rec["wx"] = " ".join(wx) or None
    if rec["cld"] is None:
        cl = [(int(c.group(2)) if c.group(2) != "///" else 999, c.group(0)) for c in _CLD_RE.finditer(main)]
        if cl:
            rec["cld"] = min(cl)[1]
        else:
            for t in ("NSC", "NCD", "SKC", "CLR"):
                if t in head:
                    rec["cld"] = t
                    break
    tt = _TT_RE.search(main)
    if tt:
        rec["tt"], rec["td"] = _f(tt.group(1)), _f(tt.group(2))
    q = _Q_RE.search(main)
    if q:
        rec["qnh"] = float(q.group(1))
    else:
        a = _A_RE.search(main)
        if a:
            rec["qnh"] = round(int(a.group(1)) / 100 * 33.8639, 1)
    return rec


def obs_ts(day: int, hh: int, mi: int, ref: float | None = None) -> int | None:
    """Observation time of "DDHHMMZ" for a METAR received at ref (default
    now): this month, or the last month when the day is in the future."""
    g = time.gmtime(ref if ref is not None else time.time())
    y, mo = g.tm_year, g.tm_mon
    if day > g.tm_mday + 1:
        mo -= 1
        if mo == 0:
            y, mo = y - 1, 12
    try:
        return calendar.timegm((y, mo, day, hh, mi, 0, 0, 0, 0))
    except (OverflowError, ValueError):
        return None


_METAR_COLS = ("station", "ts", "kind", "cor", "auto", "raw", "src", "fetched",
               "wdir", "wspd", "wgst", "wvar", "vis", "wx", "cld", "tt", "td", "qnh", "ws")


def metar_row(rec: dict, ts: int, src: str, fetched: float) -> tuple:
    r = dict(rec, ts=int(ts), src=src, fetched=round(fetched, 1))
    return tuple(r.get(c) for c in _METAR_COLS)


def insert_metars(db, rows: list[tuple]) -> int:
    """INSERT OR IGNORE metar rows (metar_row tuples); returns the rows added."""
    if not rows:
        return 0
    before = db.total_changes
    db.executemany(f"INSERT OR IGNORE INTO metar_reports ({', '.join(_METAR_COLS)}) "
                   f"VALUES ({', '.join('?' * len(_METAR_COLS))})", rows)
    db.commit()
    return db.total_changes - before


_live_lock = threading.Lock()
_live_last: dict = {"raw": None}


def store_live_metar(text: str | None, station: str | None = None) -> bool:
    """Store a METAR from the WX poll thread (once per text).  Never raises."""
    try:
        if not text or text.startswith("["):
            return False
        with _live_lock:
            if text == _live_last["raw"]:
                return False
            rec = parse_metar(text)
            if not rec or (station and rec["station"] != station.upper()):
                return False
            now = time.time()
            ts = obs_ts(rec["day"], rec["hh"], rec["mi"], now)
            if ts is None or ts > now + 600:
                return False
            from database.db import get_db
            n = insert_metars(get_db(), [metar_row(rec, ts, "live", now)])
            _live_last["raw"] = text
            if n:
                log.debug("METAR stored: %s", rec["raw"])
                if rec["ws"]:
                    log.info("METAR windshear group: %s", rec["raw"])
            return bool(n)
    except Exception as exc:                    # storage must never stop the WX poll
        log.warning("METAR store failed: %s", exc)
        return False


# ── Pilot reports ────────────────────────────────────────────────────────────

ILMAILUSAA_URL = "https://ilmailusaa.fi/backend.php"
_KIND_RE  = re.compile(r"\b(ARS|WXREP|SIGMET|AIRMET|AIREP)\b")
_PHEN_RE  = re.compile(r"\b(?:(FBL|LGT|MOD|SEV|HVY)\s+)?"
                       r"(TURB|ICE|ICG|MTW|LLWS|WS|INVERSION|INV|TSGR|TS|VA|SS|CB|DS|RDOACT CLD)\b")
_POS_RE   = re.compile(r"\b([NS])(\d{2})(\d{2})?\s?([EW])(\d{3})(\d{2})?\b")
_FL_RE    = re.compile(r"\b(?:SFC|FL(\d{3}))\s*/\s*(?:FL)?(\d{3})\b|\bFL(\d{3})\b")
_FT_RE    = re.compile(r"\b(SFC|\d{3,5}\s?FT)\s*/\s*(SFC|\d{3,5}\s?FT)\b|\b(\d{3,5})\s?FT\b")
_OBS_RE   = re.compile(r"\bOBS\s+AT\s+(\d{2})(\d{2})Z\b|\bREP\s+(\d{2})(\d{2})\b")
_NEAR_TOP_FT = 10_000


def _nm(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    d = (math.sin((p2 - p1) / 2) ** 2 +
         math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 2 * 3440.065 * math.asin(min(1.0, math.sqrt(d)))


def parse_pilot_report(text: str, ts: int, apt: tuple | None = None, near_nm: float = 30.0) -> dict:
    """Parse one ARS / WXREP / SIGMET text (ts = the message time, UTC).

    apt = (icao, lat, lon) of the monitored airport for the "near" flag.
    """
    raw = " ".join((text or "").split())
    k = _KIND_RE.search(raw)
    kind = k.group(1) if k else "OTHER"
    rec = {"ts": int(ts), "kind": kind, "raw": raw, "ident": None, "phen": None, "place": None,
           "lat": None, "lon": None, "lo_ft": None, "hi_ft": None, "obs_ts": None, "near": 0}
    after = raw[k.end():].split() if k else []
    if kind == "ARS" and after:
        rec["ident"] = after[0]                       # callsign
    elif kind == "WXREP" and after:
        rec["ident"] = after[0]                       # aircraft type (or TWR / ACC)
        m = re.search(r"\bREP\s+\d{4}\s+(.*?)\s+(?:(?:FBL|LGT|MOD|SEV|HVY)\s+)?"
                      r"(?:TURB|ICE|ICG|MTW|LLWS|WS|INVERSION|INV|TSGR|TS|VA|SS|CB)\b", raw)
        if m:
            rec["place"] = m.group(1)[:40]
    ph = []
    for m in _PHEN_RE.finditer(raw):
        p = " ".join(x for x in m.groups() if x)
        if p not in ph:
            ph.append(p)
    rec["phen"] = ", ".join(ph) or None
    pos = _POS_RE.search(raw) if kind != "SIGMET" else None
    if pos:
        lat = int(pos.group(2)) + int(pos.group(3) or 0) / 60
        lon = int(pos.group(5)) + int(pos.group(6) or 0) / 60
        rec["lat"] = round(-lat if pos.group(1) == "S" else lat, 4)
        rec["lon"] = round(-lon if pos.group(4) == "W" else lon, 4)
    # heights (ft): "FL140/160", "SFC/FL080", "FL060/FL080", "1500FT", "SFC/2000FT"
    fl = _FL_RE.search(raw)
    ft = _FT_RE.search(raw)
    if ft and (not fl or ft.start() < fl.start()):
        if ft.group(2):
            a, b = (0 if x == "SFC" else int(re.sub(r"\D", "", x)) for x in (ft.group(1), ft.group(2)))
            rec["lo_ft"], rec["hi_ft"] = min(a, b), max(a, b)
        else:
            rec["lo_ft"] = rec["hi_ft"] = int(ft.group(3))
    elif fl:
        if fl.group(2):
            rec["lo_ft"] = int(fl.group(1)) * 100 if fl.group(1) else 0
            rec["hi_ft"] = int(fl.group(2)) * 100
        else:
            rec["lo_ft"] = rec["hi_ft"] = int(fl.group(3)) * 100
    o = _OBS_RE.search(raw)
    if o:
        hh, mi = (int(o.group(1)), int(o.group(2))) if o.group(1) else (int(o.group(3)), int(o.group(4)))
        if hh < 24 and mi < 60:
            d0 = ts - ts % 86400
            t = d0 + hh * 3600 + mi * 60
            if t > ts + 1800:
                t -= 86400
            rec["obs_ts"] = int(t)
    if apt and kind in ("ARS", "WXREP", "AIREP"):
        icao, alat, alon = apt
        close = (icao and re.search(rf"\b{re.escape(icao)}\b", raw) is not None) or \
                (rec["lat"] is not None and _nm(alat, alon, rec["lat"], rec["lon"]) <= near_nm)
        low = rec["lo_ft"] is None or rec["lo_ft"] <= _NEAR_TOP_FT
        rec["near"] = 1 if close and low else 0
    return rec


_PR_COLS = ("ts", "obs_ts", "kind", "raw", "src", "fetched", "ident", "phen", "place",
            "lat", "lon", "lo_ft", "hi_ft", "near")


def insert_pilot_reports(db, recs: list[dict], src: str, fetched: float) -> int:
    if not recs:
        return 0
    before = db.total_changes
    db.executemany(f"INSERT OR IGNORE INTO pilot_reports ({', '.join(_PR_COLS)}) "
                   f"VALUES ({', '.join('?' * len(_PR_COLS))})",
                   [tuple(dict(r, src=src, fetched=round(fetched, 1)).get(c) for c in _PR_COLS) for r in recs])
    db.commit()
    return db.total_changes - before


def _src_time(s: str | None) -> int | None:
    """"2026-10-28 16:18:00" (UTC) → Unix s."""
    try:
        return int(datetime.strptime((s or "")[:19], "%Y-%m-%d %H:%M:%S")
                   .replace(tzinfo=timezone.utc).timestamp())
    except ValueError:
        return None


def parse_ilmailusaa(obj) -> list[tuple[int, str]]:
    """The (time, text) pairs of a backend.php warnings24h answer."""
    out = []
    items = []
    hist = obj.get("selectedHistory") if isinstance(obj, dict) else None
    if isinstance(hist, dict):
        items += list(hist.values())
    cur = obj.get("selectedCurrent") if isinstance(obj, dict) else None
    if isinstance(cur, list):
        items += cur
    for it in items:
        if not isinstance(it, dict):
            continue
        txt = " ".join(str(it.get(k) or "") for k in ("p1", "p2")).strip()
        ts = _src_time(it.get("time")) or _src_time(it.get("created"))
        if not txt or ts is None or txt.lower().startswith("no warnings"):
            continue
        if (ts, txt) not in out:
            out.append((ts, txt))
    return out


class PilotReportPoller:
    """Background poller of the ilmailusaa.fi SIGMET + ARS + WXREP list."""

    def __init__(self, cfg):
        self.enabled = bool(getattr(cfg, "PILOT_REPORTS_FETCH", True))
        self.interval = max(15.0, float(getattr(cfg, "PILOT_REPORTS_INTERVAL_MIN", 30))) * 60
        self.near_nm = float(getattr(cfg, "PILOT_REPORTS_NEAR_NM", 30))
        self.apt = ((getattr(cfg, "AIRPORT_ICAO", "") or "").upper(),
                    float(getattr(cfg, "WINDSHEAR_AIRPORT_LAT", 60.3172)),
                    float(getattr(cfg, "WINDSHEAR_AIRPORT_LON", 24.9634)))
        self.status = {"last_try": 0.0, "last_ok": 0.0, "err": None, "got": 0, "new": 0}

    def fetch(self) -> list[tuple[int, str]]:
        q = {"mode": "warnings24h", "type": "sigmetars", "points": [{"_area": "1"}],
             "cache": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") +
                      f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"}
        # as the page itself sends it: the JSON in the query string, only the quotes encoded
        url = ILMAILUSAA_URL + "?" + urllib.parse.quote(json.dumps(q, separators=(",", ":")),
                                                         safe="{}[]:,_.-")
        req = urllib.request.Request(url, headers={
            "User-Agent": "MODE-S-Wind/1.0", "Accept": "application/json, text/javascript, */*",
            "Referer": "https://ilmailusaa.fi/warnings.html", "X-Requested-With": "XMLHttpRequest"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            return parse_ilmailusaa(json.loads(resp.read().decode("utf-8", errors="replace")))

    def poll_once(self) -> int:
        from database.db import get_db
        now = time.time()
        self.status["last_try"] = now
        pairs = self.fetch()
        recs = [parse_pilot_report(txt, ts, self.apt, self.near_nm) for ts, txt in pairs]
        n = insert_pilot_reports(get_db(), recs, "ilmailusaa", now)
        self.status.update(last_ok=now, err=None, got=len(recs), new=n)
        if n:
            log.info("Pilot reports: %d new (%d in the 24 h list)", n, len(recs))
        return n

    def run(self) -> None:
        time.sleep(90)                       # after the start-up rush
        fails = 0
        while True:
            try:
                self.poll_once()
                fails = 0
            except Exception as exc:
                fails += 1
                self.status["err"] = str(exc)[:120]
                (log.warning if fails in (1, 4) else log.debug)(
                    "Pilot report fetch failed (%d in a row): %s", fails, exc)
            # no fast retries (the site resets quick repeats): at the latest after 10 min
            time.sleep(self.interval if fails == 0 else min(self.interval, 600 * fails))


_poller: PilotReportPoller | None = None


def init_poller(cfg) -> PilotReportPoller:
    global _poller
    _poller = PilotReportPoller(cfg)
    return _poller


def poller() -> PilotReportPoller | None:
    return _poller


# ── Queries for the web pages ────────────────────────────────────────────────

def query(db, station: str, hours: float | None = 24, date: str | None = None,
          ws_only: bool = False, near_only: bool = False, limit: int = 2000) -> dict:
    """METARs and pilot reports for /api/wx/reports, newest first.

    hours: the last N hours (max 31 days); date "YYYY-MM-DD": that UTC day;
    ws_only: only the METARs with a windshear group — over the whole archive
    when neither hours nor date is given; near_only: only the pilot reports
    near the airport.
    """
    now = time.time()
    if date:
        d0 = calendar.timegm(time.strptime(date, "%Y-%m-%d"))
        t0, t1 = d0, d0 + 86400
    elif hours:
        t0, t1 = now - min(float(hours), 744.0) * 3600, now + 3600
    else:
        t0, t1 = 0, now + 3600
    limit = max(1, min(int(limit), 5000))
    sql = ("SELECT ts, kind, cor, auto, raw, src, wdir, wspd, wgst, wvar, vis, wx, cld, tt, td, qnh, ws "
           "FROM metar_reports WHERE station = ? AND ts >= ? AND ts < ?")
    if ws_only:
        sql += " AND ws IS NOT NULL"
    cur = db.execute(sql + " ORDER BY ts DESC, cor DESC LIMIT ?", (station, t0, t1, limit))
    cols = [c[0] for c in cur.description]
    metars = [dict(zip(cols, r)) for r in cur.fetchall()]
    rep_sql = ("SELECT ts, obs_ts, kind, raw, ident, phen, place, lat, lon, lo_ft, hi_ft, near "
               "FROM pilot_reports WHERE ts >= ? AND ts < ?")
    if near_only:
        rep_sql += " AND near = 1"
    cur = db.execute(rep_sql + " ORDER BY ts DESC LIMIT ?", (t0, t1, limit))
    cols = [c[0] for c in cur.description]
    reps = [dict(zip(cols, r)) for r in cur.fetchall()]
    info = db.execute("SELECT COUNT(*), MIN(ts), MAX(ts), SUM(ws IS NOT NULL) FROM metar_reports "
                      "WHERE station = ?", (station,)).fetchone()
    p = _poller
    return {"station": station, "t0": int(t0), "t1": int(min(t1, now)), "metars": metars, "reports": reps,
            "archive": {"n": info[0] or 0, "first": info[1], "last": info[2], "ws": info[3] or 0},
            "poll": None if p is None else {"enabled": p.enabled, "last_ok": p.status["last_ok"] or None,
                                            "err": p.status["err"], "interval_min": p.interval / 60}}
