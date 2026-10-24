"""
collector/shear.py — low-level windshear from the aircraft's own BDS 5,0
replies on final approach (from 2026-10-24; replaces the six browser
algorithms used May – October 2026, see doc/Windshear_Algorithms_v1_Legacy.pdf).

Method (after the Hong Kong Observatory GLYGA "headwind ramp" alerting,
Shun & Chan 2008, and the 2026-10-24 restudy of 3 084 EFHK landings):

1. Headwind along the track from each BDS 5,0 reply: TAS − GS.  Both values
   come from the same register at the same instant, so no heading, magnetic
   declination or wind-vector calculation is involved (about 1.1 kt of noise,
   0.8 kt of it the 2-kt quantisation).  With a crab angle β the value is
   larger by TAS·(1 − cos β) — about 2 kt at 10°, slowly varying.
   Replies are dropped when banked more than 5°, out of range, repeating the
   previous register content, or more than 12 kt off the ±7.5 s running median.
2. Distance along the path: the reply's ground speed integrated over time —
   not the reported positions, which freeze under GNSS jamming.  Height is the
   barometric altitude (ft MSL) of the tracker's sweep.
3. Profile: running mean over 400 m of path, on a 100-m grid (at least two
   replies in each window).
4. Ramps: headwind change ΔV between two points of the profile L = 400 …
   4 000 m apart, in the direction of flight (negative = loss).  Scaled to a
   1-km equivalent ΔV·(1 km / L)^⅓ (the GLYGA / flight-data-recorder scaling):
   a sudden change counts more than the same change spread over kilometres,
   so the normal increase of the wind with height ("gentle ramps") stays below
   the levels.  At least 60 % of the ramp must have data.
5. Horizontal F-factor over 1 km: rate of headwind loss / g (the downdraft
   term of the F-factor cannot be observed).
6. Levels (1-km equivalent, loss or gain; ramps below 1 600 ft above the
   threshold or within 5 NM):  advisory ≥ 10 kt · WSA (windshear alert)
   ≥ 15 kt · MBA (microburst alert) ≥ 30 kt loss.

band_anomaly() adds the change in time: an aircraft's 200-ft band headwinds
against the median of the landings and departures on the same runway direction
in the previous 45 minutes — a front or gust front shows as a change between
flights.  dep_bands() gives the band headwinds of a climb-out (from
2026-10-24), so departures are compared too and fill the gaps between the
arrival waves.

Pure Python, no I/O.  Used live by collector/windshear.py for each aircraft on
final (every sweep) and once per landing for the stored windshear report.
"""

from __future__ import annotations

import math

KT = 0.514444                 # m/s per kt
G = 9.80665

MAX_ROLL = 5.0                # ° — replies banked more than this are not used
REPEAT_SEC = 6.0              # same GS and TAS as the previous reply within this = repeated register
SPIKE_KT = 12.0               # off the running median by more than this = dropped
MED_HALF_SEC = 7.5
SMOOTH_M = 400.0              # running-mean window along the path
GRID_M = 100.0
RAMP_LENGTHS = (400, 600, 800, 1000, 1500, 2000, 3000, 4000)
RAMP_MIN_COVER = 0.6          # share of the ramp with profile data
RAMP_MIN_SIG = 5.0            # ΔV at least this many times its own noise (σ of the two window means)
SHORT_MIN_N = 3               # replies needed in each end window of a short ramp
SHORT_RAMP_M = 600            # ramps this short must persist …
PERSIST_M = 400               # … over the next 400 m (not bounce back by more than half)
DEFAULT_NOISE = 1.2           # kt per reply when the approach's own noise is not known
ZONE_FT = 1600.0              # ICAO low-level windshear zone (above threshold) …
ZONE_NM = 5.0                 # … or within this distance of the threshold

LEVEL_ADVISORY = 10.0         # kt, 1-km equivalent
LEVEL_WSA = 15.0
LEVEL_MBA = 30.0              # loss only

BAND_WINDOW_SEC = 45 * 60     # reference landings for the band anomaly
BAND_MIN_REF = 3
BAND_ADVISORY = 10.0          # kt
BAND_WSA = 15.0
BAND_MAX_FT = 1800            # bands compared: up to the top of the low-level zone (ft MSL)

# Departures in the band comparison (from 2026-10-24): climb-out replies with
# the track within DEP_TRACK_TOL of the runway direction; a departure climbs
# 4–5× faster than a 3° glide path, so each band takes the replies within
# ±DEP_BAND_TOL_FT (overlapping 400-ft windows) and needs DEP_MIN_N of them.
# TAS − GS of the climb-outs was DEP_HW_BIAS kt larger than that of the landings
# in the same bands and 45 minutes (9–23 Oct 2026, 1 946 replies, constant with
# height); it is subtracted so departures and landings share one scale.
DEP_TRACK_TOL = 15.0          # °
DEP_BAND_TOL_FT = 200.0
DEP_MIN_N = 2
DEP_HW_BIAS = 2.3             # kt

LEVELS = ("none", "adv", "wsa", "mba")


def level_of(sc_kt: float | None, loss: bool) -> str:
    """Level of a 1-km-equivalent ramp (kt, magnitude)."""
    if sc_kt is None:
        return "none"
    if loss and sc_kt >= LEVEL_MBA:
        return "mba"
    if sc_kt >= LEVEL_WSA:
        return "wsa"
    if sc_kt >= LEVEL_ADVISORY:
        return "adv"
    return "none"


def band_level(a_kt: float | None) -> str:
    if a_kt is None:
        return "none"
    a = abs(a_kt)
    return "wsa" if a >= BAND_WSA else "adv" if a >= BAND_ADVISORY else "none"


def _interp(ts: list, vs: list, t: float):
    """Linear interpolation of vs(ts) at t (ts ascending; None outside ±10 s)."""
    if not ts:
        return None
    if t <= ts[0]:
        return vs[0] if ts[0] - t <= 10 else None
    if t >= ts[-1]:
        return vs[-1] if t - ts[-1] <= 10 else None
    lo, hi = 0, len(ts) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if ts[mid] <= t:
            lo = mid
        else:
            hi = mid
    t0, t1 = ts[lo], ts[hi]
    if vs[lo] is None or vs[hi] is None:
        return vs[lo] if vs[hi] is None else vs[hi]
    w = (t - t0) / (t1 - t0) if t1 > t0 else 0.0
    return vs[lo] + (vs[hi] - vs[lo]) * w


def _points(b50: list, sw: list):
    """Accepted replies as dicts {t, hw, gs, alt, d} in time order, the residual
    noise (kt RMS about the running median) and the number dropped."""
    raw = []
    prev = None
    for row in sorted((r for r in b50 if r and r[0] is not None), key=lambda r: r[0]):
        t, roll, _trate, _trk, gs, tas = row[:6]
        alt = row[6] if len(row) > 6 else None
        if gs is None or tas is None or roll is None or abs(roll) > MAX_ROLL:
            continue
        if not (60 <= gs <= 280 and 80 <= tas <= 260) or abs(tas - gs) > 80:
            continue
        if prev is not None and gs == prev[1] and tas == prev[2] and t - prev[0] < REPEAT_SEC:
            continue
        prev = (t, gs, tas)
        raw.append({"t": float(t), "hw": float(tas - gs), "gs": float(gs), "alt": alt})
    if len(raw) < 6:
        return [], None, 0
    # running median ±7.5 s → spikes out, residual noise
    n = len(raw)
    keep, res = [], []
    j0 = 0
    for i in range(n):
        while raw[j0]["t"] < raw[i]["t"] - MED_HALF_SEC:
            j0 += 1
        j1 = i
        while j1 + 1 < n and raw[j1 + 1]["t"] <= raw[i]["t"] + MED_HALF_SEC:
            j1 += 1
        w = sorted(p["hw"] for p in raw[j0:j1 + 1])
        m = len(w)
        med = w[m // 2] if m % 2 else 0.5 * (w[m // 2 - 1] + w[m // 2])
        e = raw[i]["hw"] - med
        if abs(e) > SPIKE_KT:
            continue
        keep.append(raw[i])
        if m >= 3:
            res.append(e)
    dropped = n - len(keep)
    # distance along the path (m): ground speed integrated over time
    x = 0.0
    for k, p in enumerate(keep):
        if k:
            q = keep[k - 1]
            dt = p["t"] - q["t"]
            if dt > 30:                       # long gap: do not bridge a big hole blindly
                dt = 30
            x += 0.5 * (p["gs"] + q["gs"]) * KT * dt
        p["x"] = x
    # height and distance to the threshold from the sweeps (by time)
    st = [r[0] for r in sw if r and r[0] is not None]
    sa = [r[1] for r in sw if r and r[0] is not None]
    sd = [r[3] for r in sw if r and r[0] is not None]
    for p in keep:
        if p["alt"] is None:
            p["alt"] = _interp(st, sa, p["t"])
        p["d"] = _interp(st, sd, p["t"])
    noise = math.sqrt(sum(e * e for e in res) / len(res)) if len(res) >= 5 else None
    return keep, noise, dropped


def _profile(pts: list):
    """Grid (100 m) of the 400-m running mean: list of (x, hw|None, alt|None,
    d|None, t|None, replies)."""
    if not pts:
        return []
    x1 = pts[-1]["x"]
    half = SMOOTH_M / 2
    out = []
    j0 = 0
    n = len(pts)
    g = 0.0
    while g <= x1 + 1e-6:
        while j0 < n and pts[j0]["x"] < g - half:
            j0 += 1
        j = j0
        s = sa = sd = stt = 0.0
        c = ca = cd = 0
        while j < n and pts[j]["x"] <= g + half:
            p = pts[j]
            s += p["hw"]; stt += p["t"]; c += 1
            if p["alt"] is not None:
                sa += p["alt"]; ca += 1
            if p["d"] is not None:
                sd += p["d"]; cd += 1
            j += 1
        if c >= 2:
            out.append((g, s / c, sa / ca if ca else None, sd / cd if cd else None, stt / c, c))
        else:
            out.append((g, None, None, None, None, c))
        g += GRID_M
    return out


def _in_zone(alt, d, thr_ft):
    return ((alt is not None and alt - thr_ft <= ZONE_FT) or (d is not None and d <= ZONE_NM))


def analyze(b50: list, sw: list, thr_ft: float = 179.0) -> dict | None:
    """Windshear analysis of one approach (or of an approach in progress).

    b50: BDS 5,0 rows [t, roll, track rate, track, GS, TAS, alt ft MSL];
    sw:  sweep rows   [t, alt ft MSL, pressure alt, dist to threshold NM, …].
    Returns None without enough data, else
      {"n": replies, "drop": dropped, "noise": kt, "len": path m,
       "a": [highest, lowest] ft MSL, "d": [far, near] NM,
       "loss" / "gain": strongest ramp {"dv": kt, "sc": 1-km equivalent kt,
                        "L": m, "a1", "a2": ft MSL (start → end), "d1", "d2": NM,
                        "t2": time of the ramp end, "zone": in the alert zone}
                        (the strongest in the zone when there is one),
       "fh": horizontal F-factor over 1 km (loss > 0) with "fh_a" ft MSL,
       "lvl": "none" | "adv" | "wsa" | "mba"}."""
    pts, noise, dropped = _points(b50 or [], sw or [])
    if len(pts) < 8:
        return None
    prof = _profile(pts)
    if len(prof) < 5:
        return None
    hw = [p[1] for p in prof]
    sig1 = noise if noise is not None else DEFAULT_NOISE
    kp = int(round(PERSIST_M / GRID_M))
    best = {"loss": None, "gain": None}
    best_any = {"loss": None, "gain": None}
    for L in RAMP_LENGTHS:
        k = int(round(L / GRID_M))
        if k >= len(prof):
            break
        scale = (1000.0 / L) ** (1.0 / 3.0)
        need = RAMP_MIN_COVER * (k + 1)
        # valid-count prefix for the coverage test
        pref = [0]
        for v in hw:
            pref.append(pref[-1] + (v is not None))
        for i in range(len(prof) - k):
            a, b = hw[i], hw[i + k]
            if a is None or b is None or pref[i + k + 1] - pref[i] < need:
                continue
            dv = b - a
            # significance against the replies' own noise
            if abs(dv) < RAMP_MIN_SIG * sig1 * math.sqrt(1.0 / prof[i][5] + 1.0 / prof[i + k][5]):
                continue
            # short ramps must persist: no bounce back by more than half over the next 400 m
            if L <= SHORT_RAMP_M:
                if prof[i][5] < SHORT_MIN_N or prof[i + k][5] < SHORT_MIN_N:
                    continue
                nxt = [v for v in hw[i + k + 1:i + k + 1 + kp] if v is not None]
                if len(nxt) < kp // 2:
                    continue
                if abs(sum(nxt) / len(nxt) - a) < 0.5 * abs(dv):
                    continue
            sc = abs(dv) * scale
            kind = "loss" if dv < 0 else "gain"
            p1, p2 = prof[i], prof[i + k]
            cand = {"dv": round(dv, 1), "sc": round(sc, 1), "L": int(L),
                    "a1": None if p1[2] is None else int(round(p1[2])),
                    "a2": None if p2[2] is None else int(round(p2[2])),
                    "d1": None if p1[3] is None else round(p1[3], 2),
                    "d2": None if p2[3] is None else round(p2[3], 2),
                    "t2": None if p2[4] is None else round(p2[4], 1)}
            zone = _in_zone(p2[2], p2[3], thr_ft) or _in_zone(p1[2], p1[3], thr_ft)
            cand["zone"] = zone
            cur = best_any[kind]
            if cur is None or sc > cur["sc"]:
                best_any[kind] = cand
            if zone:
                cur = best[kind]
                if cur is None or sc > cur["sc"]:
                    best[kind] = cand
    # horizontal F-factor over 1 km (loss positive)
    fh, fh_a = None, None
    k = int(round(1000 / GRID_M))
    for i in range(len(prof) - k):
        a, b = hw[i], hw[i + k]
        if a is None or b is None:
            continue
        p1, p2 = prof[i], prof[i + k]
        if p1[4] is None or p2[4] is None or p2[4] <= p1[4]:
            continue
        f = -(b - a) * KT / (p2[4] - p1[4]) / G
        if fh is None or f > fh:
            fh, fh_a = f, p2[2]
    # 200-ft band means of the cleaned replies (for the band comparison)
    bsum: dict = {}
    for p in pts:
        if p["alt"] is None:
            continue
        b = int(round(p["alt"] / 200.0)) * 200
        if 200 <= b <= 3000 and abs(p["alt"] - b) <= 100:
            bsum.setdefault(b, []).append(p["hw"])
    bands = {str(b): round(sum(v) / len(v), 1) for b, v in sorted(bsum.items()) if len(v) >= 2}
    out = {"n": len(pts), "drop": dropped,
           "noise": None if noise is None else round(noise, 2),
           "len": int(round(pts[-1]["x"])),
           "a": [_r0(max((p["alt"] for p in pts if p["alt"] is not None), default=None)),
                 _r0(min((p["alt"] for p in pts if p["alt"] is not None), default=None))],
           "d": [_r2(max((p["d"] for p in pts if p["d"] is not None), default=None)),
                 _r2(min((p["d"] for p in pts if p["d"] is not None), default=None))],
           "fh": None if fh is None else round(fh, 3),
           "fh_a": _r0(fh_a), "bd": bands}
    for kind in ("loss", "gain"):
        out[kind] = best[kind] or best_any[kind]
    lv_loss = level_of(best["loss"]["sc"], True) if best["loss"] else "none"
    lv_gain = level_of(best["gain"]["sc"], False) if best["gain"] else "none"
    out["lvl"] = max(lv_loss, lv_gain, key=LEVELS.index)
    return out


def _hdg_diff(a: float, b: float) -> float:
    return abs((a - b + 180.0) % 360.0 - 180.0)


def dep_bands(b50: list, axis: float) -> dict | None:
    """Band headwinds of a climb-out on the runway direction `axis` (°):
    b50 rows as in analyze() (alt = interpolated ft MSL).  Only replies with
    the track within DEP_TRACK_TOL of the axis (TAS − GS is the headwind along
    the track); same cleaning as on final.  {"n": replies, "noise": kt,
    "bd": {band: kt}} with DEP_HW_BIAS removed, or None."""
    rows = [r for r in b50 if r and len(r) > 6 and r[3] is not None
            and _hdg_diff(float(r[3]), float(axis)) <= DEP_TRACK_TOL]
    pts, noise, _dropped = _points(rows, [])
    if not pts:
        return None
    bd = {}
    for b in range(200, 3001, 200):
        v = [p["hw"] for p in pts if p["alt"] is not None and abs(p["alt"] - b) <= DEP_BAND_TOL_FT]
        if len(v) >= DEP_MIN_N:
            bd[str(b)] = round(sum(v) / len(v) - DEP_HW_BIAS, 1)
    if not bd:
        return None
    return {"n": len(pts), "noise": None if noise is None else round(noise, 2), "bd": bd}


def band_means(rep: dict | None) -> dict:
    """{band ft: headwind kt} of an analysis (its cleaned 200-ft band means)."""
    return {int(b): float(v) for b, v in ((rep or {}).get("bd") or {}).items()}


def band_anomaly(bands: dict, refs: list, max_band: float = BAND_MAX_FT) -> dict | None:
    """Largest difference of this aircraft's band headwinds from the mean of
    the reference landings (list of {band: hw}); bands with fewer than
    BAND_MIN_REF references are skipped.  {"b": band ft, "a": kt (+ = more
    headwind than before), "ref": median kt, "n": references, "lvl": level}.
    The median keeps one odd reference landing from moving the reference."""
    best = None
    for b, hw in bands.items():
        if b > max_band:
            continue
        vals = sorted(r[b] for r in refs if b in r)
        if len(vals) < BAND_MIN_REF:
            continue
        n = len(vals)
        m = vals[n // 2] if n % 2 else 0.5 * (vals[n // 2 - 1] + vals[n // 2])
        a = hw - m
        if best is None or abs(a) > abs(best["a"]):
            best = {"b": b, "a": round(a, 1), "ref": round(m, 1), "n": len(vals)}
    if best:
        best["lvl"] = band_level(best["a"])
    return best


def _r0(v):
    return None if v is None else int(round(v))


def _r2(v):
    return None if v is None else round(v, 2)


def refs_from(history: list, ts: float, heading) -> list:
    """Band headwinds ({band: kt}) of the landings — and departures — in
    history (records with "ts", "rwy_heading" and "shear") on the same runway
    direction within BAND_WINDOW_SEC before ts."""
    out = []
    for e in history:
        t = e.get("ts") or 0
        if not (ts - BAND_WINDOW_SEC <= t < ts) or e.get("rwy_heading") != heading:
            continue
        bm = band_means(e.get("shear"))
        if bm:
            out.append(bm)
    return out


def report(rep: dict | None, band: dict | None) -> dict | None:
    """The stored windshear report of one landing (approach_history.shear_json):
    the analysis plus the band comparison "band" and the overall level "lvl"."""
    if rep is None and band is None:
        return None
    out = dict(rep or {})
    for k in ("loss", "gain"):
        if out.get(k):
            out[k] = {kk: vv for kk, vv in out[k].items() if kk != "t2"}
    if band:
        out["band"] = band
    lv = [out.get("lvl") or "none", (band or {}).get("lvl") or "none"]
    out["lvl"] = max(lv, key=LEVELS.index)
    out["v"] = 2
    return out
