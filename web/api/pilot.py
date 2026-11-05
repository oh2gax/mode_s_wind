"""
web/api/pilot.py — the Pilot view (from 2026-11-05; the phone's Pilot view, for
the users with the "pilot" right, web/rights.py).  Research only: what the
aircraft before you measured at EFHK — by runway and by height — for the
briefing on the ground, the turnaround and the debrief after the flight.

  brief(db, minutes)          the last minutes: the METAR, the runways in use,
                              the wind on final per arrival runway (head / cross
                              at the surface and 500 / 1000 / 2000 ft above the
                              runway, the landings' band winds), the windshear
                              reports of arrivals and departures, EDR and the
                              go-arounds
  approach(db, rwy, minutes)  the fine headwind profiles (report "hp") of the
                              landings on one runway, in ft above the runway,
                              their median and middle half, the crosswind per
                              200 ft and the reports' shear markers
  icing(db)                   the temperature from the ground up: the airport's
                              climb-outs (bl_hours), the area profile
                              (profile_hours), the Kivenlahti mast, MEPS with its
                              humidity, the METAR — the 0 / −10 / −20 (/ −40) °C
                              heights, a warm layer above a sub-freezing surface
                              (freezing-rain risk) and the icing reports
  flights(db, q) / flight(db, kind, rid)
                              "My flight": a landing or departure of the last 7
                              days by callsign or registration, and its debrief —
                              its headwind profile against the flights of the 45
                              minutes before, its windshear report, EDR, GNSS
                              quality on final

Heights of the approach and the flight are ft above the runway (the runway's
threshold elevation, EFHK 179 ft; 148 ft for 33), of the icing ft MSL.  The
aircraft class (T turboprop, R regional jet, N narrowbody, W widebody, B
business jet) is collector/approach_cond.aircraft_class.
"""

from __future__ import annotations

import json
import math
import time

from collector.approach_cond import aircraft_class
from collector.windshear import EFHK_RUNWAYS

KT_MS = 0.514444
FT = 3.28084
APT_FT = 179.0
WINDOW_MIN = (30, 60, 120)
HIST_DAYS = 7
REF_SEC = 45 * 60
NEAR_NM = 30.0
MAST_ELEV_FT = 44 * FT


def _j(s):
    try:
        return json.loads(s) if s else None
    except (TypeError, ValueError):
        return None


def _thr(rwy) -> float:
    return next((r.get("thr_elevation_ft", APT_FT) for r in EFHK_RUNWAYS if r["name"] == rwy), APT_FT)


def _hdg(rwy):
    return next((r["heading"] for r in EFHK_RUNWAYS if r["name"] == rwy), None)


def _comp(wd, ws, hdg):
    """(headwind +, crosswind + from the right) of a wind from wd° at ws kt on heading hdg."""
    a = math.radians(wd - hdg)
    return ws * math.cos(a), ws * math.sin(a)


def _uv(wd, ws):
    r = math.radians(wd)
    return -ws * math.sin(r), -ws * math.cos(r)


def _band_wind(bands: dict | None, ft_msl: float):
    """The landing's band wind (bands_json: {"band ft MSL": {dir, spd}}) at ft_msl,
    interpolated through u, v between neighbouring bands at most 400 ft apart."""
    pts = sorted((int(k), v) for k, v in (bands or {}).items() if v and v.get("spd") is not None)
    for (a, va), (b, vb) in zip(pts, pts[1:]):
        if a <= ft_msl <= b and b - a <= 400:
            f = (ft_msl - a) / (b - a) if b > a else 0.0
            ua, va_ = _uv(va["dir"], va["spd"])
            ub, vb_ = _uv(vb["dir"], vb["spd"])
            u, v = ua + f * (ub - ua), va_ + f * (vb_ - va_)
            return (math.degrees(math.atan2(-u, -v)) + 360) % 360, math.hypot(u, v)
    return None


def _median(v: list):
    v = sorted(v)
    n = len(v)
    if not n:
        return None
    return v[n // 2] if n % 2 else 0.5 * (v[n // 2 - 1] + v[n // 2])


def _q(v: list, p: float):
    v = sorted(v)
    return v[min(len(v) - 1, int(p * len(v)))] if v else None


def _at(lo, v, z):
    """A fine profile (bins of 100 ft from lo, values v) at height z, linear between bins."""
    f = (z - lo) / 100.0
    i = int(math.floor(f))
    if i < 0 or i >= len(v):
        return None
    if i == len(v) - 1 or f == i:
        return v[i] if f == i else None
    a, b = v[i], v[i + 1]
    if a is None or b is None:
        return None
    return a + (f - i) * (b - a)


def _r(v, nd=1):
    return None if v is None else round(v, nd)


def metar(db, at: float):
    """The newest EFHK METAR / SPECI at or before `at`."""
    try:
        r = db.execute("SELECT ts, raw, wdir, wspd, wgst, wvar, vis, wx, cld, tt, td, qnh, ws FROM metar_reports "
                       "WHERE station = 'EFHK' AND kind IN ('METAR', 'SPECI') AND ts <= ? ORDER BY ts DESC LIMIT 1",
                       (at,)).fetchone()
    except Exception:                                  # noqa: BLE001  (older database)
        return None
    if not r:
        return None
    keys = ("ts", "raw", "wdir", "wspd", "wgst", "wvar", "vis", "wx", "cld", "tt", "td", "qnh", "ws")
    return dict(zip(keys, tuple(r)))


def _sfc(m, hdg):
    if not m or m.get("wspd") is None or hdg is None:
        return None
    if m.get("wdir") is None:                         # VRB
        return [None, None]
    h, x = _comp(m["wdir"], m["wspd"], hdg)
    return [round(h), round(x)]


def _ws_text(s: dict, phase: str, thr: float = APT_FT):
    """(level, what) of a stored windshear report — the strongest part; heights
    ft above the runway (thr: its threshold elevation)."""
    lv = s.get("lvl") or "none"
    aal = lambda z: int(round((z - thr) / 10.0) * 10)
    if phase == "d":
        b = s.get("band") or {}
        return lv, (f"band {b.get('a', 0):+.0f} kt at {aal(b['b']):,} ft".replace(",", " ") if b.get("b") is not None else "")
    rp = [c for c in (s.get("loss"), s.get("gain")) if c and c.get("zone") and not c.get("unv")]
    b = s.get("band") or {}
    if b.get("lvl") not in (None, "none") and (not rp or abs(b.get("a") or 0) >= max(c.get("sc") or 0 for c in rp)):
        return lv, f"band {b['a']:+.0f} kt at {aal(b['b']):,} ft".replace(",", " ")
    if rp:
        c = max(rp, key=lambda c: c.get("sc") or 0)
        return lv, (f"{'loss' if (c.get('dv') or 0) < 0 else 'gain'} {abs(c.get('dv') or 0):.0f} kt over "
                    f"{(c.get('L') or 0) / 1000:.1f} km, {aal(c['a1'])}→{aal(c['a2'])} ft")
    return lv, ""


def _landings(db, t0, t1):
    return db.execute("SELECT id, ts, icao, callsign, registration, aircraft_type, runway, rwy_heading, bands_json, "
                      "go_arounds, shear_json, edr_json FROM approach_history WHERE ts >= ? AND ts < ? ORDER BY ts",
                      (t0, t1)).fetchall()


def _departures(db, t0, t1):
    return db.execute("SELECT id, ts, icao, callsign, registration, aircraft_type, track, shear_json, edr_json "
                      "FROM departure_profiles WHERE ts >= ? AND ts < ? AND ga = 0 ORDER BY ts", (t0, t1)).fetchall()


# ── Now ──────────────────────────────────────────────────────────────────────

def brief(db, minutes: int = 60, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    minutes = minutes if minutes in WINDOW_MIN else 60
    t0 = now - minutes * 60
    m = metar(db, now)
    L = _landings(db, t0, now)
    D = _departures(db, t0, now)
    arr, dep = {}, {}
    for r in L:
        arr[r["runway"]] = arr.get(r["runway"], 0) + 1
    deps = []
    for r in D:
        s = _j(r["shear_json"]) or {}
        rw = s.get("rwy")
        if rw:
            dep[rw] = dep.get(rw, 0) + 1
        deps.append((r, s))
    rows = []
    for rwy in sorted(arr, key=lambda k: -arr[k]):
        hdg = _hdg(rwy) or next((r["rwy_heading"] for r in L if r["runway"] == rwy), None)
        thr = _thr(rwy)
        e = {"rwy": rwy, "n": arr[rwy], "hdg": hdg, "sfc": _sfc(m, hdg)}
        for h in (500, 1000, 2000):
            hs, xs = [], []
            for r in L:
                if r["runway"] != rwy or hdg is None:
                    continue
                w = _band_wind(_j(r["bands_json"]), h + thr)
                if w:
                    a, b = _comp(w[0], w[1], hdg)
                    hs.append(a)
                    xs.append(b)
            e[str(h)] = [round(_median(hs)), round(_median(xs)), len(hs)] if hs else None
        rows.append(e)
    ws, edr = [], []
    for r in L:
        s = _j(r["shear_json"]) or {}
        lv, what = _ws_text(s, "a", _thr(r["runway"]))
        if lv != "none" or s.get("unv"):
            ws.append({"t": int(r["ts"]), "k": "a", "rwy": r["runway"], "ty": r["aircraft_type"], "lvl": lv,
                       "ulvl": s.get("ulvl"), "what": what})
        e_ = _j(r["edr_json"]) or {}
        if e_.get("m") is not None:
            edr.append(e_["m"])
    for r, s in deps:
        lv, what = _ws_text(s, "d", _thr(s.get("rwy")))
        if lv != "none" or s.get("unv"):
            ws.append({"t": int(r["ts"]), "k": "d", "rwy": s.get("rwy"), "ty": r["aircraft_type"], "lvl": lv,
                       "ulvl": s.get("ulvl"), "what": what})
        e_ = _j(r["edr_json"]) or {}
        if e_.get("m") is not None:
            edr.append(e_["m"])
    ws.sort(key=lambda e: e["t"])
    try:
        ga = [{"t": int(r[0]), "ty": r[1], "rwy": r[2], "alt": r[3]} for r in db.execute(
            "SELECT ts, aircraft_type, runway, alt_ft FROM go_arounds WHERE ts >= ? AND ts < ? ORDER BY ts", (t0, now))]
    except Exception:                                  # noqa: BLE001
        ga = []
    return {"now": int(now), "min": minutes, "metar": m, "arr": arr, "dep": dep, "n_arr": len(L), "n_dep": len(D),
            "rows": rows, "ws": ws, "ga": ga,
            "edr": {"med": _r(_median(edr), 3), "max": _r(max(edr), 3) if edr else None, "n": len(edr)}}


# ── Approach ─────────────────────────────────────────────────────────────────

def approach(db, rwy: str | None, minutes: int = 60, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    minutes = minutes if minutes in WINDOW_MIN else 60
    t0 = now - minutes * 60
    L = _landings(db, t0, now)
    counts = {}
    for r in L:
        counts[r["runway"]] = counts.get(r["runway"], 0) + 1
    if not rwy or rwy not in counts:
        rwy = max(counts, key=lambda k: counts[k]) if counts else rwy
    thr, hdg = _thr(rwy), _hdg(rwy)
    m = metar(db, now)
    fl = []
    for r in L:
        if r["runway"] != rwy:
            continue
        s = _j(r["shear_json"]) or {}
        hp = s.get("hp") or {}
        if not hp.get("v"):
            continue
        lo = hp["lo"] - thr
        e = {"t": int(r["ts"]), "cs": r["callsign"], "ty": r["aircraft_type"], "c": aircraft_class(r["aircraft_type"]),
             "lo": lo, "v": hp["v"], "lvl": s.get("lvl") or "none", "ulvl": s.get("ulvl")}
        rp = [dict(kind=k, dv=c.get("dv"), a1=_r(c["a1"] - thr, 0), a2=_r(c["a2"] - thr, 0))
              for k in ("loss", "gain") for c in [s.get(k)] if c and c.get("zone") and (c.get("sc") or 0) >= 10]
        if rp:
            e["ramps"] = rp
        b = s.get("band") or {}
        if b.get("lvl") not in (None, "none") or b.get("ulvl"):
            e["band"] = {"b": int(round((b["b"] - thr) / 10.0) * 10), "a": b.get("a"), "lvl": b.get("lvl"), "ulvl": b.get("ulvl")}
        e_ = _j(r["edr_json"]) or {}
        e["edr"] = e_.get("m")
        bw = _j(r["bands_json"])
        for h in (1000, 500):
            w = _band_wind(bw, h + thr) if hdg is not None else None
            e[f"hw{h}"] = round(_comp(w[0], w[1], hdg)[0]) if w else None
        fl.append((e, bw))
    flights = [e for e, _ in fl]

    def stats(sel):
        out = []
        for z in range(0, 3001, 100):
            vs = [x for x in (_at(e["lo"], e["v"], z) for e in sel) if x is not None]
            out.append([z, _r(_median(vs)), _r(_q(vs, 0.25)), _r(_q(vs, 0.75)), len(vs)] if len(vs) >= 3 else [z, None, None, None, len(vs)])
        return out
    xw = []
    for z in range(200, 3001, 200):
        xs = []
        for e, bw in fl:
            w = _band_wind(bw, z + thr) if hdg is not None else None
            if w:
                xs.append(_comp(w[0], w[1], hdg)[1])
        xw.append([z, _r(_median(xs)) if len(xs) >= 3 else None])
    return {"now": int(now), "min": minutes, "rwy": rwy, "hdg": hdg, "thr": thr, "runways": counts,
            "metar": m, "sfc": _sfc(m, hdg), "flights": flights, "med": stats(flights),
            "med_c": {c: stats([e for e in flights if e["c"] == c]) for c in sorted({e["c"] for e in flights})},
            "xw": xw}


# ── Icing ────────────────────────────────────────────────────────────────────

def _rh(p, t, q):
    """Relative humidity (%) from pressure hPa, temperature °C, specific humidity g/kg."""
    q = q / 1000.0
    es = 6.112 * math.exp(17.67 * t / (t + 243.5))
    e = q * p / (0.622 + 0.378 * q)
    return 100.0 * e / es


def _p_ft(p, qnh):
    return (1 - (p / 1013.25) ** 0.190284) * 145366.45 + ((qnh or 1013.25) - 1013.25) * 27.0


def _crossings(pts: list, level: float) -> list:
    """Heights (ft) where the profile [(ft, °C)] crosses `level` °C, going up."""
    out = []
    for (z0, t0), (z1, t1) in zip(pts, pts[1:]):
        if t0 is None or t1 is None or z1 - z0 > 3000:
            continue
        if (t0 - level) * (t1 - level) < 0 or (t1 == level and t0 != level):
            out.append(round(z0 + (level - t0) / (t1 - t0) * (z1 - z0), -2))
    return out


def icing(db, now: float | None = None, cls: str = "T") -> dict:
    now = time.time() if now is None else now
    h = int(now // 3600 * 3600)
    out = {"now": int(now), "hour": None}
    bl = prof = None
    for hh in (h, h - 3600, h - 7200):
        try:
            rb = db.execute("SELECT data FROM bl_hours WHERE ts = ?", (hh,)).fetchone()
            rp = db.execute("SELECT data FROM profile_hours WHERE ts = ?", (hh,)).fetchone()
        except Exception:                              # noqa: BLE001
            rb = rp = None
        if rb or rp:
            bl, prof, out["hour"] = _j(rb[0]) if rb else None, _j(rp[0]) if rp else None, hh
            break
    m = metar(db, now)
    out["metar"] = m
    qnh = (m or {}).get("qnh") or (bl or {}).get("q") or 1013.25
    # the airport's climb-outs and landings: 200-ft bands (ft MSL, °C, flights)
    apt = [[x[0], x[1], x[2]] for x in (bl or {}).get("t") or [] if x[1] is not None]
    # the area profile (150 km): 1 000-ft layers to 10 000 ft, 2 000-ft above (the layer middle)
    area = []
    for lv in (prof or {}).get("lv") or []:
        lo, t, n = lv[0], lv[1], lv[4]
        if t is None or (n or 0) < 3:
            continue
        area.append([lo + (500 if lo < 10000 else 1000), t, n])
    out["apt"], out["area"] = apt, area
    # the mast (the newest step at or before the hour's end)
    try:
        r = db.execute("SELECT ts, data FROM mast_obs WHERE ts <= ? ORDER BY ts DESC LIMIT 1", (now,)).fetchone()
        md = _j(r[1]) if r and now - r[0] < 3 * 3600 else None
    except Exception:                                  # noqa: BLE001
        md = None
    out["mast"] = ([[round(z * FT + MAST_ELEV_FT), t] for z, t in zip(md.get("tl") or [], md.get("t") or []) if t is not None]
                   if md else None)
    # MEPS model levels (area mean): temperature and humidity
    meps = []
    try:
        r = db.execute("SELECT data FROM meps_ml_hours WHERE ts = ? ORDER BY run DESC LIMIT 1", (h,)).fetchone()
        md2 = _j(r[0]) if r else None
        a = (md2 or {}).get("a") or {}
        for p, t, q in zip(a.get("p") or [], a.get("t") or [], a.get("q") or []):
            if p and t is not None and q is not None and p >= 300:
                meps.append([round(_p_ft(p, qnh)), round(t, 1), round(_rh(p, t, q))])
        meps.sort()
    except Exception:                                  # noqa: BLE001
        pass
    out["meps"] = meps
    # one profile from the ground up: the surface (METAR, else the mast's 2 m), the
    # airport's bands to their top, the area's layers above, MEPS above those
    sfc_t = (m or {}).get("tt")
    if sfc_t is None and out["mast"]:
        sfc_t = out["mast"][0][1]
    pts = [(APT_FT, sfc_t)] if sfc_t is not None else []
    pts += [(x[0], x[1]) for x in apt if x[0] > APT_FT + 50]
    top = pts[-1][0] if pts else 0
    pts += [(x[0], x[1]) for x in area if x[0] > top + 300]
    top = pts[-1][0] if pts else 0
    pts += [(x[0], x[1]) for x in meps if x[0] > top + 500 and x[0] <= 45000]
    pts = sorted(pts)
    out["src_top"] = {"apt": apt[-1][0] if apt else None, "area": area[-1][0] if area else None}
    levels = [0, -10, -20] + ([-40] if cls in ("R", "N", "W", "B") else [])
    out["levels"] = {str(lv): _crossings(pts, lv) for lv in levels}
    out["sfc_t"] = sfc_t
    # a warm layer above a sub-freezing surface: the surface ≤ 0 °C and above it air > 0 °C
    warm = None
    if sfc_t is not None and sfc_t <= 0.5:
        above = [(z, t) for z, t in pts if z > APT_FT + 50 and z < 12000]
        pos = [(z, t) for z, t in above if t is not None and t > 0]
        if pos:
            zs = [z for z, _ in pos]
            warm = {"base": min(zs), "top": max(zs), "max": max(t for _, t in pos),
                    "at": max(pos, key=lambda x: x[1])[0], "sfc": sfc_t,
                    "precip": bool((m or {}).get("wx") and any(k in (m.get("wx") or "") for k in ("RA", "DZ", "SN", "PL", "UP")))}
    out["warm"] = warm
    # cloud from MEPS: RH ≥ 95 % (likely), 85–95 % (moist)
    out["cloud"] = [[z, rh] for z, t, rh in meps if rh >= 85 and z <= 30000]
    # icing reports (ARS, WXREP, SIGMET) of the last 6 h
    try:
        rep = db.execute("SELECT ts, kind, phen, lo_ft, hi_ft, near, raw FROM pilot_reports WHERE ts >= ? AND ts <= ? "
                         "AND (phen LIKE '%ICE%' OR phen LIKE '%FZRA%' OR phen LIKE '%FZDZ%') ORDER BY ts DESC LIMIT 12",
                         (now - 6 * 3600, now)).fetchall()
        out["reports"] = [{"t": int(r[0]), "kind": r[1], "phen": r[2], "lo": r[3], "hi": r[4], "near": bool(r[5]),
                           "raw": r[6]} for r in rep]
    except Exception:                                  # noqa: BLE001
        out["reports"] = []
    return out


# ── My flight ────────────────────────────────────────────────────────────────

def _norm(s):
    return "".join(ch for ch in str(s or "").upper() if ch.isalnum())


def flights(db, q: str, now: float | None = None) -> dict:
    """Landings and departures of the last HIST_DAYS days whose callsign or
    registration contains q (letters and digits only, case ignored), newest first."""
    now = time.time() if now is None else now
    qq = _norm(q)
    if len(qq) < 2:
        return {"q": q, "list": []}
    t0 = now - HIST_DAYS * 86400
    out = []
    for kind, rows in (("a", db.execute("SELECT id, ts, callsign, registration, aircraft_type, runway FROM approach_history "
                                        "WHERE ts >= ? ORDER BY ts DESC", (t0,)).fetchall()),
                       ("d", db.execute("SELECT id, ts, callsign, registration, aircraft_type, shear_json FROM departure_profiles "
                                        "WHERE ts >= ? AND ga = 0 ORDER BY ts DESC", (t0,)).fetchall())):
        for r in rows:
            if qq in _norm(r[2]) or qq in _norm(r[3]):
                rwy = r[5] if kind == "a" else (_j(r[5]) or {}).get("rwy")
                out.append({"k": kind, "id": r[0], "t": int(r[1]), "cs": r[2], "reg": r[3], "ty": r[4], "rwy": rwy})
    out.sort(key=lambda e: -e["t"])
    return {"q": q, "list": out[:30]}


def flight(db, kind: str, rid: int) -> dict | None:
    if kind == "d":
        r = db.execute("SELECT id, ts, icao, callsign, registration, aircraft_type, track, shear_json, edr_json "
                       "FROM departure_profiles WHERE id = ?", (rid,)).fetchone()
    else:
        r = db.execute("SELECT id, ts, icao, callsign, registration, aircraft_type, runway, rwy_heading, shear_json, "
                       "edr_json, gnss_json, go_arounds FROM approach_history WHERE id = ?", (rid,)).fetchone()
    if not r:
        return None
    s = _j(r["shear_json"]) or {}
    rwy = r["runway"] if kind == "a" else s.get("rwy")
    hdg = (r["rwy_heading"] if kind == "a" else s.get("hdg"))
    if hdg is None and kind == "d":
        hdg = r["track"]
    thr = _thr(rwy) if rwy else APT_FT
    hp = s.get("hp") or {}
    out = {"k": kind, "id": r["id"], "t": int(r["ts"]), "cs": r["callsign"], "reg": r["registration"],
           "ty": r["aircraft_type"], "c": aircraft_class(r["aircraft_type"]), "rwy": rwy, "thr": thr,
           "metar": metar(db, r["ts"]), "lvl": s.get("lvl") or "none", "ulvl": s.get("ulvl"), "unv": s.get("unv"),
           "src": s.get("src"), "lo": hp["lo"] - thr if hp.get("v") else None, "v": hp.get("v") or []}
    if kind == "a":
        out["ramps"] = [dict(kind=k, dv=c.get("dv"), sc=c.get("sc"), L=c.get("L"), a1=_r(c["a1"] - thr, 0),
                             a2=_r(c["a2"] - thr, 0), d1=c.get("d1"), d2=c.get("d2"), unv=c.get("unv"))
                        for k in ("loss", "gain") for c in [s.get(k)] if c and c.get("zone") and (c.get("sc") or 0) >= 10]
        out["cf"] = s.get("cf")
        out["ga"] = r["go_arounds"] or 0
        g = _j(r["gnss_json"]) or {}
        nac = [b.get("nacp") for b in (g.get("bands") or {}).values() if b.get("nacp") is not None]
        out["gnss"] = {"nacp_min": min(nac) if nac else None, "frozen": any(b.get("fz") for b in (g.get("bands") or {}).values()),
                       "bands": len(g.get("bands") or {})}
    else:
        t8 = s.get("trial8") or s.get("trial") or {}
        out["ramps"] = [dict(kind=k, dv=c.get("dv"), sc=c.get("sc"), L=c.get("L"), a1=_r(c["a1"] - thr, 0),
                             a2=_r(c["a2"] - thr, 0), trial=True)
                        for k in ("loss", "gain") for c in [t8.get(k)] if c and c.get("zone") and (c.get("sc") or 0) >= 10]
    b = s.get("band") or {}
    if b:
        out["band"] = {"b": int(round((b["b"] - thr) / 10.0) * 10), "a": b.get("a"), "ref": b.get("ref"), "lvl": b.get("lvl"), "ulvl": b.get("ulvl")}
    e = _j(r["edr_json"]) or {}
    out["edr"] = {k: e.get(k) for k in ("m", "lo", "hi", "pk", "n")} if e.get("m") is not None else None
    # the flights of the previous 45 min in the same direction (±30°), as the Approach History's profile chart
    refs = []
    if hdg is not None:
        t0 = r["ts"] - REF_SEC
        for k2, rows in (("a", db.execute("SELECT runway, rwy_heading, shear_json FROM approach_history WHERE ts >= ? AND ts < ?",
                                          (t0, r["ts"])).fetchall()),
                         ("d", db.execute("SELECT NULL, track, shear_json FROM departure_profiles WHERE ts >= ? AND ts < ? AND ga = 0",
                                          (t0, r["ts"])).fetchall())):
            if k2 != kind:
                continue                               # landings with landings, departures with departures
            for o in rows:
                w = _j(o[2]) or {}
                oh = w.get("hdg") if k2 == "d" and w.get("hdg") is not None else o[1]
                ohp = w.get("hp")
                if oh is None or not ohp or not ohp.get("v") or abs((oh - hdg + 540) % 360 - 180) > 30:
                    continue
                othr = _thr(o[0] if k2 == "a" else w.get("rwy")) if (o[0] or w.get("rwy")) else APT_FT
                refs.append({"lo": ohp["lo"] - othr, "v": ohp["v"]})
    ref = []
    for z in range(0, 5001, 100):
        vs = [y for y in (_at(x["lo"], x["v"], z) for x in refs) if y is not None]
        if len(vs) >= 3:
            ref.append([z, _r(_median(vs)), _r(_q(vs, 0.25)), _r(_q(vs, 0.75))])
    out["ref"] = {"n": len(refs), "rows": ref}
    return out
