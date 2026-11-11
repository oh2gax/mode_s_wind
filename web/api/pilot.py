"""
web/api/pilot.py — the Pilot view (from 2026-11-05; the phone's Pilot view, for
the users with the "pilot" right, web/rights.py).  Research only: what the
aircraft before you measured at EFHK — by runway and by height — for the
briefing on the ground, the turnaround and the debrief after the flight.

  brief(db, minutes)          the last minutes: the METAR, the runways in use,
                              the wind on final per arrival runway (head / cross
                              at the surface and 500 / 1000 / 2000 ft above the
                              runway, the landings' band winds), the windshear
                              reports of arrivals and departures, EDR, the
                              go-arounds and (from 2026-11-08) the boundary
                              layer: surface inversion and low-level jet now
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
  departure(db, rwy, minutes)  the climb-outs of one runway (from 2026-11-05 evening):
                              the headwind profiles (report "hp") to 5 000 ft above
                              the runway, their median and middle half, the crosswind,
                              the temperature and its ISA deviation from the
                              departures' own bands, a climb table and the boundary
                              layer's low-level jet and inversion of the hour
  aloft(db, cls)              winds and temperatures aloft, WINTEM-like: the area
                              profile (profile_hours), MEPS and the newest Jokioinen
                              sounding at FL020…FL450, the ISA deviation, the
                              tropopause and the jet
  turbulence(db, minutes)     EDR of the landings and departures by 1 000 ft above the
                              runway, the rough flights, the last 6 h hour by hour and
                              the turbulence reports (ARS, WXREP, SIGMET)
  gnss(db, tracker)           GNSS for pilots: degraded aircraft now by FL band (counts
                              only), the last 24 h within 50 NM and the landings and
                              departures at EFHK with degraded GNSS
  flights(db, q) / flight(db, kind, rid)
                              "My flight": a landing or departure of the last 7
                              days by callsign or registration, and its debrief —
                              its headwind profile against the flights of the 45
                              minutes before, its windshear report, EDR, GNSS
                              quality on final

Heights of the approach, the departure, the turbulence and the flight are ft above the runway (the runway's
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


def _band_wind(bands: dict | None, ft_msl: float, near: float = 0.0):
    """The landing's band wind (bands_json: {"band ft MSL": {dir, spd}}) at ft_msl,
    interpolated through u, v between neighbouring bands at most 400 ft apart.
    near (from 2026-11-07, Now's 13 heights): without bands on both sides, the
    nearest band within this many ft (a band holds the winds of ± 100 ft) —
    e.g. 200 ft above 22L (≈ 370 ft MSL) from the 400-ft band, as the band below
    the threshold is never flown."""
    pts = sorted((int(k), v) for k, v in (bands or {}).items() if v and v.get("spd") is not None)
    for (a, va), (b, vb) in zip(pts, pts[1:]):
        if a <= ft_msl <= b and b - a <= 400:
            f = (ft_msl - a) / (b - a) if b > a else 0.0
            ua, va_ = _uv(va["dir"], va["spd"])
            ub, vb_ = _uv(vb["dir"], vb["spd"])
            u, v = ua + f * (ub - ua), va_ + f * (vb_ - va_)
            return (math.degrees(math.atan2(-u, -v)) + 360) % 360, math.hypot(u, v)
    if near > 0 and pts:
        k, v = min(pts, key=lambda kv: abs(kv[0] - ft_msl))
        if abs(k - ft_msl) <= near:
            return float(v["dir"]), float(v["spd"])
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

BRIEF_HEIGHTS = (500, 1000, 2000)
BRIEF_HEIGHTS_MORE = (300, 500, 750, 1000, 1500, 2000, 2500)   # from 2026-11-06: the landings' bands reach ~2 700 ft MSL
BRIEF_HEIGHTS_ALL = tuple(range(200, 2601, 200))                 # from 2026-11-07: 13 heights, the 200-ft spacing of the stored bands


def brief(db, minutes: int = 60, now: float | None = None, rwys: list | None = None, more: bool | str = False) -> dict:
    """rwys (from 2026-11-06): the runways the pilot chose for the wind on final, in
    place of the runways in use (the two with the most landings).  A chosen runway
    without landings in the window gets the wind aloft of all the landings (the
    band winds of their own approaches), resolved on its heading and its threshold.
    more (from 2026-11-06): the wind on final at 300 / 500 / 750 / 1 000 / 1 500 /
    2 000 / 2 500 ft above the runway instead of 500 / 1 000 / 2 000; more="all"
    (from 2026-11-07): at the 13 heights 200, 400 … 2 600 ft (BRIEF_HEIGHTS_ALL)."""
    heights = BRIEF_HEIGHTS_ALL if more == "all" else BRIEF_HEIGHTS_MORE if more else BRIEF_HEIGHTS
    now = time.time() if now is None else now
    names = [r["name"] for r in EFHK_RUNWAYS]
    rwys = [r for r in (rwys or []) if r in names][:3]
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
    for rwy in (rwys or sorted(arr, key=lambda k: -arr[k])):
        hdg = _hdg(rwy) or next((r["rwy_heading"] for r in L if r["runway"] == rwy), None)
        thr = _thr(rwy)
        own = arr.get(rwy, 0) > 0                     # its own landings, else all the landings
        e = {"rwy": rwy, "n": arr.get(rwy, 0), "hdg": hdg, "sfc": _sfc(m, hdg), "chosen": bool(rwys),
             "src": "own" if own else ("all" if L else "none")}
        if not own:
            e["from"] = {k: v for k, v in arr.items()}
        for h in heights:
            hs, xs = [], []
            for r in L:
                if (own and r["runway"] != rwy) or hdg is None:
                    continue
                w = _band_wind(_j(r["bands_json"]), h + thr, near=100.0)
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
            "runways": names, "chosen": rwys, "heights": list(heights), "rows": rows, "ws": ws, "ga": ga,
            "edr": {"med": _r(_median(edr), 3), "max": _r(max(edr), 3) if edr else None, "n": len(edr)},
            "bl": bl_now(db, now)}


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


# ── Departure / climb-out (from 2026-11-05 evening) ─────────────────────────

DEP_TOP = 5000
CLIMB_AT = (500, 1000, 1500, 2000, 3000, 4000)


def _isa(ft):
    """ISA temperature (°C) at a pressure altitude (ft)."""
    return 15.0 - 1.98 * min(ft, 36089.0) / 1000.0


def _prof_bands(pj):
    """The departure's own bands (prof_json: {"ft MSL": {n, ws, wd, sd, t, tn}}) as
    band winds {"ft": {dir, spd}} for _band_wind, and the temperatures [(ft, °C)]."""
    b = (pj or {}).get("bands") or pj or {}
    w, t = {}, []
    for k, v in b.items():
        if not isinstance(v, dict):
            continue
        try:
            z = int(k)
        except (TypeError, ValueError):
            continue
        if v.get("ws") is not None and v.get("wd") is not None and (v.get("n") or 0) >= 1:
            w[str(z)] = {"dir": v["wd"], "spd": v["ws"]}
        if v.get("t") is not None and (v.get("tn") or 0) >= 1:
            t.append((z, v["t"]))
    return w, sorted(t)


def _t_at(pts, z):
    for (a, ta), (b, tb) in zip(pts, pts[1:]):
        if a <= z <= b and b - a <= 600:
            return ta + (z - a) / (b - a) * (tb - ta) if b > a else ta
    return next((t for a, t in pts if abs(a - z) <= 100), None)


# Inversion aloft (from 2026-11-09): a layer above the surface-inversion zone in
# which the 200-ft band temperatures of the landings and departures (smoothed
# +-200 ft, >= 4 flights a band) rise by at least ALOFT_DT over at least
# ALOFT_MIN_FT.  Base at or above ALOFT_BASE_FT and above the top of a
# surface inversion.  Strength: weak < 2, moderate < 4, strong >= 4 K.
# The bands reach 5 000 ft MSL ("t") and, from 2026-11-10, 10 000 ft from the
# climb-outs followed on that high ("ta", with the 500-ft wind bins "wh";
# collector/boundary.py, collector/departures.py) — as far as the hour's
# flights went: "ttop" in the output is the highest band with data.
ALOFT_DT = 1.0
ALOFT_MIN_FT = 400
ALOFT_BASE_FT = 1200
ALOFT_DIP = 0.15          # K: a smaller fall inside the layer does not end it


def inv_aloft(t: list, inv: dict | None = None, w: list | None = None, tt=None) -> dict | None:
    """The strongest inversion aloft in the bands t = [[ft, degC, n]] (ft MSL)."""
    sm = {int(b): v for b, v, *_ in (t or []) if v is not None}
    bs = sorted(sm)
    if len(bs) < 3:
        return None
    lo = max(ALOFT_BASE_FT, ((inv or {}).get("top") or 0) + 200)
    best, i = None, 0
    while i < len(bs) - 1:
        b0 = bs[i]
        if b0 < lo or sm[bs[i + 1]] <= sm[b0]:
            i += 1
            continue
        j, top = i, i
        while j < len(bs) - 1 and bs[j + 1] - bs[j] <= 400 and sm[bs[j + 1]] >= sm[bs[top]] - ALOFT_DIP:
            j += 1
            if sm[bs[j]] > sm[bs[top]]:
                top = j
        dT = sm[bs[top]] - sm[b0]
        if dT >= ALOFT_DT and bs[top] - b0 >= ALOFT_MIN_FT and (best is None or dT > best["dT"]):
            best = {"base": b0, "top": bs[top], "dT": round(dT, 1), "tb": sm[b0], "tt": sm[bs[top]],
                    "end": bs[top] == bs[-1]}
        i = max(top, i + 1)
    if not best:
        return None
    best["k"] = "strong" if best["dT"] >= 4 else "moderate" if best["dT"] >= 2 else "weak"
    # a warm layer above 0 degC over air at or below 0 degC (below it, or at the surface)
    below = [sm[b] for b in bs if b <= best["base"]] + ([tt] if tt is not None else [])
    best["warm0"] = best["tt"] > 0 and bool(below) and min(below) < 0
    # the wind just below the base and just above the top, and their vector difference
    wb = [x for x in (w or []) if best["base"] - 600 <= x[0] <= best["base"] + 100]
    wa = [x for x in (w or []) if best["top"] + 100 <= x[0] <= best["top"] + 800]
    best["wb"] = wb[-1][:3] if wb else None
    best["wa"] = wa[0][:3] if wa else None
    if wb and wa:
        import math
        uv = [(x[1] * math.sin(math.radians(x[2])), x[1] * math.cos(math.radians(x[2]))) for x in (wb[-1], wa[0])]
        best["dv"] = round(math.hypot(uv[1][0] - uv[0][0], uv[1][1] - uv[0][1]))
    else:
        best["dv"] = None
    return best


def _bl_now(db, now):
    h = int(now // 3600 * 3600)
    for hh in (h, h - 3600, h - 7200):
        try:
            r = db.execute("SELECT data FROM bl_hours WHERE ts = ?", (hh,)).fetchone()
        except Exception:                              # noqa: BLE001
            return None, None
        if r:
            return _j(r[0]), hh
    return None, None


BL_CACHE_SEC = 300
BL_HIST_H = 6
_BL_NOW: dict = {}


def bl_now(db, now: float) -> dict | None:
    """The boundary layer for the Now tab (from 2026-11-08): the surface
    inversion and the low-level jet of the last 60 minutes of landings and
    departures (collector/boundary.compute_hour on the hour in progress), else
    of the newest stored hour (bl_hours); the warmest air above the ground, the
    wind just above the inversion's top against the METAR wind, and the
    inversion of the last BL_HIST_H stored hours.  Heights ft MSL.  Cached
    BL_CACHE_SEC."""
    key = int(now // BL_CACHE_SEC)
    hit = _BL_NOW.get("v")
    if hit and hit[0] == key:
        return hit[1]
    from collector import boundary as B
    h = int(now // 3600 * 3600)
    rec, src, hour = None, "now", None
    try:
        rec = B.compute_hour(db, h, now)
    except Exception:                                  # noqa: BLE001
        rec = None

    def known(r):
        bands = {b for b, _, _ in (r or {}).get("t") or []}
        return (r or {}).get("tt") is not None and len(bands & {600, 800, 1000}) >= 2
    if not known(rec):
        st_, hh = _bl_now(db, now)
        if st_ and known(st_):
            rec, src, hour = st_, "hour", hh
    out = None
    if rec is not None:
        inv, t = rec.get("inv"), rec.get("t") or []
        t_all = t + (rec.get("ta") or [])           # with the bands above 5 000 ft (from 2026-11-10)
        out = {"src": src, "hour": hour, "known": known(rec), "inv": inv, "llj": rec.get("llj"),
               "tt": rec.get("tt"), "warm": None, "wtop": None, "hist": [],
               "ttop": max((x[0] for x in t_all), default=None)}
        # the winds above a surface inversion and around an inversion aloft: the
        # hour in progress has few wind bins in its first minutes — then those of
        # the last stored hour (from 2026-11-10; until then only when it had none)
        if len(rec.get("w") or []) < 5 or (rec.get("ta") and not rec.get("wh")):
            st_, _ = _bl_now(db, now)
            if len(rec.get("w") or []) < 5:
                rec["w"] = (st_ or {}).get("w") or rec.get("w") or []
            if not rec.get("wh"):
                rec["wh"] = (st_ or {}).get("wh") or []
        if inv:
            top = inv.get("top") or 1000
            near = [x for x in t if x[0] <= top + 400]
            if near:
                w = max(near, key=lambda x: x[1])
                out["warm"] = [w[0], w[1]]
            above = [x for x in rec.get("w") or [] if top + 200 <= x[0] <= top + 1200]
            if above:
                out["wtop"] = above[0][:3]
        hist = []
        try:
            for ts, data in db.execute("SELECT ts, data FROM bl_hours WHERE ts >= ? AND ts < ? ORDER BY ts",
                                       (h - BL_HIST_H * 3600, h)).fetchall():
                d = _j(data) or {}
                al = inv_aloft((d.get("t") or []) + (d.get("ta") or []), d.get("inv")) if known(d) else None
                hist.append([int(ts), (d.get("inv") or {}).get("dT", 0.0) if known(d) else None,
                             al["dT"] if al else None, al["base"] if al else None])
        except Exception:                              # noqa: BLE001
            pass
        out["hist"] = hist
        try:
            out["aloft"] = inv_aloft(t_all, inv, (rec.get("w") or []) + (rec.get("wh") or []), rec.get("tt"))
        except Exception:                              # noqa: BLE001
            out["aloft"] = None
    _BL_NOW["v"] = (key, out)
    return out


def departure(db, rwy: str | None, minutes: int = 60, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    minutes = minutes if minutes in WINDOW_MIN else 60
    t0 = now - minutes * 60
    rows = db.execute("SELECT id, ts, callsign, registration, aircraft_type, track, prof_json, shear_json, edr_json "
                      "FROM departure_profiles WHERE ts >= ? AND ts < ? AND ga = 0 ORDER BY ts", (t0, now)).fetchall()
    counts, deps = {}, []
    for r in rows:
        s = _j(r["shear_json"]) or {}
        rw = s.get("rwy")
        if not rw:
            continue
        counts[rw] = counts.get(rw, 0) + 1
        deps.append((r, s))
    if not rwy or rwy not in counts:
        rwy = max(counts, key=lambda k: counts[k]) if counts else rwy
    thr, hdg = _thr(rwy), _hdg(rwy)
    m = metar(db, now)
    fl = []
    for r, s in deps:
        if s.get("rwy") != rwy:
            continue
        h_ = s.get("hdg") or hdg or r["track"]
        w, tp = _prof_bands(_j(r["prof_json"]))
        hp = s.get("hp") or {}
        e = {"t": int(r["ts"]), "cs": r["callsign"], "ty": r["aircraft_type"], "c": aircraft_class(r["aircraft_type"]),
             "lo": hp["lo"] - thr if hp.get("v") else None, "v": hp.get("v") or [],
             "lvl": s.get("lvl") or "none", "ulvl": s.get("ulvl")}
        b = s.get("band") or {}
        if b.get("lvl") not in (None, "none") or b.get("ulvl"):
            e["band"] = {"b": int(round((b["b"] - thr) / 10.0) * 10), "a": b.get("a"), "lvl": b.get("lvl"), "ulvl": b.get("ulvl")}
        e_ = _j(r["edr_json"]) or {}
        e["edr"] = e_.get("m")
        for z in (1000, 3000):
            e[f"hw{z}"] = _r(_at(e["lo"], e["v"], z), 0) if e["v"] else None
        fl.append((e, w, tp, h_))
    flights = [e for e, *_ in fl]

    def stats(sel):
        out = []
        for z in range(0, DEP_TOP + 1, 100):
            vs = [x for x in (_at(e["lo"], e["v"], z) for e in sel if e["v"]) if x is not None]
            out.append([z, _r(_median(vs)), _r(_q(vs, 0.25)), _r(_q(vs, 0.75)), len(vs)] if len(vs) >= 3 else [z, None, None, None, len(vs)])
        return out
    xw, tt = [], []
    for z in range(250, DEP_TOP + 1, 250):
        xs = []
        for e, w, tp, h_ in fl:
            bw = _band_wind(w, z + thr) if hdg is not None else None
            if bw:
                xs.append(_comp(bw[0], bw[1], hdg)[1])
        xw.append([z, _r(_median(xs)) if len(xs) >= 2 else None])
    for z in range(200, DEP_TOP + 1, 200):
        # every band within ±200 ft of every departure (a 400-ft running median: a
        # departure's band temperatures are noisy, about ±1 K)
        ts_ = [t for e, w, tp, h_ in fl for zz, t in tp if abs(zz - (z + thr)) <= 200]
        tt.append([z, _r(_median(ts_)) if len(ts_) >= 4 else None, len(ts_)])
    climb = []
    med = stats(flights)
    for z in CLIMB_AT:
        us, vs, xs, ts_ = [], [], [], []
        for e, w, tp, h_ in fl:
            bw = _band_wind(w, z + thr)
            if bw:
                u, v = _uv(*bw)
                us.append(u)
                vs.append(v)
                if hdg is not None:
                    xs.append(_comp(bw[0], bw[1], hdg)[1])
            t = _t_at(tp, z + thr)
            if t is not None:
                ts_.append(t)
        hrow = next((x for x in med if x[0] == z), None)
        wd = ws = None
        if us:
            u, v = sum(us) / len(us), sum(vs) / len(vs)
            wd, ws = round((math.degrees(math.atan2(-u, -v)) + 360) % 360), round(math.hypot(u, v))
        t = _median(ts_)
        climb.append({"z": z, "hw": hrow[1] if hrow else None, "wd": wd, "ws": ws, "xw": _r(_median(xs), 0),
                      "t": _r(t), "isa": _r(t - _isa(z + thr)) if t is not None else None, "n": max(len(us), len(ts_))})
    bl, bh = _bl_now(db, now)
    return {"now": int(now), "min": minutes, "rwy": rwy, "hdg": hdg, "thr": thr, "runways": counts,
            "metar": m, "sfc": _sfc(m, hdg), "flights": flights, "med": med,
            "med_c": {c: stats([e for e in flights if e["c"] == c]) for c in sorted({e["c"] for e in flights})},
            "xw": xw, "tt": tt, "climb": climb,
            "bl": {"hour": bh, "llj": (bl or {}).get("llj"), "inv": (bl or {}).get("inv")} if bl else None}


# ── Winds and temperatures aloft (from 2026-11-05 evening) ──────────────────

ALOFT_FL = (20, 50, 70, 80, 100, 120, 140, 160, 180, 200, 220, 240, 250, 270, 280, 300, 320, 340, 360, 380, 390, 410, 450)


def _p_alt(p):
    """Pressure altitude (ft) of a pressure (hPa) — the FL scale."""
    return (1 - (p / 1013.25) ** 0.190284) * 145366.45


def _interp(pts, z, gap):
    """pts [(ft, u, v, T)] sorted by ft → (u, v, T) at z (linear, neighbours at most gap ft apart)."""
    for a, b in zip(pts, pts[1:]):
        if a[0] <= z <= b[0] and b[0] - a[0] <= gap:
            f = (z - a[0]) / (b[0] - a[0]) if b[0] > a[0] else 0.0
            out = []
            for i in (1, 2, 3):
                x, y = a[i], b[i]
                out.append(None if x is None or y is None else x + f * (y - x))
            return out
    for a in pts:
        if abs(a[0] - z) <= gap / 4:
            return [a[1], a[2], a[3]]
    return [None, None, None]


def _wind(u, v):
    if u is None or v is None:
        return None, None
    return round((math.degrees(math.atan2(-u, -v)) + 360) % 360), round(math.hypot(u, v))


def _tropo(pts):
    """The WMO tropopause of [(ft, T)]: the lowest level above 16 000 ft where the lapse
    rate falls to 2 K/km or less and stays so on average over the next 2 km (6 562 ft) —
    as FL; None when not found below the data's top."""
    pts = [p for p in pts if p[1] is not None]
    for i, (z, t) in enumerate(pts[:-1]):
        if z < 16000:
            continue
        z2, t2 = pts[i + 1]
        if z2 <= z:
            continue
        lapse = -(t2 - t) / ((z2 - z) * 0.0003048)
        if lapse > 2.0:
            continue
        top = [(a, b) for a, b in pts[i:] if a <= z + 6562]
        if len(top) < 2 or top[-1][0] - z < 3000:
            continue
        mean = -(top[-1][1] - t) / ((top[-1][0] - z) * 0.0003048)
        if mean <= 2.0:
            return int(round(z / 100.0))                 # FL
    return None


def aloft(db, cls: str = "T", now: float | None = None) -> dict:
    now = time.time() if now is None else now
    h = int(now // 3600 * 3600)
    out = {"now": int(now), "hour": None, "cls": cls}
    modes = []
    for hh in (h, h - 3600, h - 7200):
        try:
            r = db.execute("SELECT data FROM profile_hours WHERE ts = ?", (hh,)).fetchone()
        except Exception:                              # noqa: BLE001
            r = None
        if r:
            d = _j(r[0]) or {}
            out["hour"], out["ac"] = hh, d.get("a")
            for lv in d.get("lv") or []:
                lo = lv[0]
                mid = lo + (500 if lo < 10000 else 1000)
                t = lv[1] if (lv[4] or 0) >= 3 else None
                u = v = None
                if (lv[8] or 0) >= 3 and lv[5] is not None and lv[6] is not None:
                    u, v = _uv(lv[5], lv[6])
                if t is not None or u is not None:
                    modes.append((mid, u, v, t, lv[9] or 0))
            break
    meps = []
    try:
        r = db.execute("SELECT data FROM meps_ml_hours WHERE ts IN (?, ?) ORDER BY ts DESC, run DESC LIMIT 1", (h, h - 3600)).fetchone()
        a = ((_j(r[0]) if r else None) or {}).get("a") or {}
        for p, t, u, v in zip(a.get("p") or [], a.get("t") or [], a.get("u") or [], a.get("v") or []):
            if p and t is not None and u is not None and v is not None:
                meps.append((_p_alt(p), u, v, t))          # u, v already kt (collector/meps.py)
        meps.sort()
    except Exception:                                  # noqa: BLE001
        pass
    sonde, skey = [], None
    try:
        from collector import sondes as _sondes
        st = _sondes.get()
        k = st.find(now, 15) if st else None
        rec = st.load(k) if k else None
        if rec:
            skey = {"key": k, "launch": int(rec.get("launch") or rec.get("nominal") or 0), "station": rec.get("station")}
            for p, alt, z, t, td, wd, ws in rec.get("lv") or []:
                if alt is None:
                    continue
                u, v = _uv(wd, ws) if wd is not None and ws is not None else (None, None)
                sonde.append((alt, u, v, t))
            sonde.sort()
            # thin to about every 500 ft so the interpolation's gap test holds
            th, last = [], None
            for x in sonde:
                if last is None or x[0] - last >= 400:
                    th.append(x)
                    last = x[0]
            sonde = th
    except Exception:                                  # noqa: BLE001
        sonde = []
    mpts = [(z, u, v, t) for z, u, v, t, n in modes]
    rows = []
    for fl in ALOFT_FL:
        z = fl * 100
        e = {"fl": fl, "isa": _r(_isa(z))}
        for name, pts, gap in (("m", mpts, 2600), ("p", meps, 3000), ("s", sonde, 1500)):
            u, v, t = _interp(pts, z, gap)
            wd, ws = _wind(u, v)
            e[name] = [wd, ws, _r(t)] if (ws is not None or t is not None) else None
        nn = [n for zz, u, v, t, n in modes if abs(zz - z) <= 1000]
        e["n"] = max(nn) if nn else 0
        rows.append(e)
    out["rows"] = rows
    out["sonde"] = skey
    # the profiles for the chart: [ft, kt, °C]
    out["prof"] = {"m": [[z, _wind(u, v)[1], _r(t)] for z, u, v, t in mpts],
                   "p": [[round(z), _wind(u, v)[1], _r(t)] for z, u, v, t in meps if z <= 46000],
                   "s": [[round(z), _wind(u, v)[1], _r(t)] for z, u, v, t in sonde if z <= 46000]}
    out["tropo"] = {k: _tropo([(z, t) for z, u, v, t in pts]) for k, pts in (("m", mpts), ("p", meps), ("s", sonde))}
    # the top of each source (FL): no tropopause found below it = higher than the data
    out["top"] = {k: int(max(z for z, u, v, t in pts if t is not None) // 100) if any(t is not None for *_, t in pts) else None
                  for k, pts in (("m", mpts), ("p", meps), ("s", sonde))}
    jet = {}
    for k, pts in (("m", mpts), ("p", meps), ("s", sonde)):
        best = None
        for z, u, v, t in pts:
            if z < 15000 or u is None:
                continue
            ws = math.hypot(u, v)
            if best is None or ws > best[1]:
                best = (z, ws, u, v)
        if best and best[1] >= 60:
            jet[k] = {"fl": int(round(best[0] / 100.0)), "kt": round(best[1]), "dir": _wind(best[2], best[3])[0]}
    out["jet"] = jet
    return out


# ── Turbulence (from 2026-11-05 evening) ────────────────────────────────────

TURB_BANDS = (0, 1000, 2000, 3000, 4000)


def turbulence(db, minutes: int = 60, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    minutes = minutes if minutes in WINDOW_MIN else 60
    t0 = now - minutes * 60
    bands = {b: {"a": [], "d": []} for b in TURB_BANDS}
    rough = []
    for kind, rows in (("a", db.execute("SELECT ts, callsign, aircraft_type, runway, edr_json FROM approach_history "
                                        "WHERE ts >= ? AND ts < ? AND edr_json IS NOT NULL", (now - 6 * 3600, now)).fetchall()),
                       ("d", db.execute("SELECT ts, callsign, aircraft_type, shear_json, edr_json FROM departure_profiles "
                                        "WHERE ts >= ? AND ts < ? AND ga = 0 AND edr_json IS NOT NULL", (now - 6 * 3600, now)).fetchall())):
        for r in rows:
            e = _j(r[4]) or {}
            if e.get("m") is None:
                continue
            rw = r[3] if kind == "a" else (_j(r[3]) or {}).get("rwy")
            thr = _thr(rw) if rw else APT_FT
            rows_in = r[0] >= t0
            pk = None
            for sg in e.get("seg") or []:
                a = sg.get("a") or []
                if len(a) < 2 or sg.get("e") is None:
                    continue
                lo, hi = min(a) - thr, max(a) - thr
                if pk is None or sg["e"] > pk[0]:
                    pk = (sg["e"], (lo + hi) / 2)
                if rows_in:
                    for b in TURB_BANDS:
                        if lo < b + 1000 and hi > b:
                            bands[b][kind].append(sg["e"])
            yield_row = {"t": int(r[0]), "k": kind, "cs": r[1], "ty": r[2], "rwy": rw, "m": e.get("m"),
                         "pk": pk[0] if pk else e.get("pk"), "at": int(round(pk[1], -2)) if pk else None}
            rough.append(yield_row)
    out_b = []
    for b in TURB_BANDS:
        e = {"lo": b}
        for k in ("a", "d"):
            v = bands[b][k]
            e[k] = [_r(_median(v), 3), _r(max(v), 3), len(v)] if v else None
        out_b.append(e)
    # hour by hour over the last 6 h (both phases)
    hist = []
    h0 = int(now // 3600 * 3600)
    for hh in range(h0 - 5 * 3600, h0 + 1, 3600):
        sel = [x for x in rough if hh <= x["t"] < hh + 3600]
        ms = [x["m"] for x in sel]
        pks = [x["pk"] for x in sel if x["pk"] is not None]
        hist.append({"h": hh, "n": len(sel), "med": _r(_median(ms), 3), "max": _r(max(pks), 3) if pks else None,
                     "mod": sum(1 for p in pks if p >= 0.2)})
    win = sorted([x for x in rough if x["t"] >= t0 and ((x["pk"] or 0) >= 0.2 or (x["m"] or 0) >= 0.1)],
                 key=lambda x: -(x["pk"] or 0))[:10]
    allm = [x["m"] for x in rough if x["t"] >= t0]
    try:
        rep = db.execute("SELECT ts, kind, phen, lo_ft, hi_ft, near FROM pilot_reports WHERE ts >= ? AND ts <= ? "
                         "AND (phen LIKE '%TURB%' OR phen LIKE '%MTW%') ORDER BY ts DESC LIMIT 12",
                         (now - 6 * 3600, now)).fetchall()
        reports = [{"t": int(r[0]), "kind": r[1], "phen": r[2], "lo": r[3], "hi": r[4], "near": bool(r[5])} for r in rep]
    except Exception:                                  # noqa: BLE001
        reports = []
    return {"now": int(now), "min": minutes, "metar": metar(db, now), "bands": out_b, "rough": win,
            "n": len(allm), "med": _r(_median(allm), 3), "hist": hist, "reports": reports}


# ── GNSS for pilots (from 2026-11-05 evening) ───────────────────────────────

GNSS_ZONES = ("all", "50nm", "20nm")        # the receiver's coverage, or within 50 / 20 NM of the airport


def gnss(db, tracker, now: float | None = None, zone: str = "50nm") -> dict:
    """Counts only — no callsigns or positions (the GPS pages, with the aircraft, are
    for the Full view right).

    zone (from 2026-11-11): 'all' = everything the receiver hears, '50nm' (default) or
    '20nm' = only the aircraft within that distance of the airport; it applies to the
    live counts and to the 24 hourly bars alike.  The landings and departures of the
    'apt' part are on final and on the climb-out, inside every zone."""
    now = time.time() if now is None else now
    if zone not in GNSS_ZONES:
        zone = "50nm"
    out = {"now": int(now), "zone": zone, "live": None, "near24": None, "apt": {}}
    if tracker is not None:
        try:
            st = tracker.get_state(zone=zone)
            live = st.get("live") or []
            if zone != "all":
                live = [a for a in live if zone in (a.get("zones") or ())]
            fb = {}
            sev = 0
            for a in live:
                fb[a.get("fl_band") or "?"] = fb.get(a.get("fl_band") or "?", 0) + 1
                if a.get("nac_p") == 0 or a.get("nic") == 0 or "freeze" in (a.get("flags") or []):
                    sev += 1
            out["live"] = {"n": len(live), "sev": sev, "bands": [[b, fb[b]] for b in (st.get("fl_bands") or []) if fb.get(b)]}
            ts = st.get("time_series") or []
            last = [b for b in ts if b["ts"] >= int(now // 3600 * 3600) - 23 * 3600]
            out["near24"] = {"hours": [[b["ts"], b.get("degraded", 0), b.get("total", 0)] for b in last],
                             "degraded": sum(b.get("degraded", 0) for b in last),
                             "peak": (st.get("stats") or {}).get("peak_hour")}
        except Exception:                              # noqa: BLE001
            pass
    for hrs in (6, 24):
        t0 = now - hrs * 3600
        na = da = nd = dd = 0
        for g in db.execute("SELECT gnss_json FROM approach_history WHERE ts >= ? AND ts < ?", (t0, now)):
            b = ((_j(g[0]) or {}).get("bands") or {}).values()
            if not b:
                continue
            na += 1
            if any(x.get("fz") for x in b) or any((x.get("nacp") is not None and x["nacp"] <= 6) for x in b):
                da += 1
        for g in db.execute("SELECT shear_json FROM departure_profiles WHERE ts >= ? AND ts < ? AND ga = 0", (t0, now)):
            s = _j(g[0]) or {}
            if (s.get("v") or 0) < 9:
                continue
            nd += 1
            if s.get("gq"):
                dd += 1
        out["apt"][str(hrs)] = {"a": [da, na], "d": [dd, nd]}
    return out
