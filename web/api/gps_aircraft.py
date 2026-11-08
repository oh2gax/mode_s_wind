"""
web/api/gps_aircraft.py — GPS history of one aircraft (or one type), from 2026-11-08

The GPS Aircraft page (/gps-aircraft) answers "how did GPS interference hit
this aircraft, day by day?": for an ICAO24 address, a registration, a
callsign or an ICAO type (e.g. AT75 for the whole fleet seen):

  • per UTC day: the flights seen in the receivers' coverage, the flights with
    a GPS degradation episode (gps_episodes, within GPS_EPISODE_RADIUS_NM of
    the airport), the degraded minutes, the lowest NACp / NIC, the episodes
    with a spoofing indicator — and, as the day's general level, the share
    of all aircraft (aircraft-hours, gps_quality_hours) with degradation;
  • the flights of the last HEIGHT_SERIES_DAYS (one per height_series visit,
    with its EFHK landing or departure) and their episodes.

The flights come from height_series (one row per aircraft's pass, kept
HEIGHT_SERIES_DAYS = 30 days).  So that the daily counts are kept longer, the
hourly jobs roll every completed day up into gps_aircraft_days
(rollup_days(), a few hundred small rows a day) before height_series is
purged.  Episodes are kept from 6 Oct 2026 (never auto-purged); for days
before the first flight counts only the episodes are known.

The overview of all traffic (overview(), from 2026-11-08) adds per day,
week, time of day, airline, type and aircraft, arrivals / departures (where
GPS came back or was lost), direction and altitude, the kinds of degradation
and the receivers' coverage.  A flight = the aircraft's passes (height_series,
via gps_flights) and its episodes of one callsign within VISIT_GAP_SEC — the
episodes count as passes because height_series has no row while GPS is lost.
gps_flights (each pass's entry / exit, kept FLIGHTS_DAYS) and gps_rx_days
(receiver minutes per day) are written by the hourly jobs.

Military, government and police aircraft and those with a privacy flag
(collector/aircraft_db.classify()) are never shown or counted here.
"""

from __future__ import annotations

import calendar
import json
import logging
import math
import re
import time
import zlib

log = logging.getLogger("modes.gps_aircraft")

VISIT_GAP_SEC = 1200       # height_series rows of one aircraft closer than this = one flight
MAX_EPISODES = 4000
MAX_FLIGHTS = 3000

_DDL = """CREATE TABLE IF NOT EXISTS gps_aircraft_days (
    day      TEXT    NOT NULL,      -- UTC day YYYY-MM-DD
    icao     TEXT    NOT NULL,
    flights  INTEGER NOT NULL,      -- passes (height_series rows merged within VISIT_GAP_SEC)
    seconds  INTEGER NOT NULL,      -- tracked time
    callsigns TEXT,                 -- up to 10, comma-separated
    PRIMARY KEY (day, icao)
)"""


def _special(icao: str) -> bool:
    """Military / government / police or privacy-flagged: never shown here."""
    try:
        from collector import aircraft_db
        info = aircraft_db.classify(icao)
    except Exception:
        return False
    return bool(info and (info.get("cls") or info.get("private")))


def _day(ts: float) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(ts))


def _day0(day: str) -> int:
    y, m, d = (int(x) for x in day.split("-"))
    return calendar.timegm((y, m, d, 0, 0, 0))


def _visits(rows):
    """height_series rows (icao, ts, t_end, callsign, alt_min, alt_max), sorted by
    icao, ts → flights: rows of one aircraft closer than VISIT_GAP_SEC (and with
    the same callsign, when both have one) are one flight."""
    out = []
    for icao, ts, te, cs, amin, amax in rows:
        f = out[-1] if out else None
        if (f and f["icao"] == icao and ts - f["t1"] < VISIT_GAP_SEC
                and (not cs or not f["callsign"] or cs == f["callsign"])):
            f["t1"] = max(f["t1"], te)
            f["callsign"] = f["callsign"] or cs
            if amin is not None:
                f["alt_min"] = amin if f["alt_min"] is None else min(f["alt_min"], amin)
            if amax is not None:
                f["alt_max"] = amax if f["alt_max"] is None else max(f["alt_max"], amax)
        else:
            out.append({"icao": icao, "t0": ts, "t1": te, "callsign": cs,
                        "alt_min": amin, "alt_max": amax})
    return out


# ── Daily roll-up (hourly jobs, run.py) ─────────────────────────────────────

def _drop_partial_first(db) -> None:
    """The first roll-up (8 Nov 2026) also wrote the partial first day of
    height_series; drop the earliest rolled day when it has under 60 % of the
    next day's flights."""
    r = db.execute("""SELECT day, SUM(flights) FROM gps_aircraft_days
                      GROUP BY day ORDER BY day LIMIT 2""").fetchall()
    if len(r) == 2 and r[1][1] and r[0][1] < 0.6 * r[1][1] \
            and _day0(r[1][0]) - _day0(r[0][0]) == 86400:
        db.execute("DELETE FROM gps_aircraft_days WHERE day = ?", (r[0][0],))
        db.commit()


def rollup_days(db, max_days: int = 60) -> int:
    """Roll the flights of every completed UTC day still in height_series up
    into gps_aircraft_days (days already there are skipped).  Returns the
    number of days written."""
    db.execute(_DDL)
    row = db.execute("SELECT MIN(ts) FROM height_series").fetchone()
    if not row or row[0] is None:
        return 0
    first = _day0(_day(row[0]))
    if row[0] - first > 900:                # height_series starts mid-day: that day is partial
        first += 86400
    today = _day0(_day(time.time()))
    _drop_partial_first(db)
    done = 0
    t = max(first, today - max_days * 86400)
    while t < today and done < max_days:
        day = _day(t)
        if db.execute("SELECT 1 FROM gps_aircraft_days WHERE day = ? LIMIT 1", (day,)).fetchone() is None:
            rows = db.execute(
                """SELECT icao, ts, t_end, callsign, alt_min, alt_max FROM height_series
                   WHERE ts >= ? AND ts < ? ORDER BY icao, ts""", (t, t + 86400)).fetchall()
            agg = {}
            for f in _visits(rows):
                if _special(f["icao"]):
                    continue
                a = agg.setdefault(f["icao"], {"n": 0, "s": 0, "cs": []})
                a["n"] += 1
                a["s"] += int(max(0, f["t1"] - f["t0"]))
                if f["callsign"] and f["callsign"] not in a["cs"] and len(a["cs"]) < 10:
                    a["cs"].append(f["callsign"])
            if agg:
                db.executemany(
                    "INSERT OR REPLACE INTO gps_aircraft_days (day, icao, flights, seconds, callsigns) VALUES (?,?,?,?,?)",
                    [(day, i, a["n"], a["s"], ",".join(a["cs"])) for i, a in agg.items()])
                db.commit()
                done += 1
        t += 86400
    return done


# ── Per-pass geometry (gps_flights) and receiver days (gps_rx_days), from 2026-11-08 ──
#
# The overview's direction, altitude and arrival / departure parts need where
# each pass entered and left the coverage.  height_series has the positions
# but is kept only 30 days and is costly to decode, so the hourly jobs store
# a short row per pass (flights_update(), ~500 rows a day, kept FLIGHTS_DAYS).
# The receivers' minutes up per day come from msg_stats_rx_hours (kept 7 days)
# into gps_rx_days (rx_days_update(), one row per receiver and day).

FLIGHTS_DAYS = 400
ARR_DEP_NM = 10.0          # a pass ending / starting this close to the airport …
ARR_DEP_FT = 4000          # … at or below this altitude is an arrival / departure

_DDL_FLIGHTS = """CREATE TABLE IF NOT EXISTS gps_flights (
    hs_id    INTEGER PRIMARY KEY,   -- height_series.id
    ts       REAL    NOT NULL,      -- first row of the pass
    t_end    REAL    NOT NULL,
    icao     TEXT    NOT NULL,
    callsign TEXT,
    alt_min  INTEGER,
    alt_max  INTEGER,
    b_in     INTEGER,               -- bearing (deg) from the airport of the first position
    d_in     REAL,                  -- its distance (NM)
    alt_in   INTEGER,
    b_out    INTEGER,               -- the last position
    d_out    REAL,
    alt_out  INTEGER,
    d_min    REAL                   -- closest distance to the airport
)"""
_DDL_FLIGHTS_IX = "CREATE INDEX IF NOT EXISTS idx_gps_flights_ts ON gps_flights(ts)"
_DDL_RX = """CREATE TABLE IF NOT EXISTS gps_rx_days (
    day      TEXT    NOT NULL,
    rx       TEXT    NOT NULL,      -- receiver id (MODES-RX-01 …)
    minutes  INTEGER NOT NULL,      -- minutes with messages that UTC day
    PRIMARY KEY (day, rx)
)"""


def _bearing_nm(lat0, lon0, lat, lon):
    """Initial bearing (deg) and great-circle distance (NM) from (lat0, lon0)."""
    p0, p1 = math.radians(lat0), math.radians(lat)
    dl = math.radians(lon - lon0)
    y = math.sin(dl) * math.cos(p1)
    x = math.cos(p0) * math.sin(p1) - math.sin(p0) * math.cos(p1) * math.cos(dl)
    b = (math.degrees(math.atan2(y, x)) + 360) % 360
    a = math.sin((p1 - p0) / 2) ** 2 + math.cos(p0) * math.cos(p1) * math.sin(dl / 2) ** 2
    return b, 3440.065 * 2 * math.asin(min(1.0, math.sqrt(a)))


def _geo(row, apt) -> dict | None:
    """One height_series row (id, ts, t_end, icao, callsign, alt_min, alt_max, data)
    → its gps_flights row as a dict (None for special aircraft or no positions)."""
    hid, ts, te, icao, cs, amin, amax, blob = row
    if _special(icao):
        return None
    from collector.height_series import decode
    try:
        d = decode(blob)
    except Exception:
        return None
    lat, lon, alt = d.get("lat") or [], d.get("lon") or [], d.get("alt") or []
    pts = [(la, lo, alt[i] if i < len(alt) else None) for i, (la, lo) in enumerate(zip(lat, lon))
           if la is not None and lo is not None]
    if not pts:
        return None
    alts = [a for a in alt if a is not None]
    b_in, d_in = _bearing_nm(apt[0], apt[1], pts[0][0], pts[0][1])
    b_out, d_out = _bearing_nm(apt[0], apt[1], pts[-1][0], pts[-1][1])
    step = max(1, len(pts) // 400)
    d_min = min(_bearing_nm(apt[0], apt[1], p[0], p[1])[1] for p in pts[::step] + [pts[-1]])
    return {"hs_id": hid, "ts": ts, "t_end": te, "icao": icao, "callsign": cs,
            "alt_min": amin, "alt_max": amax,
            "b_in": round(b_in), "d_in": round(d_in, 1), "alt_in": int(alts[0]) if alts else None,
            "b_out": round(b_out), "d_out": round(d_out, 1), "alt_out": int(alts[-1]) if alts else None,
            "d_min": round(d_min, 1)}


_GEO_COLS = ("hs_id", "ts", "t_end", "icao", "callsign", "alt_min", "alt_max",
             "b_in", "d_in", "alt_in", "b_out", "d_out", "alt_out", "d_min")


def flights_update(db, apt, max_rows: int = 20000) -> int:
    """Store the passes of height_series not yet in gps_flights (the first call
    back-fills all of height_series) and purge rows older than FLIGHTS_DAYS.
    Returns the number of rows written."""
    db.execute(_DDL_FLIGHTS)
    db.execute(_DDL_FLIGHTS_IX)
    last = db.execute("SELECT COALESCE(MAX(hs_id), 0) FROM gps_flights").fetchone()[0]
    rows = db.execute("""SELECT id, ts, t_end, icao, callsign, alt_min, alt_max, data FROM height_series
                         WHERE id > ? ORDER BY id LIMIT ?""", (last, max_rows)).fetchall()
    out = [g for g in (_geo(tuple(r), apt) for r in rows) if g]
    if out:
        db.executemany(f"INSERT OR REPLACE INTO gps_flights ({', '.join(_GEO_COLS)}) "
                       f"VALUES ({_qmarks(len(_GEO_COLS))})", [tuple(g[c] for c in _GEO_COLS) for g in out])
    db.execute("DELETE FROM gps_flights WHERE ts < ?", (time.time() - FLIGHTS_DAYS * 86400,))
    db.commit()
    return len(out)


def _flight_rows(db, t_from: float, apt) -> list[dict]:
    """gps_flights rows from t_from, plus the newest height_series rows not
    stored yet (decoded here, not written)."""
    db.execute(_DDL_FLIGHTS)
    rows = [dict(zip(_GEO_COLS, r)) for r in db.execute(
        f"SELECT {', '.join(_GEO_COLS)} FROM gps_flights WHERE ts >= ?", (t_from,)).fetchall()]
    last = db.execute("SELECT COALESCE(MAX(hs_id), 0) FROM gps_flights").fetchone()[0]
    if apt:
        for r in db.execute("""SELECT id, ts, t_end, icao, callsign, alt_min, alt_max, data FROM height_series
                               WHERE id > ? AND ts >= ? ORDER BY id LIMIT 3000""", (last, t_from)).fetchall():
            g = _geo(tuple(r), apt)
            if g:
                rows.append(g)
    return rows


def _rx_minutes(blob) -> int:
    """Minutes with messages in one msg_stats_rx_hours record."""
    try:
        d = json.loads(zlib.decompress(blob))
    except Exception:
        return 0
    mins = {int(m[0] // 60) for m in d.get("trend") or () if len(m) > 1 and m[0] and (m[1] or 0) > 0}
    return min(60, len(mins))


def rx_days_update(db) -> int:
    """Roll the receivers' completed days still in msg_stats_rx_hours up into
    gps_rx_days (days already there are skipped; the partial first day of the
    7-day store is left out).  Returns the number of days written."""
    db.execute(_DDL_RX)
    try:
        t_min = db.execute("SELECT MIN(ts) FROM msg_stats_rx_hours").fetchone()[0]
    except Exception:
        return 0
    if t_min is None:
        return 0
    first = _day0(_day(t_min)) + (86400 if t_min % 86400 else 0)
    today = _day0(_day(time.time()))
    done = 0
    for t in range(first, today, 86400):
        day = _day(t)
        if db.execute("SELECT 1 FROM gps_rx_days WHERE day = ? LIMIT 1", (day,)).fetchone():
            continue
        mins = {}
        for rx, blob in db.execute("SELECT rx, data FROM msg_stats_rx_hours WHERE ts >= ? AND ts < ?",
                                   (t, t + 86400)).fetchall():
            mins[rx] = mins.get(rx, 0) + _rx_minutes(blob)
        if mins:
            db.executemany("INSERT OR REPLACE INTO gps_rx_days (day, rx, minutes) VALUES (?,?,?)",
                           [(day, rx, m) for rx, m in mins.items()])
            done += 1
    db.commit()
    return done


_COV_CACHE: dict = {}


def coverage(db, t_from: float) -> dict:
    """Receiver coverage per UTC day from t_from: {"rx": {rx: {day: minutes}},
    "hours": {day: hours with GPS-quality data}, "gaps": {day: [text, …]}}.
    A receiver counts from its first day with messages; a day where one had
    under 23 h (today: under the time so far, less 1 h), or with under 23 h
    of data in all (before the per-receiver days), is a gap."""
    now = time.time()
    key = int(t_from)
    hit = _COV_CACHE.get(key)
    if hit and now - hit[0] < 300:
        return hit[1]
    rx: dict = {}
    try:
        db.execute(_DDL_RX)
        for day, r, m in db.execute("SELECT day, rx, minutes FROM gps_rx_days WHERE day >= ?",
                                    (_day(t_from),)).fetchall():
            rx.setdefault(r, {})[day] = m
        rolled = {d for v in rx.values() for d in v}
        for r, ts, blob in db.execute("SELECT rx, ts, data FROM msg_stats_rx_hours WHERE ts >= ?",
                                      (max(t_from, now - 3 * 86400),)).fetchall():
            day = _day(ts)
            if day in rolled:
                continue
            rx.setdefault(r, {})
            rx[r][day] = rx[r].get(day, 0) + _rx_minutes(blob)
    except Exception as exc:
        log.debug("coverage: %s", exc)
    hours = {d: n for d, n in db.execute(
        """SELECT date(ts, 'unixepoch'), COUNT(*) FROM gps_quality_hours
           WHERE ts >= ? AND total > 0 GROUP BY 1""", (t_from,)).fetchall()}
    today = _day(now)
    so_far = (now - _day0(today)) / 60
    gaps: dict = {}
    for r, days in rx.items():
        if not days:
            continue
        d0 = min(d for d, m in days.items() if m > 0) if any(days.values()) else None
        if d0 is None:
            continue
        t = _day0(d0)
        while t <= _day0(today):
            d = _day(t)
            m = days.get(d, 0)
            need = 1380 if d != today else max(0, so_far - 60)
            if m < need:
                gaps.setdefault(d, []).append(f"{r} {m // 60} h {m % 60:02d} min")
            t += 86400
    first_rx = min((d for v in rx.values() for d in v), default=None)
    t = _day0(_day(t_from))
    while t < _day0(today):
        d = _day(t)
        if (first_rx is None or d < first_rx) and hours.get(d, 0) < 23:
            gaps.setdefault(d, []).append(f"data {hours.get(d, 0)} h")
        t += 86400
    out = {"rx": rx, "hours": hours, "gaps": gaps, "rx_from": first_rx}
    if len(_COV_CACHE) > 20:
        _COV_CACHE.clear()
    _COV_CACHE[key] = (now, out)
    return out


# ── Search ──────────────────────────────────────────────────────────────────

_HEX = re.compile(r"^[0-9A-F]{6}$")
_TYPE = re.compile(r"^[A-Z][A-Z0-9]{1,3}$")


def resolve(db, q: str) -> dict:
    """The aircraft that the query means: {"kind": "icao"|"reg"|"callsign"|"type",
    "icaos": [...], "label": str}.  ICAO24 (6 hex digits), a registration
    (with a dash, or found in the aircraft database / the episodes), a
    callsign (letters + digits), or an ICAO type (AT75, A320 …)."""
    q = (q or "").strip().upper()
    if not q:
        return {"kind": None, "icaos": [], "label": ""}
    found: list[str] = []

    def add(rows):
        for r in rows:
            i = (r[0] or "").upper()
            if i and i not in found:
                found.append(i)

    if _HEX.match(q):
        add([(q,)])
        kind = "icao"
    else:
        kind = None
        # registration
        if "-" in q or len(q) >= 5:
            add(db.execute("SELECT DISTINCT icao FROM gps_episodes WHERE UPPER(registration) = ?", (q,)).fetchall())
            add(db.execute("SELECT DISTINCT icao FROM approach_history WHERE UPPER(registration) = ?", (q,)).fetchall())
            try:
                from collector import aircraft_db
                if not found:
                    add([(i,) for i in aircraft_db.icaos_for_reg(q, limit=5)])
            except Exception:
                pass
            if found:
                kind = "reg"
        # ICAO type
        if not found and _TYPE.match(q):
            for t in ("gps_episodes", "approach_history", "departure_profiles"):
                add(db.execute(f"SELECT DISTINCT icao FROM {t} WHERE UPPER(aircraft_type) = ?", (q,)).fetchall())
            if found:
                kind = "type"
        # callsign
        if not found:
            add(db.execute("SELECT DISTINCT icao FROM gps_episodes WHERE UPPER(callsign) = ? LIMIT 50", (q,)).fetchall())
            add(db.execute("SELECT DISTINCT icao FROM height_series WHERE UPPER(callsign) = ? LIMIT 50", (q,)).fetchall())
            if found:
                kind = "callsign"
    icaos = [i for i in found if not _special(i)]
    return {"kind": kind, "icaos": icaos, "label": q}


def _info(db, icaos):
    """Registration and type of each aircraft from the newest row that has them."""
    out = {}
    for i in icaos:
        reg = typ = None
        for t, ts in (("gps_episodes", "t_start"), ("approach_history", "ts"), ("departure_profiles", "ts")):
            r = db.execute(f"""SELECT registration, aircraft_type FROM {t} WHERE icao = ?
                               AND (registration IS NOT NULL OR aircraft_type IS NOT NULL)
                               ORDER BY {ts} DESC LIMIT 1""", (i,)).fetchone()
            if r:
                reg = reg or r[0]
                typ = typ or r[1]
            if reg and typ:
                break
        out[i] = {"icao": i, "reg": reg, "type": typ}
    return out


# ── History ─────────────────────────────────────────────────────────────────

def _qmarks(n):
    return ",".join("?" * n)


def history(db, q: str, days: int = 30, radius_nm: float = 100.0, edge_nm: float = 130.0) -> dict:
    """The GPS history of the aircraft of the query over the last `days` days
    (0 = everything stored)."""
    res = resolve(db, q)
    icaos = res["icaos"][:200]
    now = time.time()
    if days:
        t_from = _day0(_day(now - (days - 1) * 86400))
    else:                                   # everything: from the first stored episode
        t_from = 0
    r = db.execute("SELECT MIN(t_start) FROM gps_episodes").fetchone()
    first_ep_day = _day0(_day(r[0])) if r and r[0] else _day0(_day(now))
    t_from = max(t_from, first_ep_day)      # no days before the episode log began
    base = {"query": res["label"], "kind": res["kind"], "days": days, "t_from": t_from,
            "aircraft": [], "day": [], "flights": [], "episodes": []}
    if not icaos:
        return base
    qm = _qmarks(len(icaos))
    info = _info(db, icaos)
    db.execute(_DDL)

    # episodes
    eps = [dict(r) for r in db.execute(
        f"""SELECT * FROM gps_episodes WHERE icao IN ({qm}) AND t_start >= ?
            ORDER BY t_start DESC LIMIT {MAX_EPISODES}""", (*icaos, t_from)).fetchall()]
    for e in eps:
        ec = e.get("end_reason")
        if ec == "lost" and (e.get("end_dist_nm") or 0) >= edge_nm:
            ec = "edge"
        e["end_class"] = ec
        e["start_edge"] = (e.get("start_dist_nm") or 0) >= radius_nm - 3.0

    # flights of the days still in height_series (one per pass)
    hs_first = db.execute("SELECT MIN(ts) FROM height_series").fetchone()[0] or now
    hs_day0 = _day0(_day(hs_first)) + 86400          # the first full day
    t_fl = max(t_from, hs_day0)
    rows = [dict(zip(("icao", "ts", "t_end", "callsign", "alt_min", "alt_max"), r)) for r in db.execute(
        f"""SELECT icao, ts, t_end, callsign, alt_min, alt_max FROM height_series
            WHERE icao IN ({qm}) AND ts >= ?""", (*icaos, t_fl)).fetchall()]
    # the episodes are passes too: while GPS is lost there is often no height_series row
    rows += [{"icao": e["icao"], "ts": e["t_start"], "t_end": e.get("t_end") or e["t_start"],
              "callsign": e.get("callsign"), "alt_min": e.get("min_alt"), "alt_max": e.get("max_alt"), "ep": e}
             for e in eps if e["t_start"] >= t_fl]
    flights = _flight_visits(rows)
    for f in flights:
        f["ep_list"] = f.pop("eps")
        for k in (*_GEO_KEYS, "kind"):
            f.pop(k, None)
    # EFHK landings / departures of these aircraft
    arr = db.execute(f"""SELECT icao, ts, runway FROM approach_history WHERE icao IN ({qm}) AND ts >= ?""",
                     (*icaos, max(t_from, hs_day0) - 3600)).fetchall()
    dep = db.execute(f"""SELECT icao, t_start FROM departure_profiles WHERE icao IN ({qm}) AND t_start >= ?""",
                     (*icaos, max(t_from, hs_day0) - 3600)).fetchall()
    by_ic = {}
    for e in eps:
        by_ic.setdefault(e["icao"], []).append(e)
    arr_ic, dep_ic = {}, {}
    for i, t, rw in arr:
        arr_ic.setdefault(i, []).append((t, rw))
    for i, t in dep:
        dep_ic.setdefault(i, []).append(t)
    for f in flights:
        ic = f["icao"]
        f["arr"] = next(({"t": t, "rwy": rw} for t, rw in arr_ic.get(ic, ())
                         if f["t0"] - 600 <= t <= f["t1"] + 1800), None)
        f["dep"] = next(({"t": t} for t in dep_ic.get(ic, ())
                         if f["t0"] - 1800 <= t <= f["t1"] + 600), None)
        mine = f.pop("ep_list")
        f["ep"] = [e["id"] for e in mine]
        f["deg_s"] = sum(e["duration_s"] or 0 for e in mine)
        f["reg"] = info[f["icao"]]["reg"]
        f["type"] = info[f["icao"]]["type"]
    flights.sort(key=lambda f: f["t0"], reverse=True)

    # per day
    per = {}

    def D(day):
        return per.setdefault(day, {"d": day, "flights": None, "deg_flights": 0, "episodes": 0,
                                    "deg_s": 0, "severe": 0, "spoof": 0, "nacp": None, "nic": None,
                                    "ac": set()})
    # flight counts: rolled-up days, then the days in height_series
    for day, n in db.execute(
            f"""SELECT day, SUM(flights) FROM gps_aircraft_days WHERE icao IN ({qm}) AND day >= ?
                GROUP BY day""", (*icaos, _day(t_from) if t_from else "0000")).fetchall():
        if _day0(day) < hs_day0:
            D(day)["flights"] = n
    seen_days = set()
    for f in flights:
        d = D(_day(f["t0"]))
        if d["d"] not in seen_days:
            d["flights"] = 0
            seen_days.add(d["d"])
        d["flights"] += 1
        if f["ep"]:
            d["deg_flights"] += 1
    for e in eps:
        d = D(_day(e["t_start"]))
        d["episodes"] += 1
        d["deg_s"] += e.get("duration_s") or 0
        d["severe"] += (e.get("severe_sweeps") or 0) * 5
        if e.get("spoof"):
            d["spoof"] += 1
        for k, c in (("nacp", "min_nacp"), ("nic", "min_nic")):
            v = e.get(c)
            if v is not None and (d[k] is None or v < d[k]):
                d[k] = v
        d["ac"].add((e["icao"], e.get("callsign")))
    # the day's general level: aircraft-hours with degradation, all traffic
    for day, deg, tot in db.execute(
            """SELECT date(ts, 'unixepoch'), SUM(degraded), SUM(total) FROM gps_quality_hours
               WHERE ts >= ? GROUP BY 1""", (t_from,)).fetchall():
        if tot:
            D(day)["all_share"] = round(deg / tot, 3)
    # days with flight counts (rolled up or in height_series): no row = no flights
    rolled_from = db.execute("SELECT MIN(day) FROM gps_aircraft_days").fetchone()[0]
    counted_from = min(x for x in (rolled_from, _day(hs_day0)) if x)
    for d in per.values():
        if d["flights"] is None and d["d"] >= counted_from:
            d["flights"] = 0
    for d in per.values():
        # flights with an episode: from the flights where known, at least the distinct
        # aircraft + callsign of the day's episodes (an episode outside a stored pass)
        d["deg_flights"] = max(d["deg_flights"], len(d["ac"])) if d["flights"] is not None else len(d["ac"])
        if d["flights"] is not None:
            d["flights"] = max(d["flights"], d["deg_flights"])
        d.pop("ac")
    out_days = sorted(per.values(), key=lambda d: d["d"])
    if t_from:
        out_days = [d for d in out_days if _day0(d["d"]) >= t_from]
    # aircraft list with totals
    n_ep = {}
    for e in eps:
        n_ep[e["icao"]] = n_ep.get(e["icao"], 0) + 1
    n_fl = {}
    for f in flights:
        n_fl[f["icao"]] = n_fl.get(f["icao"], 0) + 1
    ac = sorted(({**info[i], "episodes": n_ep.get(i, 0), "flights": n_fl.get(i, 0)} for i in icaos),
                key=lambda a: (-a["episodes"], a["reg"] or a["icao"]))
    first_ep = db.execute("SELECT MIN(t_start) FROM gps_episodes").fetchone()[0]
    return {**base, "aircraft": ac, "day": out_days, "flights": flights[:MAX_FLIGHTS],
            "episodes": eps, "flights_from": _day(hs_day0),
            "rolled_from": rolled_from, "counted_from": counted_from,
            "episodes_from": _day(first_ep) if first_ep else None,
            "radius_nm": radius_nm, "edge_nm": edge_nm, "coverage": coverage(db, t_from)}


# ── Overview of all traffic (from 2026-11-08 morning) ───────────────────────

_AIRLINE = re.compile(r"^([A-Z]{3})\d")


def _airline(cs: str | None) -> str:
    """The ICAO airline code of a callsign (FIN123 → FIN); others → "other"."""
    m = _AIRLINE.match((cs or "").strip().upper())
    return m.group(1) if m else "other"


def _types(db, icaos) -> dict:
    """ICAO type and registration of each aircraft: the newest landing,
    departure or episode that has them, else the aircraft database."""
    out = {}
    for sql in ("SELECT icao, aircraft_type, registration FROM approach_history WHERE aircraft_type IS NOT NULL GROUP BY icao",
                "SELECT icao, aircraft_type, registration FROM departure_profiles WHERE aircraft_type IS NOT NULL GROUP BY icao",
                "SELECT icao, aircraft_type, registration FROM gps_episodes WHERE aircraft_type IS NOT NULL GROUP BY icao"):
        try:
            for i, t, r in db.execute(sql):
                i = (i or "").upper()
                if i in icaos and i not in out and t:
                    out[i] = (t.upper(), r)
        except Exception:
            pass
    try:
        from collector import aircraft_db
        for i in icaos:
            if i not in out:
                reg, typ = aircraft_db.lookup(i)
                if typ:
                    out[i] = (typ, reg)
    except Exception:
        pass
    return out


def _in_hours(ts: float, h0: int, h1: int) -> bool:
    """UTC hour of ts within [h0, h1) — wrapping past midnight when h0 > h1."""
    if h0 == h1:
        return True
    h = time.gmtime(ts).tm_hour
    return h0 <= h < h1 if h0 < h1 else (h >= h0 or h < h1)


_OV_CACHE: dict = {}
OV_CACHE_SEC = 300


def overview(db, days: int = 30, h0: int = 0, h1: int = 0, min_flights: int = 10,
             airline: str = "", apt=None) -> dict:
    """overview_calc() cached for OV_CACHE_SEC (the numbers change slowly)."""
    key = (days, h0 % 24, h1 % 24, min_flights, airline)
    hit = _OV_CACHE.get(key)
    if hit and time.time() - hit[0] < OV_CACHE_SEC:
        return hit[1]
    out = overview_calc(db, days, h0, h1, min_flights, airline, apt)
    if len(_OV_CACHE) > 40:
        _OV_CACHE.clear()
    _OV_CACHE[key] = (time.time(), out)
    return out


SECTORS = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")
ALT_BANDS = ((0, 5000, "< 5 000 ft"), (5000, 10000, "5 000 ft – FL100"), (10000, 20000, "FL100–200"),
             (20000, 30000, "FL200–300"), (30000, 99999, "FL300 +"))
DIST_BINS = 11             # 0–10, 10–20 … 90–100, 100+ NM
NEAR_NM = 30.0             # arrivals: GPS back within this distance = "late"


def _sector(b) -> int | None:
    return None if b is None else int(((b + 22.5) % 360) // 45)


def _band(a) -> int | None:
    if a is None:
        return None
    for i, (lo, hi, _) in enumerate(ALT_BANDS):
        if lo <= a < hi:
            return i
    return len(ALT_BANDS) - 1


def _ep_kind(sig: str | None) -> str:
    """Episode class: 'lost' (the aircraft's own ADS-B position stopped), 'acc'
    (NACp / NIC reduced), 'gap' (gaps / frozen position only)."""
    s = set((sig or "").split(","))
    if "adsb_loss" in s:
        return "lost"
    if s & {"nacp", "nic"}:
        return "acc"
    return "gap"


_GEO_KEYS = ("d_min", "b_in", "d_in", "alt_in", "b_out", "d_out", "alt_out")


def _ep_row(e: dict, apt) -> dict:
    """An episode as a pass row for _flight_visits: its start as the entry, its
    end (or recovery) position as the exit."""
    r = {"icao": e["icao"], "ts": e["t_start"], "t_end": e.get("t_end") or e["t_start"] + (e.get("duration_s") or 0),
         "callsign": e.get("callsign"), "alt_min": e.get("min_alt"), "alt_max": e.get("max_alt"), "ep": e}
    for k in _GEO_KEYS:
        r[k] = None
    r["d_in"], r["alt_in"] = e.get("start_dist_nm"), e.get("start_alt")
    r["d_out"], r["alt_out"] = e.get("end_dist_nm"), e.get("end_alt")
    if apt:
        for pre, lat, lon in (("in", "start_lat", "start_lon"), ("out", "end_lat", "end_lon")):
            if e.get(lat) is not None and e.get(lon) is not None:
                b, d = _bearing_nm(apt[0], apt[1], e[lat], e[lon])
                r["b_" + pre], r["d_" + pre] = round(b), round(d, 1)
    ds = [d for d in (r["d_in"], r["d_out"]) if d is not None]
    r["d_min"] = min(ds) if ds else None
    return r


def _flight_visits(rows):
    """Pass rows (dicts: icao, ts, t_end, callsign, alt_min, alt_max and,
    optionally, the geometry of gps_flights and "ep" = an episode) → flights:
    rows of one aircraft closer than VISIT_GAP_SEC with the same callsign (when
    both have one) merged.  Episodes are rows too: while GPS is lost an
    aircraft often has no height_series row (no GNSS height), so a pass may
    start or even consist only of its episodes.  The entry is the first row's,
    the exit the one of the row that ends last; f["eps"] = the episodes."""
    rows.sort(key=lambda r: (r["icao"], r["ts"]))
    out = []
    for r in rows:
        f = out[-1] if out else None
        cs = r.get("callsign")
        if (f and f["icao"] == r["icao"] and r["ts"] - f["t1"] < VISIT_GAP_SEC
                and (not cs or not f["callsign"] or cs == f["callsign"])):
            if r.get("d_out") is not None and r["t_end"] >= f["t1"]:
                f.update(b_out=r.get("b_out"), d_out=r["d_out"], alt_out=r.get("alt_out"))
            f["t1"] = max(f["t1"], r["t_end"])
            f["callsign"] = f["callsign"] or cs
            for k, fn in (("alt_min", min), ("alt_max", max), ("d_min", min)):
                if r.get(k) is not None:
                    f[k] = r[k] if f[k] is None else fn(f[k], r[k])
            if f["b_in"] is None and f["d_in"] is None and r.get("d_in") is not None:
                f.update(b_in=r.get("b_in"), d_in=r["d_in"], alt_in=r.get("alt_in"))
        else:
            f = {"icao": r["icao"], "t0": r["ts"], "t1": r["t_end"], "callsign": cs,
                 "alt_min": r.get("alt_min"), "alt_max": r.get("alt_max"), "eps": []}
            for k in _GEO_KEYS:
                f[k] = r.get(k)
            out.append(f)
        if r.get("ep"):
            f["eps"].append(r["ep"])
    for f in out:
        arr = f["d_out"] is not None and f["d_out"] <= ARR_DEP_NM and (f["alt_out"] or 99999) <= ARR_DEP_FT
        dep = f["d_in"] is not None and f["d_in"] <= ARR_DEP_NM and (f["alt_in"] or 99999) <= ARR_DEP_FT
        f["kind"] = "loc" if arr and dep else "arr" if arr else "dep" if dep else "ovf"
        f["eps"].sort(key=lambda e: e["t_start"])
    return out


def overview_calc(db, days: int = 30, h0: int = 0, h1: int = 0, min_flights: int = 10,
                  airline: str = "", apt=None) -> dict:
    """All traffic (military / government / police left out) over the last
    `days` days (0 = all), optionally only the flights and episodes that
    started between UTC hours h0 and h1, and of one airline (callsign prefix,
    or "other"): the key figures, per day, a weekday × hour matrix, arrivals
    (where GPS came back) and departures (where it was lost), the share
    degraded by direction and by altitude, the kinds of degradation, the
    receivers' coverage, and tables by ICAO type, by airline and the most
    affected aircraft (at least min_flights flights)."""
    now = time.time()
    db.execute(_DDL)
    db.execute(_DDL_FLIGHTS)
    airline = (airline or "").upper()
    r = db.execute("SELECT MIN(t_start) FROM gps_episodes").fetchone()
    first_ep_day = _day0(_day(r[0])) if r and r[0] else _day0(_day(now))
    t_from = _day0(_day(now - (days - 1) * 86400)) if days else 0
    t_from = max(t_from, first_ep_day)
    # flights with times: gps_flights (from its first full day; else height_series')
    fg_first = db.execute("SELECT MIN(ts) FROM gps_flights").fetchone()[0] \
        or db.execute("SELECT MIN(ts) FROM height_series").fetchone()[0] or now
    fl_day0 = _day0(_day(fg_first)) + (86400 if fg_first - _day0(_day(fg_first)) > 900 else 0)
    hours = (h0 % 24, h1 % 24) if h0 != h1 else (0, 0)
    if hours != (0, 0):                     # hours need each flight's time
        t_from = max(t_from, fl_day0)
    special = {}

    def spec(i):
        if i not in special:
            special[i] = _special(i)
        return special[i]

    def al_ok(cs):
        return not airline or _airline(cs) == airline

    eps_all = [dict(x) for x in db.execute(
        """SELECT id, icao, callsign, aircraft_type, t_start, t_end, duration_s, spoof, min_nacp, min_nic,
                  signals, end_reason, min_alt, max_alt, start_lat, start_lon, start_dist_nm, start_alt,
                  end_lat, end_lon, end_dist_nm, end_alt, rec_dist_nm, rec_alt
           FROM gps_episodes WHERE t_start >= ?""", (t_from,)).fetchall()]
    eps_all = [e for e in eps_all if not spec(e["icao"])]
    t_fl = max(t_from, fl_day0)
    rows = [r for r in _flight_rows(db, t_fl, apt) if not spec(r["icao"])]
    rows += [_ep_row(e, apt) for e in eps_all if e["t_start"] >= t_fl]
    all_fl = [f for f in _flight_visits(rows) if _in_hours(f["t0"], *hours)]
    al_count: dict = {}
    for f in all_fl:
        k = _airline(f["callsign"])
        al_count[k] = al_count.get(k, 0) + 1
    flights = [f for f in all_fl if al_ok(f["callsign"])]
    eps = [e for e in eps_all if _in_hours(e["t_start"], *hours) and al_ok(e["callsign"])]

    counted_from = min((d for d in (db.execute("SELECT MIN(day) FROM gps_aircraft_days").fetchone()[0],
                                    _day(fl_day0)) if d), default=_day(fl_day0))
    if hours != (0, 0):
        counted_from = max(counted_from, _day(fl_day0))

    # one record per (day, aircraft); per flight: arrival / departure / direction / altitude
    rec = {}

    def R(day, icao):
        return rec.setdefault((day, icao), {"flights": 0, "deg": 0, "deg_s": 0, "eps": 0, "spoof": 0,
                                            "cs": None, "seen": set(), "known": False})
    heat = [[{"n": 0, "d": 0} for _ in range(24)] for _ in range(7)]      # [weekday Mon=0][hour]
    rose = {k: [{"n": 0, "d": 0} for _ in SECTORS] for k in ("arr", "dep", "ovf")}
    alt = [{"n": 0, "d": 0, "ep": 0} for _ in ALT_BANDS]
    arr = {"n": 0, "deg": 0, "clean": 0, "far": 0, "near": 0, "low": 0, "lost": 0,
           "dist": [0] * DIST_BINS, "rd": [], "ra": [], "sec": [{"n": 0, "low": 0, "rd": []} for _ in SECTORS]}
    dep = {"n": 0, "deg": 0, "dist": [0] * DIST_BINS, "ld": [], "la": []}
    arr_day: dict = {}
    for f in flights:
        day = _day(f["t0"])
        x = R(day, f["icao"])
        x["known"] = True
        x["flights"] += 1
        x["cs"] = x["cs"] or f["callsign"]
        mine = f["eps"]
        tm = time.gmtime(f["t0"])
        dg = 1 if mine else 0
        heat[tm.tm_wday][tm.tm_hour]["n"] += 1
        heat[tm.tm_wday][tm.tm_hour]["d"] += dg
        if mine:
            x["deg"] += 1
        k = f["kind"]
        s = _sector(f["b_out"] if k == "dep" else f["b_in"])
        if k in rose and s is not None:
            rose[k][s]["n"] += 1
            rose[k][s]["d"] += dg
        b = _band(f["alt_max"])
        if b is not None:
            alt[b]["n"] += 1
            alt[b]["d"] += dg
        if k == "arr":
            ad = arr_day.setdefault(day, {"d": day, "n": 0, "clean": 0, "far": 0, "near": 0, "low": 0})
            arr["n"] += 1
            ad["n"] += 1
            sec = arr["sec"][s] if s is not None else None
            if sec:
                sec["n"] += 1
            if not mine:
                arr["clean"] += 1
                ad["clean"] += 1
            else:
                arr["deg"] += 1
                last = mine[-1]
                if last["end_reason"] == "recovered":
                    dist = last["rec_dist_nm"] if last["rec_dist_nm"] is not None else last["end_dist_nm"]
                    a = last["rec_alt"] if last["rec_alt"] is not None else last["end_alt"]
                    c = "near" if dist is not None and dist <= NEAR_NM else "far"
                    arr[c] += 1
                    ad[c] += 1
                    if dist is not None:
                        arr["dist"][min(DIST_BINS - 1, int(dist // 10))] += 1
                        arr["rd"].append(dist)
                        if sec:
                            sec["rd"].append(dist)
                    if a is not None:
                        arr["ra"].append(a)
                elif last["end_reason"] == "below_min_alt":
                    arr["low"] += 1
                    ad["low"] += 1
                    if sec:
                        sec["low"] += 1
                else:
                    arr["lost"] += 1
                    ad["low"] += 1
        elif k == "dep":
            dep["n"] += 1
            if mine:
                dep["deg"] += 1
                e = mine[0]
                if e["start_dist_nm"] is not None:
                    dep["dist"][min(DIST_BINS - 1, int(e["start_dist_nm"] // 10))] += 1
                    dep["ld"].append(e["start_dist_nm"])
                if e["start_alt"] is not None:
                    dep["la"].append(e["start_alt"])
    # rolled-up days (before gps_flights; no hours there)
    if hours == (0, 0):
        for day, icao, n, cs in db.execute(
                "SELECT day, icao, flights, callsigns FROM gps_aircraft_days WHERE day >= ? AND day < ?",
                (_day(t_from), _day(fl_day0))).fetchall():
            c1 = (cs or "").split(",")[0] or None
            if spec(icao) or not al_ok(c1):
                continue
            x = R(day, icao)
            x["known"] = True
            x["flights"] += n
            x["cs"] = x["cs"] or c1
    kinds_day: dict = {}
    kinds_hour = [{"lost": 0, "acc": 0, "gap": 0, "spoof": 0} for _ in range(24)]
    spoof_kinds: dict = {}
    for e in eps:
        day = _day(e["t_start"])
        x = R(day, e["icao"])
        x["eps"] += 1
        x["deg_s"] += e["duration_s"] or 0
        x["spoof"] += 1 if e.get("spoof") else 0
        x["cs"] = x["cs"] or e.get("callsign")
        x["seen"].add(e.get("callsign"))
        kd = kinds_day.setdefault(day, {"d": day, "lost": 0, "acc": 0, "gap": 0, "spoof": 0})
        kh = kinds_hour[time.gmtime(e["t_start"]).tm_hour]
        k = _ep_kind(e["signals"])
        kd[k] += 1
        kh[k] += 1
        if e.get("spoof"):
            kd["spoof"] += 1
            kh["spoof"] += 1
            for s in e["spoof"].split(","):
                if s:
                    spoof_kinds[s] = spoof_kinds.get(s, 0) + 1
        b = _band(e["start_alt"])
        if b is not None and day >= counted_from:
            alt[b]["ep"] += 1
    for x in rec.values():
        x["deg"] = max(x["deg"], len(x["seen"])) if x["eps"] else x["deg"]
        x["flights"] = max(x["flights"], x["deg"])
        del x["seen"]

    icaos = {i for d, i in rec if d >= counted_from}
    types = _types(db, icaos)

    def agg(keyf):
        g = {}
        for (day, icao), x in rec.items():
            if day < counted_from:              # flights not counted: the shares would be too high
                continue
            k = keyf(icao, x)
            if k is None:
                continue
            a = g.setdefault(k, {"k": k, "ac": set(), "flights": 0, "deg": 0, "deg_s": 0, "eps": 0, "spoof": 0,
                                 "days": {}})
            a["ac"].add(icao)
            a["flights"] += x["flights"]
            a["deg"] += x["deg"]
            a["deg_s"] += x["deg_s"]
            a["eps"] += x["eps"]
            a["spoof"] += x["spoof"]
            dd = a["days"].setdefault(day, [0, 0])
            dd[0] += x["flights"]
            dd[1] += x["deg_s"]
        out = []
        for a in g.values():
            flown = [v for v in a["days"].values() if v[0]]
            heavy = sum(1 for n, s in flown if s / 60 / n >= 5)
            out.append({"k": a["k"], "aircraft": len(a["ac"]), "flights": a["flights"], "deg": a["deg"],
                        "deg_s": a["deg_s"], "episodes": a["eps"], "spoof": a["spoof"],
                        "days": len(flown), "heavy_days": heavy})
        return out

    by_type = [t for t in agg(lambda i, x: (types.get(i) or (None,))[0]) if t["flights"] >= min_flights]
    by_air = [t for t in agg(lambda i, x: _airline(x["cs"])) if t["flights"] >= min_flights]
    by_ac = agg(lambda i, x: i)
    for a in by_ac:
        t = types.get(a["k"]) or (None, None)
        a.update({"icao": a["k"], "type": t[0], "reg": t[1]})
    by_ac = [a for a in by_ac if a["flights"] >= min_flights]
    by_ac.sort(key=lambda a: (-(a["deg"] / a["flights"]), -a["deg_s"]))

    # per day (all traffic) and the GPS Quality page's aircraft-hour share
    per = {}
    for (day, icao), x in rec.items():
        d = per.setdefault(day, {"d": day, "flights": 0, "deg_flights": 0, "episodes": 0, "deg_s": 0, "spoof": 0})
        d["flights"] += x["flights"]
        d["deg_flights"] += x["deg"]
        d["episodes"] += x["eps"]
        d["deg_s"] += x["deg_s"]
        d["spoof"] += x["spoof"]
    if hours == (0, 0) and not airline:
        for day, deg, tot in db.execute(
                """SELECT date(ts, 'unixepoch'), SUM(degraded), SUM(total) FROM gps_quality_hours
                   WHERE ts >= ? GROUP BY 1""", (t_from,)).fetchall():
            if tot and day in per:
                per[day]["all_share"] = round(deg / tot, 3)
    for d in per.values():
        if d["d"] < counted_from:
            d["flights"] = None                 # only the flights with an episode are known

    def med(v):
        v = sorted(v)
        return None if not v else round(v[len(v) // 2] if len(v) % 2 else (v[len(v) // 2 - 1] + v[len(v) // 2]) / 2, 1)
    arrivals = {k: arr[k] for k in ("n", "deg", "clean", "far", "near", "low", "lost", "dist")}
    arrivals.update(rec_dist=med(arr["rd"]), rec_alt=med(arr["ra"]),
                    sectors=[{"n": s["n"], "low": s["low"], "rec_dist": med(s["rd"]), "rec_n": len(s["rd"])}
                             for s in arr["sec"]],
                    day=sorted(arr_day.values(), key=lambda d: d["d"]))
    departures = {"n": dep["n"], "deg": dep["deg"], "dist": dep["dist"],
                  "loss_dist": med(dep["ld"]), "loss_alt": med(dep["la"])}
    airlines_all = sorted(({"k": k, "flights": n} for k, n in al_count.items() if n >= 20 and k != "other"),
                          key=lambda a: -a["flights"])[:40]
    return {"days": days, "t_from": t_from, "h0": hours[0], "h1": hours[1], "min_flights": min_flights,
            "airline": airline, "airline_list": airlines_all,
            "counted_from": counted_from, "flights_from": _day(fl_day0),
            "times_from": _day(max(t_from, fl_day0)),
            "day": sorted(per.values(), key=lambda d: d["d"]), "heat": heat,
            "arrivals": arrivals, "departures": departures, "near_nm": NEAR_NM,
            "arr_dep_nm": ARR_DEP_NM, "arr_dep_ft": ARR_DEP_FT,
            "rose": rose, "sectors": SECTORS,
            "alt": [{"band": ALT_BANDS[i][2], **a} for i, a in enumerate(alt)],
            "kinds_day": sorted(kinds_day.values(), key=lambda d: d["d"]), "kinds_hour": kinds_hour,
            "spoof_kinds": spoof_kinds,
            "coverage": coverage(db, t_from),
            "types": by_type, "airlines": by_air, "aircraft": by_ac[:40],
            "n_aircraft": len(icaos), "untyped": sum(1 for i in icaos if i not in types)}
