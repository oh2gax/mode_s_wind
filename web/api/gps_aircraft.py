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

Military, government and police aircraft and those with a privacy flag
(collector/aircraft_db.classify()) are never shown or counted here.
"""

from __future__ import annotations

import calendar
import logging
import re
import time

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

def rollup_days(db, max_days: int = 60) -> int:
    """Roll the flights of every completed UTC day still in height_series up
    into gps_aircraft_days (days already there are skipped).  Returns the
    number of days written."""
    db.execute(_DDL)
    row = db.execute("SELECT MIN(ts) FROM height_series").fetchone()
    if not row or row[0] is None:
        return 0
    first = _day0(_day(row[0]))
    today = _day0(_day(time.time()))
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
    rows = db.execute(
        f"""SELECT icao, ts, t_end, callsign, alt_min, alt_max FROM height_series
            WHERE icao IN ({qm}) AND ts >= ? ORDER BY icao, ts""", (*icaos, max(t_from, hs_day0))).fetchall()
    flights = _visits(rows)
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
        mine = [e for e in by_ic.get(ic, ()) if f["t0"] - 120 <= e["t_start"] <= f["t1"] + 120]
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
            "radius_nm": radius_nm, "edge_nm": edge_nm}
