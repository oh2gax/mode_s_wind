"""
collector/gfs_skill.py — how good the GFS forecast is at the airport (from 2026-11-06).

For the users of the meteograms: the forecasts of the stored runs at the
airport (table fc_points of the GFS file, collector/gfs.py — GFS, and MEPS
for its first days) against what the METAR then reported (metar_reports),
by lead day: day 1 = +0 … +24 h, …, day 16 = +360 … +384 h.  A check only —
nothing in MODE-S Wind uses a model value.

Verified:
  temperature   2 m ↔ the METAR's TT: bias, mean absolute error (MAE), the
                80th percentile of the absolute error (p80: "8 in 10 within ±…")
  pressure      sea level ↔ QNH (at EFHK's 55 m the two agree to a few tenths)
  wind          10 m ↔ the METAR's 10-min mean: speed bias / MAE / p80, the
                vector error (MAE / p80; not with VRB), the direction error
                when both are 5 kt or more
  precipitation yes / no: the model's mean of the step 0.1 mm/h or more ↔ a
                METAR with precipitation (DZ RA SN SG PL GR GS UP, not VC / RE,
                not blowing / drifting snow alone) in the step (the hour, or
                the 3 h after +120 h and in the back-filled runs): hits, misses, false alarms, the Heidke
                skill score (HSS; 0 = chance, 1 = perfect) and the base rate
The METAR nearest the valid hour within ±20 min is used (EFHK: :20 / :50).

The reference — climatology: the mean of the METARs of the same UTC hour
within ±7 days of the date in the years before (metar_reports history, from
2018; the last 60 days left out), for the same hours as the model.  Skill
score SS = 1 − MAE_model / MAE_climatology (1 = perfect, 0 = no better than
the usual weather of the season).  "Useful to about day N": the last lead
day of an unbroken run from day 1 with SS ≥ USEFUL_SS (0.2) — per variable,
and overall from the temperature and the wind vector.  A lead day counts
("ok") with at least MIN_N matched hours from at least MIN_RUNS runs; the
others are "collecting".

skill(gdb, db, days) → JSON for /api/weather/gfs_skill (cached CACHE_SEC).
"""

from __future__ import annotations

import math
import threading
import time

MIN_N = 60
MIN_RUNS = 6
USEFUL_SS = 0.2
CACHE_SEC = 1800
MATCH_SEC = 1200
CLIM_DAYS = 7               # ± days of the year
CLIM_SKIP_DAYS = 60         # the recent METARs left out of the climatology
RAIN_MMH = 0.1
PRECIP = ("DZ", "RA", "SN", "SG", "PL", "GR", "GS", "UP")
MODEL_DAYS = {"gfs": 16, "meps": 3}

_lock = threading.Lock()
_cache: dict = {}
_clim: dict = {}            # {"key": (station, day), "tab": {(doy, hour): sums}}


def lead_day(lead: int) -> int:
    return max(1, int(math.ceil(lead / 24.0)))


def precip_in(wx) -> bool:
    """True when a METAR's present weather (wx) holds precipitation at the station."""
    if not wx:
        return False
    for tok in str(wx).split():
        t = tok.lstrip("+-")
        if t.startswith(("RE", "VC", "BL", "DR")):
            continue
        if any(c in t for c in PRECIP):
            return True
    return False


def _uv(wdir, wspd):
    if wdir is None or wspd is None:
        return None
    a = math.radians(wdir)
    return (-wspd * math.sin(a), -wspd * math.cos(a))     # towards east / north


def _p80(a: list):
    if not a:
        return None
    s = sorted(a)
    return s[min(len(s) - 1, int(math.ceil(0.8 * len(s))) - 1)]


def _stats(err: list, clim_abs: list | None = None) -> dict:
    """bias / MAE / p80 of model − observed (and SS against the climatology's |errors|)."""
    if not err:
        return {"n": 0}
    ab = [abs(e) for e in err]
    out = {"n": len(err), "bias": round(sum(err) / len(err), 2), "mae": round(sum(ab) / len(ab), 2),
           "p80": round(_p80(ab), 2)}
    if clim_abs:
        cm = sum(clim_abs) / len(clim_abs)
        out["clim_mae"] = round(cm, 2)
        out["ss"] = round(1.0 - out["mae"] / cm, 2) if cm > 1e-6 else None
    return out


# ── the observations ──────────────────────────────────────────────────────────

def _metars(db, t0: float, t1: float, station: str):
    rows = db.execute("SELECT ts, tt, qnh, wdir, wspd, wx FROM metar_reports WHERE station = ? AND ts >= ? AND ts <= ? "
                      "ORDER BY ts", (station, int(t0), int(t1))).fetchall()
    return [tuple(r) for r in rows]


def _by_hour(mets: list) -> dict:
    """{valid hour: the METAR nearest it within MATCH_SEC}."""
    best: dict = {}
    for m in mets:
        h = int(round(m[0] / 3600.0)) * 3600
        d = abs(m[0] - h)
        if d <= MATCH_SEC and (h not in best or d < abs(best[h][0] - h)):
            best[h] = m
    return best


def _climatology(db, station: str, now: float) -> dict:
    """{(day of year 0…365, UTC hour): [n_t, Σt, n_p, Σp, n_s, Σs, n_v, Σu, Σv, n_x, n_rain]} of the
    METAR history before now − CLIM_SKIP_DAYS, already summed over ± CLIM_DAYS days."""
    key = (station, int(now // 86400))
    if _clim.get("key") == key:
        return _clim["tab"]
    raw: dict = {}
    for ts, tt, qnh, wdir, wspd, wx in db.execute(
            "SELECT ts, tt, qnh, wdir, wspd, wx FROM metar_reports WHERE station = ? AND ts < ?",
            (station, int(now - CLIM_SKIP_DAYS * 86400))):
        h = int(round(ts / 3600.0)) * 3600
        if abs(ts - h) > MATCH_SEC:
            continue
        tm = time.gmtime(h)
        k = (tm.tm_yday - 1, tm.tm_hour)
        a = raw.get(k)
        if a is None:
            a = raw[k] = [0, 0.0, 0, 0.0, 0, 0.0, 0, 0.0, 0.0, 0, 0]
        if tt is not None:
            a[0] += 1; a[1] += tt
        if qnh is not None:
            a[2] += 1; a[3] += qnh
        if wspd is not None:
            a[4] += 1; a[5] += wspd
        uv = _uv(wdir, wspd)
        if uv:
            a[6] += 1; a[7] += uv[0]; a[8] += uv[1]
        a[9] += 1
        if precip_in(wx):
            a[10] += 1
    tab = {}
    for doy in range(366):
        for hr in range(24):
            s = [0, 0.0, 0, 0.0, 0, 0.0, 0, 0.0, 0.0, 0, 0]
            for dd in range(-CLIM_DAYS, CLIM_DAYS + 1):
                a = raw.get(((doy + dd) % 366, hr))
                if a:
                    for i in range(11):
                        s[i] += a[i]
            tab[(doy, hr)] = s
    _clim.update(key=key, tab=tab)
    return tab


def _clim_at(tab: dict, ts: int):
    tm = time.gmtime(ts)
    s = tab.get((tm.tm_yday - 1, tm.tm_hour))
    if not s:
        return None
    return {"t": s[1] / s[0] if s[0] else None, "p": s[3] / s[2] if s[2] else None,
            "ws": s[5] / s[4] if s[4] else None,
            "uv": (s[7] / s[6], s[8] / s[6]) if s[6] else None,
            "rain": s[10] / s[9] if s[9] else None}


# ── the check ─────────────────────────────────────────────────────────────────

def _verify(rows: list, obs: dict, mets: list, tab: dict, model: str) -> list:
    """rows: (lead, ts, t, p, u, v, r, pi) of one model → per lead day the statistics."""
    met_ts = [m[0] for m in mets]
    import bisect
    acc: dict = {}
    for lead, ts, t, p, u, v, r, pi in rows:
        o = obs.get(ts)
        if o is None:
            continue
        d = lead_day(lead)
        a = acc.get(d)
        if a is None:
            a = acc[d] = {k: [] for k in ("t", "tc", "p", "pc", "ws", "wsc", "wv", "wvc", "wd")}
            a["rain"] = [0, 0, 0, 0]                 # hits, misses, false alarms, correct negatives
            a["runs"] = set()
        a["runs"].add(ts - lead * 3600)
        c = _clim_at(tab, ts)
        _, tt, qnh, wdir, wspd, _wx = o
        if t is not None and tt is not None:
            a["t"].append(t - tt)
            if c and c["t"] is not None:
                a["tc"].append(abs(c["t"] - tt))
        if p is not None and qnh is not None:
            a["p"].append(p - qnh)
            if c and c["p"] is not None:
                a["pc"].append(abs(c["p"] - qnh))
        if u is not None and v is not None and wspd is not None:
            ws = math.hypot(u, v)
            a["ws"].append(ws - wspd)
            if c and c["ws"] is not None:
                a["wsc"].append(abs(c["ws"] - wspd))
            ouv = _uv(wdir, wspd)
            if ouv:
                a["wv"].append(math.hypot(u - ouv[0], v - ouv[1]))
                if c and c["uv"]:
                    a["wvc"].append(math.hypot(c["uv"][0] - ouv[0], c["uv"][1] - ouv[1]))
                if ws >= 5 and wspd >= 5:
                    md = (math.degrees(math.atan2(-u, -v)) + 360) % 360
                    a["wd"].append(abs((md - wdir + 180) % 360 - 180))
        if r is not None:
            step = int(pi) if pi else (3 if (model == "gfs" and lead > 120) else 1)
            i0 = bisect.bisect_right(met_ts, ts - step * 3600)
            i1 = bisect.bisect_right(met_ts, ts)
            if i1 > i0:
                seen = any(precip_in(m[5]) for m in mets[i0:i1])
                fc = r >= RAIN_MMH
                a["rain"][0 if fc and seen else 1 if seen else 2 if fc else 3] += 1
    out = []
    for d in range(1, MODEL_DAYS[model] + 1):
        a = acc.get(d)
        if not a:
            out.append({"day": d, "n": 0})
            continue
        ws = _stats(a["ws"], a["wsc"])
        wv = _stats(a["wv"], a["wvc"]) if a["wv"] else {"n": 0}
        if a["wv"]:                                   # a magnitude: bias is the mean error itself
            wv.pop("bias", None)
        h, m, f, cn = a["rain"]
        nr = h + m + f + cn
        exp = ((h + m) * (h + f) + (cn + m) * (cn + f)) / nr if nr else 0
        hss = round((h + cn - exp) / (nr - exp), 2) if nr and nr - exp > 1e-9 else None
        out.append({"day": d, "n": len(a["t"]), "runs": len(a["runs"]),
                    "ok": len(a["t"]) >= MIN_N and len(a["runs"]) >= MIN_RUNS,
                    "t": _stats(a["t"], a["tc"]), "p": _stats(a["p"], a["pc"]), "ws": ws, "wv": wv,
                    "wd": {"n": len(a["wd"]), "mae": round(sum(a["wd"]) / len(a["wd"]), 1)} if a["wd"] else {"n": 0},
                    "rain": {"n": nr, "hits": h, "misses": m, "false": f,
                             "pod": round(h / (h + m), 2) if h + m else None,
                             "far": round(f / (h + f), 2) if h + f else None,
                             "hss": hss, "base": round((h + m) / nr, 3) if nr else None}})
    return out


def _useful(days: list, var: str):
    """(the last day of the unbroken run from day 1 with SS ≥ USEFUL_SS, the last day with enough data)."""
    last_ok, known = 0, 0
    for d in days:
        s = d.get(var) or {}
        if not d.get("ok") or s.get("ss") is None:
            break
        known = d["day"]
        if s["ss"] >= USEFUL_SS and last_ok == d["day"] - 1:
            last_ok = d["day"]
    return {"day": last_ok, "known": known}


def skill(gdb, db, days: float = 30, now: float | None = None, station: str = "EFHK") -> dict:
    now = time.time() if now is None else now
    days = max(3.0, min(90.0, float(days)))
    key = (station, days, int(now // CACHE_SEC))
    with _lock:
        hit = _cache.get(key)
    if hit is not None:
        return hit
    if gdb is None:
        return {"error": "GFS is not configured on this server (GFS_WX)"}
    t0, t1 = now - days * 86400, now
    try:
        prow = {m: gdb.execute("SELECT lead, ts, t, p, u, v, r, pi FROM fc_points WHERE model = ? AND ts >= ? AND ts <= ? "
                               "ORDER BY ts", (m, int(t0), int(t1))).fetchall() for m in ("gfs", "meps")}
        first = gdb.execute("SELECT MIN(run) FROM fc_points WHERE model = 'gfs'").fetchone()[0]
    except Exception as exc:                          # noqa: BLE001  (the table not yet there)
        return {"error": f"no stored forecasts yet ({exc})"}
    mets = _metars(db, t0 - 4 * 3600, t1, station)
    obs = _by_hour(mets)
    tab = _climatology(db, station, now)
    out = {"station": station, "window_days": days, "since": int(t0), "now": int(now), "first_run": first,
           "min_n": MIN_N, "min_runs": MIN_RUNS, "useful_ss": USEFUL_SS, "rain_mmh": RAIN_MMH,
           "clim": "METAR %s, the same UTC hour ±%d days, the years before" % (station, CLIM_DAYS)}
    for m in ("gfs", "meps"):
        dd = _verify([tuple(r) for r in prow[m]], obs, mets, tab, m)
        out[m] = dd
        out[m + "_useful"] = {v: _useful(dd, v) for v in ("t", "p", "wv", "ws")}
    u = out["gfs_useful"]
    out["useful_day"] = min(u["t"]["day"], u["wv"]["day"]) if u["t"]["known"] and u["wv"]["known"] else None
    with _lock:
        _cache.clear()
        _cache[key] = out
    return out
