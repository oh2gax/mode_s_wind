"""
web/api/th_extra.py — the extras of the Time–height section of the Sounding
page (from 2026-11-10): everything the new colour fields and strips need that
is not in the hourly area profiles (/api/sounding/timeheight).

One answer for the shown period (the same ?hours= / ?end= as the section):

  "rwy"    runway in use, per UTC hour: [[ts, [[runway, landings], …],
           [[runway, departures], …]], …] — from approach_history.runway and
           the departures' windshear report ("rwy"); the most used first
  "metar"  the airport's METAR / SPECI reports: [[ts, visibility m, weather,
           ceiling ft AGL (lowest BKN / OVC / VV) or None, lowest cloud base
           ft AGL or None, CAVOK 0/1, wind dir, kt, gust], …]
  "gnss"   GNSS quality per hour (gps_quality_hours): [[ts, aircraft,
           aircraft with a degraded position], …]
  "turb"   turbulence 0–5 000 ft MSL per hour, from the EDR pieces of the
           landings and departures (collector/edr.py, edr_json "seg"):
           {"bin": 500, "hours": [[ts, [[band bottom ft, median EDR,
           strongest EDR, pieces, flights], …]], …]}
  "reps"   pilot reports and SIGMETs (pilot_reports): [[ts, kind, phenomenon,
           low ft, high ft, near 0/1, ident, raw], …]
  "meps"   the MEPS model (meps_ml_hours, area mean) at the centres of the
           section's layers, per hour: [[ts, [[layer bottom ft, T °C, u kt,
           v kt], …]], …] — the model value of the Mode S hour is the mean
           of the model hours at its start and end, as in the MEPS check.
           A comparison only: nothing in MODE-S Wind is computed from it
           here.
  "fc"     the MEPS forecast after the newest hour (meps_fc_hours, from each
           new run the area mean on the 10 pressure levels for +3 … +48 h;
           only when the period ends now): {"run", "cols": [[ts, lead h,
           [[layer bottom ft, T °C, u kt, v kt], …]], …]} — a display only
  "elev"   airport elevation ft (cloud bases are above the ground)

Read-only; every part is optional (an older database simply leaves it empty).
Cached for 2 minutes per (hours, end hour); a period that ended in the past
is cached until the cache is trimmed.  14 days read about 6 000 flights'
EDR pieces with a regular expression (no JSON decode): well under a second on
a Raspberry Pi 4.
"""

from __future__ import annotations

import json
import math
import re
import threading
import time

from collector.atmos import LAYER_EDGES, isa_pressure_hpa

TURB_BIN_FT = 500
TURB_TOP_FT = 5000
CACHE_SEC = 120.0
_cache: dict = {}
_lock = threading.Lock()

_SEG = re.compile(r'"e":\s*([0-9.]+),\s*"a":\s*\[\s*(-?\d+),\s*(-?\d+)\s*\]')
_RWY = re.compile(r'"rwy":\s*"([0-9]{2}[LRC]?)"')
_CLD = re.compile(r'\b(FEW|SCT|BKN|OVC|VV)(\d{3})(?:CB|TCU)?\b')


def _median(v: list) -> float:
    s = sorted(v)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2.0


def cloud_bases(raw: str | None) -> tuple:
    """(ceiling ft AGL or None, lowest base ft AGL or None, CAVOK) of a METAR.
    Only the report itself: the trend (BECMG / TEMPO) and the remarks are cut off."""
    if not raw:
        return None, None, False
    body = re.split(r'\b(?:BECMG|TEMPO|NOSIG|RMK)\b', raw, maxsplit=1)[0]
    if re.search(r'\bCAVOK\b', body):
        return None, None, True
    ceil = base = None
    for kind, h in _CLD.findall(body):
        ft = int(h) * 100
        base = ft if base is None else min(base, ft)
        if kind in ("BKN", "OVC", "VV"):
            ceil = ft if ceil is None else min(ceil, ft)
    return ceil, base, False


def _runways(db, t0: float, t1: float) -> list:
    hours: dict = {}
    try:
        for ts, rwy in db.execute(
                "SELECT ts, runway FROM approach_history WHERE ts >= ? AND ts < ?", (t0, t1)):
            if rwy:
                h = int(ts // 3600 * 3600)
                a = hours.setdefault(h, ({}, {}))[0]
                a[rwy] = a.get(rwy, 0) + 1
    except Exception:                                  # noqa: BLE001
        pass
    try:
        for ts, sj in db.execute(
                "SELECT ts, shear_json FROM departure_profiles WHERE ts >= ? AND ts < ? AND ga = 0",
                (t0, t1)):
            m = _RWY.search(sj or "")
            if m:
                h = int(ts // 3600 * 3600)
                d = hours.setdefault(h, ({}, {}))[1]
                d[m.group(1)] = d.get(m.group(1), 0) + 1
    except Exception:                                  # noqa: BLE001
        pass
    top = lambda d: sorted(d.items(), key=lambda kv: (-kv[1], kv[0]))[:3]
    return [[h, [list(x) for x in top(a)], [list(x) for x in top(d)]] for h, (a, d) in sorted(hours.items())]


def _metars(db, t0: float, t1: float, station: str) -> list:
    out = []
    try:
        rows = db.execute(
            """SELECT ts, vis, wx, raw, wdir, wspd, wgst FROM metar_reports
               WHERE station = ? AND ts >= ? AND ts < ? AND kind IN ('METAR', 'SPECI')
               ORDER BY ts""", (station, t0 - 3600, t1)).fetchall()
    except Exception:                                  # noqa: BLE001
        return out
    for ts, vis, wx, raw, wdir, wspd, wgst in rows:
        ceil, base, cavok = cloud_bases(raw)
        out.append([int(ts), vis, wx, ceil, base, 1 if cavok else 0, wdir, wspd, wgst])
    return out


def _gnss(db, t0: float, t1: float) -> list:
    try:
        return [[int(ts), tot or 0, deg or 0] for ts, tot, deg in db.execute(
            "SELECT ts, total, degraded FROM gps_quality_hours WHERE ts >= ? AND ts < ? ORDER BY ts",
            (t0, t1))]
    except Exception:                                  # noqa: BLE001
        return []


def _turbulence(db, t0: float, t1: float) -> dict:
    cells: dict = {}                                   # (hour, band) → [values], flights
    for sql in ("SELECT ts, edr_json FROM approach_history WHERE ts >= ? AND ts < ? AND edr_json IS NOT NULL",
                "SELECT ts, edr_json FROM departure_profiles WHERE ts >= ? AND ts < ? AND edr_json IS NOT NULL AND ga = 0"):
        try:
            rows = db.execute(sql, (t0, t1))
        except Exception:                              # noqa: BLE001
            continue
        for ts, ej in rows:
            h = int(ts // 3600 * 3600)
            seen = set()
            for e, a0, a1 in _SEG.findall(ej or ""):
                mid = (int(a0) + int(a1)) / 2.0
                if not 0 <= mid < TURB_TOP_FT:
                    continue
                b = int(mid // TURB_BIN_FT) * TURB_BIN_FT
                c = cells.setdefault((h, b), [[], 0])
                c[0].append(float(e))
                if b not in seen:
                    seen.add(b)
                    c[1] += 1
    hours: dict = {}
    for (h, b), (vals, nf) in cells.items():
        hours.setdefault(h, []).append([b, round(_median(vals), 3), round(max(vals), 3), len(vals), nf])
    return {"bin": TURB_BIN_FT, "top": TURB_TOP_FT,
            "hours": [[h, sorted(v)] for h, v in sorted(hours.items())]}


def _reports(db, t0: float, t1: float) -> list:
    try:
        rows = db.execute(
            """SELECT ts, obs_ts, kind, phen, lo_ft, hi_ft, near, ident, raw FROM pilot_reports
               WHERE COALESCE(obs_ts, ts) >= ? AND COALESCE(obs_ts, ts) < ? ORDER BY ts""", (t0, t1)).fetchall()
    except Exception:                                  # noqa: BLE001
        return []
    return [[int(o or t), k, ph, lo, hi, 1 if nr else 0, idn, raw] for t, o, k, ph, lo, hi, nr, idn, raw in rows]


_CEN = [(LAYER_EDGES[i] + LAYER_EDGES[i + 1]) / 2.0 for i in range(len(LAYER_EDGES) - 1)]
_LNP = [math.log(isa_pressure_hpa(z)) for z in _CEN]


def _to_layers(p: list, col: dict) -> list:
    """Model values (col: {"t", "u", "v"} per level) at the centres of the
    section's layers, ln p between the levels: [[layer bottom, T, u, v], …]."""
    lp = [math.log(x) if x else None for x in p]
    order = sorted((x, k) for k, x in enumerate(lp) if x is not None)       # top (small p) first
    lv = []
    for i, x in enumerate(_LNP):
        vals = []
        for key in ("t", "u", "v"):
            r = None
            c = col.get(key) or []
            for (xa, ka), (xb, kb) in zip(order, order[1:]):
                if xa <= x <= xb and xb > xa:
                    ya = c[ka] if ka < len(c) else None
                    yb = c[kb] if kb < len(c) else None
                    if ya is not None and yb is not None:
                        r = ya + (yb - ya) * (x - xa) / (xb - xa)
                    break
            vals.append(r)
        if vals[0] is not None or vals[1] is not None:
            lv.append([LAYER_EDGES[i], None if vals[0] is None else round(vals[0], 2),
                       None if vals[1] is None else round(vals[1], 1),
                       None if vals[2] is None else round(vals[2], 1)])
    return lv


def _meps(db, t0: float, t1: float) -> list:
    """The model's area mean at the layer centres (ln p between its levels)."""
    try:
        rows = {int(ts): json.loads(d).get("a") for ts, d in db.execute(
            "SELECT ts, data FROM meps_ml_hours WHERE ts >= ? AND ts <= ?", (t0, t1 + 3600))}
    except Exception:                                  # noqa: BLE001
        return []
    out = []
    for h in sorted(rows):
        if h >= t1:
            break
        a, b = rows.get(h), rows.get(h + 3600)
        if not a or not a.get("p"):
            continue
        same = bool(b) and b.get("p") == a["p"]
        col = {}
        for key in ("t", "u", "v"):
            va = a.get(key) or []
            vb = (b.get(key) or []) if same else []
            col[key] = [x if x is None or k >= len(vb) or vb[k] is None else (x + vb[k]) / 2.0
                        for k, x in enumerate(va)]
        lv = _to_layers(a["p"], col)
        if lv:
            out.append([h, lv])
    return out


FC_MAX_H = 48


def _forecast(db, t_from: float) -> dict:
    """The MEPS forecast profiles (meps_fc_hours, collector/meps.py
    fetch_forecast) for the hours from t_from on, at the layer centres:
    {"run": newest run, "cols": [[ts, lead, [[layer bottom, T, u, v], …]], …]}."""
    try:
        rows = db.execute("SELECT ts, run, lead, data FROM meps_fc_hours WHERE ts >= ? AND ts < ? ORDER BY ts",
                          (t_from, t_from + FC_MAX_H * 3600)).fetchall()
    except Exception:                                  # noqa: BLE001
        return {"run": None, "cols": []}
    cols, run = [], None
    for ts, r, lead, data in rows:
        try:
            d = json.loads(data)
        except (ValueError, TypeError):
            continue
        lv = _to_layers(d.get("p") or [], d.get("a") or {})
        if lv:
            cols.append([int(ts), lead, lv])
            run = max(run or 0, r)
    return {"run": run, "cols": cols}


def build(db, end_ts: float, hours: int, station: str = "EFHK", elev_ft: float = 0.0,
          now: float | None = None) -> dict:
    now = time.time() if now is None else now
    hours = max(6, min(int(hours), 24 * 14))
    end_hour = int(end_ts // 3600 * 3600)
    live = end_ts >= now - 900                       # the period reaches the present (a client clock a little behind too)
    t1 = end_hour + 3600 if live else end_hour          # the hour in progress too
    t0 = end_hour - hours * 3600
    key = (hours, end_hour, live)
    with _lock:
        c = _cache.get(key)
        if c and (not live or time.time() - c["at"] < CACHE_SEC):
            return c["data"]
    data = {
        "start_ts": t0, "end_ts": t1, "hours": hours, "elev": round(elev_ft),
        "rwy": _runways(db, t0, t1),
        "metar": _metars(db, t0, t1, station),
        "gnss": _gnss(db, t0, t1),
        "turb": _turbulence(db, t0, t1),
        "reps": _reports(db, t0, t1),
        "meps": _meps(db, t0, t1),
        # the model forecast continues the section only when it ends now
        "fc": _forecast(db, t1) if live else {"run": None, "cols": []},
    }
    with _lock:
        if len(_cache) > 16:
            _cache.clear()
        _cache[key] = {"at": time.time(), "data": data}
    return data


# ── Calendar view of the Sounding page (from 2026-11-10) ─────────────────────
CAL_MAX_DAYS = 120
CAL_WIND_LAYER = 2000          # the 2 000–3 000 ft layer of the hourly area profile
_EDR_M = re.compile(r'"m":\s*([0-9.]+)')
_cal_cache: dict = {}


def calendar(db, days: int, now: float | None = None) -> dict:
    """One value per UTC hour of the last `days` days for the Calendar view
    (one row per day, 24 columns):
      {"start": first day 00 UTC, "days", "keys": [...],
       "hours": [[ts, inversion K, inversion top ft, jet kt, jet ft,
                  wind kt at 2 000–3 000 ft, its direction, windshear reports,
                  flights with a windshear check, median EDR, flights with an
                  EDR, GNSS-degraded %, aircraft in the area profile], …]}
    (None where there is nothing).  Sources: bl_hours (inversion, low-level
    jet), profile_hours (wind, aircraft), the windshear reports and EDR of
    the landings and departures, gps_quality_hours.  Cached for 5 minutes."""
    now = time.time() if now is None else now
    days = max(7, min(int(days), CAL_MAX_DAYS))
    day0 = int(now // 86400) * 86400 - (days - 1) * 86400
    key = (days, int(now // 300))
    with _lock:
        c = _cal_cache.get(key)
        if c:
            return c
    H: dict = {}
    row = lambda ts: H.setdefault(int(ts // 3600 * 3600), [None] * 12)
    try:
        for ts, data in db.execute("SELECT ts, data FROM bl_hours WHERE ts >= ?", (day0,)):
            try:
                d = json.loads(data)
            except (ValueError, TypeError):
                continue
            r = row(ts)
            inv, llj = d.get("inv"), d.get("llj")
            if inv:
                r[0], r[1] = inv.get("dT"), inv.get("top")
            elif d.get("t"):
                r[0] = 0.0                              # flights, no inversion
            if llj:
                r[2], r[3] = llj.get("kt"), llj.get("ft")
            elif d.get("w"):
                r[2] = 0
    except Exception:                                  # noqa: BLE001
        pass
    try:
        for ts, data in db.execute("SELECT ts, data FROM profile_hours WHERE ts >= ?", (day0,)):
            try:
                d = json.loads(data)
            except (ValueError, TypeError):
                continue
            r = row(ts)
            r[11] = d.get("a")
            for lv in d.get("lv") or []:
                if lv and lv[0] == CAL_WIND_LAYER and len(lv) > 8 and lv[6] is not None and (lv[8] or 0) >= 3:
                    r[4], r[5] = round(lv[6]), None if lv[5] is None else round(lv[5])
                    break
    except Exception:                                  # noqa: BLE001
        pass
    for tbl, extra in (("approach_history", ""), ("departure_profiles", " AND ga = 0")):
        try:
            rows = db.execute(f"SELECT ts, shear_json, edr_json FROM {tbl} WHERE ts >= ?{extra}", (day0,))
        except Exception:                              # noqa: BLE001
            continue
        for ts, sj, ej in rows:
            r = row(ts)
            if sj:
                try:
                    lvl = (json.loads(sj) or {}).get("lvl") or "none"
                except (ValueError, TypeError):
                    lvl = None
                if lvl is not None:
                    r[7] = (r[7] or 0) + 1
                    if lvl != "none":
                        r[6] = (r[6] or 0) + 1
            m = _EDR_M.search(ej or "")
            if m:
                r[8] = (r[8] or []) + [float(m.group(1))]
    try:
        for ts, tot, deg in db.execute("SELECT ts, total, degraded FROM gps_quality_hours WHERE ts >= ?", (day0,)):
            if tot:
                row(ts)[10] = round(100.0 * (deg or 0) / tot)
    except Exception:                                  # noqa: BLE001
        pass
    hours = []
    for ts in sorted(H):
        r = H[ts]
        if r[7] and r[6] is None:
            r[6] = 0
        if r[8]:
            r[9] = len(r[8])
            r[8] = round(_median(r[8]), 3)
        hours.append([ts] + r)
    out = {"start": day0, "days": days, "generated": int(now),
           "keys": ["ts", "inv", "inv_top", "llj", "llj_ft", "wind", "wdir", "ws", "ws_n", "edr", "edr_n", "gnss", "ac"],
           "hours": hours}
    with _lock:
        _cal_cache.clear()
        _cal_cache[key] = out
    return out
