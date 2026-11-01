"""
web/api/mast.py — the Kivenlahti mast (collector/mast.py) for the Sounding
page's Mast tab, the Time–height strip and the Skew-T (from 2026-11-01).

series()   the 10-minute observations of a period (charts)
hourly()   hour means (collector/mast.hourly) — the Time–height strip
profile()  one observation with the other sources at the same heights:
           MEPS on its model levels (area mean around the receiver, heights
           above the ground from the hypsometric equation) and at the mast
           (2 m temperature, 10 m wind of the weather maps), the Mode S
           boundary layer of the hour at the airport (bl_hours: winds in
           250-ft bins, temperatures in 200-ft bands) and the newest
           Jokioinen sounding of the last 12 h
compare()  every hour of the period: source − mast per mast level — Mode S
           (bl_hours against the hour mean), MEPS model levels and the
           weather-map surface values (against the observation at the full
           hour), the soundings (against the observation nearest the launch)

Heights: the mast's are above its ground (44 m MSL).  The Mode S values are
ft MSL at the airport; they are compared at the same height above the
ground (airport 179 ft).  MEPS and the sonde heights are above their own
ground.  Charts use ft MSL of the mast site (m + 44) × 3.2808.
"""

from __future__ import annotations

import json
import math
import time

from collector import mast as _m

KT_MS = 0.514444
FT = 3.28084
RD_G = 287.04 / 9.80665            # m/K
APT_ELEV_FT = 179.0
MEPS_TOP_M = 450.0
SONDE_MAX_AGE = 12 * 3600

_hour_cache: dict = {}             # (kind, ts) → values (compare: the model and the boundary layer per hour)


def _elev(st: dict) -> float:
    return float(st.get("elev") or 44.0)


def _station() -> dict:
    f = _m.get()
    return dict(f.station) if f else {"name": "Espoo Latokaski (Kivenlahti mast)", "lat": 60.17771,
                                      "lon": 24.64009, "elev": 44.0}


def _fmisid() -> int:
    f = _m.get()
    return f.fmisid if f else _m.FMISID


# ── interpolation ────────────────────────────────────────────────────────────

def _interp(pts: list, h: float, max_gap: float):
    """pts [(h, value)] sorted by h → the value at h (linear), None outside or
    across a gap larger than max_gap."""
    pts = [p for p in pts if p[1] is not None]
    if not pts:
        return None
    for (h0, v0), (h1, v1) in zip(pts, pts[1:]):
        if h0 <= h <= h1:
            if h1 - h0 > max_gap:
                return None
            f = 0.0 if h1 == h0 else (h - h0) / (h1 - h0)
            return v0 + (v1 - v0) * f
    for hh, v in pts:
        if abs(hh - h) <= max_gap / 2:
            return v
    return None


def _wind_at(pts: list, h: float, max_gap: float):
    """pts [(h, kt, dir)] → (kt, dir) at h through u / v, or None."""
    uv = [(p[0], _m.uv(p[1], p[2])) for p in pts if p[1] is not None and p[2] is not None]
    u = _interp([(a, b[0]) for a, b in uv], h, max_gap)
    v = _interp([(a, b[1]) for a, b in uv], h, max_gap)
    if u is None or v is None:
        return None
    return _m.wind_of(u, v)


# ── the other sources at the mast heights ─────────────────────────────────────

def _meps_ml(db, at: float, max_lead: int = 99):
    """MEPS model levels (area mean) at `at`: [(h_m above ground, t °C, kt, dir)]
    up to MEPS_TOP_M, and the run info; heights from the hypsometric equation
    upward from the mean surface pressure."""
    from collector import meps as _meps
    col, info = _meps.column_at(db, at, max_lead=max_lead, kind="ml")
    if col is None:
        return None, None
    h = int(at // 3600 * 3600)
    rows = _meps.hours(db, h - 3600, h + 7200, max_lead, "ml")
    near = rows.get(h) or rows.get(h + 3600) or (next(iter(rows.values())) if rows else None)
    ps = (near or {}).get("ps")
    ps = ps[0] if isinstance(ps, list) and ps else None
    lv = sorted(((p, col["t"][i], col["u"][i], col["v"][i]) for i, p in enumerate(info["p"] or [])
                 if p is not None and col["t"][i] is not None), key=lambda x: -x[0])
    if not lv:
        return None, None
    if ps is None or ps < lv[0][0]:
        ps = lv[0][0] + 1.5                         # about 12 m below the lowest level
    out, z, p0, t0 = [], 0.0, ps, lv[0][1]
    for p, t, u, v in lv:
        tm = (t0 + t) / 2 + 273.15
        z += RD_G * tm * math.log(p0 / p)
        p0, t0 = p, t
        if z > MEPS_TOP_M:
            break
        ws, wd = _m.wind_of(u, v) if u is not None and v is not None else (None, None)
        out.append((round(z, 1), t, ws, wd))
    return out, info


def _meps_sfc(db, st: dict, at: float):
    """The weather maps' 2 m temperature and 10 m wind at the mast for the hour
    ending at or after `at`: {t, kt, dir, gust, ts, km} or None."""
    from web.api import weather as _wx
    p = _wx.point(db, st["lat"], st["lon"], now=at)
    v = (p or {}).get("v") or {}
    if not v:
        return None
    out = {"ts": p.get("ts"), "km": p.get("km")}
    if v.get("t") is not None:
        out["t"] = v["t"] / 10.0
    if v.get("u") is not None and v.get("v") is not None:
        out["kt"], out["dir"] = _m.wind_of(v["u"], v["v"])
    if v.get("g") is not None:
        out["gust"] = v["g"]
    return out


def _bl(db, h: int):
    """bl_hours row of the hour starting at h (Mode S, airport) or None."""
    try:
        r = db.execute("SELECT data FROM bl_hours WHERE ts = ?", (int(h),)).fetchone()
        return json.loads(r[0]) if r else None
    except Exception:                                 # noqa: BLE001
        return None


def _sonde_near(at: float, before: float = SONDE_MAX_AGE, after: float = 0):
    """The newest sounding launched in [at − before, at + after]: (meta, [(h_m above ground, t, kt, dir)])."""
    try:
        from collector import sondes as _s
        ss = _s.get()
        if not ss:
            return None, None
        for m in ss.items():
            t = m.get("launch") or m.get("nominal")
            if t is None or t > at + after:
                continue
            if t < at - before:
                return None, None
            rec = ss.load(m["key"])
            lv = (rec or {}).get("lv") or []
            zs = [x[2] for x in lv if x[2] is not None]
            if not zs:
                return None, None
            g = zs[0]
            pts = [(x[2] - g, x[3], x[6], x[5]) for x in lv if x[2] is not None and x[2] - g <= MEPS_TOP_M]
            return {"launch": t, "station": rec.get("station") or "Jokioinen", "key": m["key"]}, pts
    except Exception:                                  # noqa: BLE001
        pass
    return None, None


# ── API functions ────────────────────────────────────────────────────────────

def series(db, start: float, end: float) -> dict:
    st = _station()
    rs = _m.rows(db, start, end, _fmisid())
    tl = rs[-1][1].get("tl") if rs else [2, 26, 49, 92, 141, 217, 265, 297]
    wl = rs[-1][1].get("wl") if rs else [26, 92, 217, 327]
    out = []
    for ts, r in rs:
        if r.get("tl") != tl or r.get("wl") != wl:
            continue
        out.append([ts, r.get("t"), r.get("rh"), r.get("td"),
                    [None if v is None else round(v / KT_MS, 1) for v in r.get("ws") or []],
                    r.get("wd"),
                    [None if v is None else round(v / KT_MS, 1) for v in r.get("wg") or []]])
    return {"station": st, "fmisid": _fmisid(), "tl": tl, "wl": wl, "start": int(start), "end": int(end),
            "cols": ["ts", "t", "rh", "td", "ws_kt", "wd", "wg_kt"], "rows": out,
            "source": "FMI open data (Kivenlahti mast, Espoo Latokaski), CC BY 4.0"}


def hourly(db, start: float, end: float) -> dict:
    return {"station": _station(), "hours": _m.hourly(db, start, end, _fmisid()),
            "source": "FMI open data (Kivenlahti mast), CC BY 4.0"}


def profile(db, at: float | None = None) -> dict:
    """The observation at or before `at` (default now) with the other sources."""
    st = _station()
    e = _elev(st)
    at = time.time() if at is None else at
    rs = _m.rows(db, at - 3 * 3600, at, _fmisid())
    if not rs:
        return {"found": False, "station": st, "at": int(at)}
    ts, r = rs[-1]
    obs = {"ts": ts, "tl": r.get("tl"), "wl": r.get("wl"), "t": r.get("t"), "rh": r.get("rh"), "td": r.get("td"),
           "ws": [None if v is None else round(v / KT_MS, 1) for v in r.get("ws") or []], "wd": r.get("wd"),
           "wg": [None if v is None else round(v / KT_MS, 1) for v in r.get("wg") or []]}
    out = {"found": True, "station": st, "obs": obs, "elev_m": e}
    # MEPS model levels (area mean) — ft MSL of the mast site
    ml, info = _meps_ml(db, ts)
    if ml:
        out["meps"] = {"run": info["run"], "lead": info["lead"],
                       "lv": [[round(z), round(t, 2), None if ws is None else round(ws, 1),
                               None if wd is None else round(wd)] for z, t, ws, wd in ml]}
    try:
        sfc = _meps_sfc(db, st, ts)
        if sfc:
            out["meps_sfc"] = sfc
    except Exception:                                  # noqa: BLE001
        pass
    # Mode S boundary layer at the airport: the hour of the observation, else the one before
    h = ts // 3600 * 3600
    for hh in (h, h - 3600):
        bl = _bl(db, hh)
        if bl and (bl.get("w") or bl.get("t")):
            top = (max(obs["wl"] or [327]) + e) * FT + 400
            out["modes"] = {"ts": hh, "w": [x for x in bl.get("w") or [] if x[0] <= top],
                            "t": [x for x in bl.get("t") or [] if x[0] <= top], "tt": bl.get("tt"),
                            "apt_elev_ft": APT_ELEV_FT}
            break
    meta, pts = _sonde_near(ts)
    if meta:
        out["sonde"] = dict(meta, lv=[[round(z), t, ws, wd] for z, t, ws, wd in pts])
    return out


def _stats(ds: list) -> dict | None:
    if not ds:
        return None
    n = len(ds)
    b = sum(ds) / n
    return {"n": n, "bias": round(b, 2), "rms": round(math.sqrt(sum(d * d for d in ds) / n), 2)}


def _wstats(pairs: list) -> dict | None:
    """pairs [(src kt, src dir, mast kt, mast dir)] → speed bias, vector RMS, direction bias (≥ 5 kt both)."""
    if not pairs:
        return None
    n = len(pairs)
    ds, vv, dd = [], [], []
    for s, sd, m, md in pairs:
        ds.append(s - m)
        su, sv = _m.uv(s, sd)
        mu, mv = _m.uv(m, md)
        vv.append((su - mu) ** 2 + (sv - mv) ** 2)
        if s >= 5 and m >= 5:
            dd.append(((sd - md + 540) % 360) - 180)
    return {"n": n, "spd_bias": round(sum(ds) / n, 1), "vrms": round(math.sqrt(sum(vv) / n), 1),
            "dir_bias": round(sum(dd) / len(dd)) if dd else None, "n_dir": len(dd)}


def compare(db, days: float = 7) -> dict:
    """source − mast for every hour of the last `days` days, per mast level."""
    st = _station()
    e = _elev(st)
    now = time.time()
    t0 = (now - days * 86400) // 3600 * 3600
    hrs = _m.hourly(db, t0, now, _fmisid())
    rs = {ts: r for ts, r in _m.rows(db, t0, now, _fmisid())}
    if not hrs:
        return {"station": st, "days": days, "hours": 0}
    wl, tl = hrs[-1]["wl"], hrs[-1]["tl"]
    acc = {s: {"w": {h: [] for h in wl}, "t": {h: [] for h in tl}} for s in ("modes", "meps", "sonde")}
    sfc_t, sfc_w = [], []
    n_modes = n_meps = 0
    from collector import meps as _meps
    for hr in hrs:
        if hr["wl"] != wl or hr["tl"] != tl:
            continue
        h = hr["ts"]
        # Mode S boundary layer (hour mean against hour mean) at the same height above the ground
        bl = _bl(db, h) if h < now - 3600 else None
        if bl:
            used = False
            wpts = [(x[0] - APT_ELEV_FT, x[1], x[2]) for x in bl.get("w") or []]
            for i, hm in enumerate(wl):
                if hr["ws"][i] is None:
                    continue
                w = _wind_at(wpts, hm * FT, 260)
                if w:
                    acc["modes"]["w"][hm].append((w[0], w[1], hr["ws"][i], hr["wd"][i])); used = True
            tpts = [(x[0] - APT_ELEV_FT, x[1]) for x in bl.get("t") or []]
            for i, hm in enumerate(tl):
                if hm < 60 or hr["t"][i] is None:
                    continue
                t = _interp(tpts, hm * FT, 420)
                if t is not None:
                    acc["modes"]["t"][hm].append(t - hr["t"][i]); used = True
            n_modes += used
        # MEPS at the full hour against the observation at that time
        ob = rs.get(h)
        if ob and ob.get("wl") == wl and ob.get("tl") == tl:
            key = ("ml", h)
            if key not in _hour_cache:
                try:
                    ml, _ = _meps_ml(db, h, _meps.VERIF_MAX_LEAD)
                except Exception:                      # noqa: BLE001
                    ml = None
                _hour_cache[key] = ml
            ml = _hour_cache[key]
            if ml:
                n_meps += 1
                for i, hm in enumerate(wl):
                    if ob["ws"][i] is None or ob["wd"][i] is None:
                        continue
                    w = _wind_at([(z, ws, wd) for z, _, ws, wd in ml], hm, 60)
                    if w:
                        acc["meps"]["w"][hm].append((w[0], w[1], ob["ws"][i] / KT_MS, ob["wd"][i]))
                for i, hm in enumerate(tl):
                    if hm < 10 or ob["t"][i] is None:
                        continue
                    t = _interp([(z, tt) for z, tt, _, _ in ml], hm, 60)
                    if t is not None:
                        acc["meps"]["t"][hm].append(t - ob["t"][i])
            key = ("sfc", h)
            if key not in _hour_cache:
                try:
                    _hour_cache[key] = _meps_sfc(db, st, h)
                except Exception:                      # noqa: BLE001
                    _hour_cache[key] = None
            sf = _hour_cache[key]
            if sf and sf.get("ts") == h:
                if sf.get("t") is not None and ob["t"] and ob["t"][0] is not None:
                    sfc_t.append(sf["t"] - ob["t"][0])
                if sf.get("kt") is not None and ob["ws"] and ob["ws"][0] is not None and ob["wd"][0] is not None:
                    sfc_w.append((sf["kt"], sf["dir"], ob["ws"][0] / KT_MS, ob["wd"][0]))
    if len(_hour_cache) > 4000:
        _hour_cache.clear()
    # soundings: the observation nearest the launch
    n_sonde = 0
    try:
        from collector import sondes as _s
        ss = _s.get()
        for m in (ss.items() if ss else []):
            t = m.get("launch") or m.get("nominal")
            if t is None or t < t0:
                continue
            ts = min(rs, key=lambda x: abs(x - t), default=None)
            if ts is None or abs(ts - t) > 900:
                continue
            meta, pts = _sonde_near(t + 1, before=60)
            ob = rs[ts]
            if not pts or ob.get("wl") != wl or ob.get("tl") != tl:
                continue
            n_sonde += 1
            for i, hm in enumerate(wl):
                if ob["ws"][i] is None or ob["wd"][i] is None:
                    continue
                w = _wind_at([(z, ws, wd) for z, _, ws, wd in pts], hm, 80)
                if w:
                    acc["sonde"]["w"][hm].append((w[0], w[1], ob["ws"][i] / KT_MS, ob["wd"][i]))
            for i, hm in enumerate(tl):
                if hm < 10 or ob["t"][i] is None:
                    continue
                t2 = _interp([(z, tt) for z, tt, _, _ in pts], hm, 80)
                if t2 is not None:
                    acc["sonde"]["t"][hm].append(t2 - ob["t"][i])
    except Exception:                                  # noqa: BLE001
        pass
    res = {}
    for s, a in acc.items():
        res[s] = {"wind": [dict({"h_m": hm, "ft": round((hm + e) * FT)}, **(_wstats(a["w"][hm]) or {"n": 0}))
                           for hm in wl],
                  "temp": [dict({"h_m": hm, "ft": round((hm + e) * FT)}, **(_stats(a["t"][hm]) or {"n": 0}))
                           for hm in tl]}
    res["meps_sfc"] = {"t2m": _stats(sfc_t), "w10": _wstats(sfc_w)}
    return {"station": st, "days": days, "hours": len(hrs), "n_modes": n_modes, "n_meps": n_meps,
            "n_sonde": n_sonde, "wl": wl, "tl": tl, "elev_m": e, "sources": res}
