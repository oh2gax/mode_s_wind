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

band_anomaly() adds the change in time: the aircraft's wind in each 200-ft
band (400–1 800 ft MSL) against the median wind of all landings and
departures of the previous 45 minutes, whatever their runway, projected on
the aircraft's own direction (+ = more headwind than before) — a front or gust
front shows as a change between flights.  From the evening of 24 Oct 2026 it
uses the heading-calibrated wind vectors per band (prof_json, every flight
has them), not TAS − GS: TAS − GS is the headwind along the flight's own
track only, so flights on other runway directions could not be compared, and
at Helsinki-Vantaa 55 % of the departures had no landing on their own runway
direction in the previous 45 minutes (land 15 / depart 22R).  Replay 9–24 Oct
2026: ≥ 15 kt in 0.13 % of the landings and 0.30 % of the departures, among
them the wind change of 17 Oct (a departure ten minutes before the landings)
and a departure at 04:42 UTC on 24 Oct during the night-time frontal passage.

confirmation() (from 27 Oct 2026) labels a ramp alert confirmed or isolated
by the other landings on the same runway direction within ±15 min (a label
only, see CONFIRM_WINDOW_SEC).

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
# Advisory from a ramp (from 26 Oct 2026, REPORT_V 4): a ramp of 10–12 kt per
# km is an advisory only when it is also LEVEL_ADVISORY beyond the change the
# other flights of the last 45 min had over the same altitudes (their median
# band winds along this runway) — so the normal increase of the wind with
# height in a stable evening boundary layer (25 Oct: 20 kt at 400 ft, 35 kt
# at 1 800 ft; 10 of 39 landings flagged) is no longer an advisory.  At or
# above RAMP_ADV_ABS, and with no references (quiet night), the ramp alone
# decides as before; windshear and microburst alerts are never relative.
RAMP_ADV_ABS = 12.0

BAND_WINDOW_SEC = 45 * 60     # reference landings for the band anomaly
BAND_MIN_REF = 3
BAND_ADVISORY = 10.0          # kt
BAND_WSA = 15.0
BAND_MAX_FT = 1800            # bands compared: up to the top of the low-level zone (ft MSL)

# Band wind vectors (prof_json per 200-ft band: n wind pairs, ws, wd, sd)
VEC_MIN_FT = 400              # lowest band compared (few replies below)
VEC_MAX_WS = 80.0             # kt — a band mean above this at low level is a corrupt reply
VEC_MAX_SD = 15.0             # kt — spread of the band's wind pairs above this: not used
VEC_MIN_N_ARR = 2             # wind pairs needed in a band of a landing
VEC_MIN_N_DEP = 1             # … of a departure (they climb 4–5× faster); a single-pair band
                              #     alerts only when a neighbouring band agrees
REPORT_V = 5                  # report version (3: band comparison on the wind vector,
                              #     4: ramp advisories relative to the reference profile,
                              #     5: band comparison by flight phase, see PHASE_HW_BIAS)

# Band comparison by flight phase (from 27 Oct 2026, REPORT_V 5).  Against the
# MEPS model (area mean, model levels, 600–1 800 ft, 9–26 Oct 2026) the band
# winds of the landings read 1.45 kt less and those of the departures 1.38 kt
# more headwind along the flight's own direction (9 439 / 6 789 bands, every
# runway direction, largest in steady flight) — an airspeed effect of the
# flight phase, not a real wind difference.  So a flight is compared with the
# flights of its own phase when there are at least PHASE_MIN_REF (5) of them in the
# band (landings with landings, departures with departures); otherwise with
# all of them, each reference vector and the flight's own headwind first
# corrected by its phase's bias along its own direction.
PHASE_HW_BIAS = {"arr": -1.45, "dep": +1.38}   # kt, measured − true headwind along the own direction
PHASE_MIN_REF = 5             # same-phase references needed in a band to use them alone

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


def vec_bands(prof: dict | None, min_n: int = VEC_MIN_N_ARR, max_band: float = BAND_MAX_FT) -> dict:
    """{band ft: (u, v kt towards east / north, wind pairs)} from a band profile
    in the prof_json format ({"band": {"n", "ws", "wd", "sd", …}}), bands
    VEC_MIN_FT … max_band with at least min_n pairs; corrupt bands (mean above
    VEC_MAX_WS, spread above VEC_MAX_SD) are left out."""
    out = {}
    for b, v in (prof or {}).items():
        try:
            b = int(b)
        except (TypeError, ValueError):
            continue
        if not (VEC_MIN_FT <= b <= max_band) or not isinstance(v, dict):
            continue
        n, ws, wd = v.get("n") or 0, v.get("ws"), v.get("wd")
        if n < min_n or ws is None or wd is None or ws > VEC_MAX_WS or (v.get("sd") or 0) > VEC_MAX_SD:
            continue
        r = math.radians(wd)
        out[b] = (-ws * math.sin(r), -ws * math.cos(r), n)
    return out


def vec_refs(history: list, ts: float) -> list:
    """Band wind vectors ({band: (u, v, n)}) of the flights in history (records
    with "ts" and "prof" or "bv"; landings and departures, any runway) within
    BAND_WINDOW_SEC before ts.  Each is a Ref (a dict) that also carries the
    flight's phase .ph ("arr" — the default, a record with "ph": "dep" is a
    departure) and direction .hdg (° true: "hdg", else "rwy_heading"; None
    when not known)."""
    out = []
    for e in history:
        t = e.get("ts") or 0
        if not (ts - BAND_WINDOW_SEC <= t < ts):
            continue
        bv = e.get("bv")
        if bv is None:
            bv = vec_bands(e.get("prof"), 1)
        if bv:
            r = Ref(bv)
            r.ph = e.get("ph") or "arr"
            h = e.get("hdg")
            r.hdg = h if h is not None else e.get("rwy_heading")
            out.append(r)
    return out


class Ref(dict):
    """Band wind vectors of one reference flight ({band: (u, v, n)}) with its
    phase .ph ("arr" / "dep") and direction .hdg (° true or None)."""
    ph = "arr"
    hdg = None


def _median(v: list) -> float:
    v = sorted(v)
    n = len(v)
    return v[n // 2] if n % 2 else 0.5 * (v[n // 2 - 1] + v[n // 2])


def _ref_vec(r, b: int, corr: bool):
    """(u, v) of reference r in band b, corrected by its phase's headwind bias
    along its own direction when corr (w_true = w_measured + bias · d)."""
    u, v, _n = r[b]
    rb, rh = PHASE_HW_BIAS.get(getattr(r, "ph", None)), getattr(r, "hdg", None)
    if corr and rb is not None and rh is not None:
        hr = math.radians(rh)
        u, v = u + rb * math.sin(hr), v + rb * math.cos(hr)
    return u, v


def band_anomaly(bands: dict, refs: list, heading: float, max_band: float = BAND_MAX_FT,
                 phase: str | None = None) -> dict | None:
    """Largest change of this flight's band wind from the median wind of the
    reference flights (list of {band: (u, v, n)}, Refs from vec_refs), as the
    headwind component along `heading` (the flight's direction, ° true; + =
    more headwind than before).  Bands with fewer than BAND_MIN_REF references
    are skipped.  phase ("arr" / "dep", from REPORT_V 5): the flights of the
    same phase are used when a band has at least PHASE_MIN_REF of them, else all;
    references and the flight itself corrected by PHASE_HW_BIAS (None: all
    references, uncorrected — as before 27 Oct 2026).
    {"b": band ft, "a": kt, "ref": the references' headwind kt, "n": references,
     "np": wind pairs of the band, "dv": vector change kt, "ph": "same" / "all"
     (with phase), "lvl": level}.
    A band resting on a single wind pair gets a level only when a neighbouring
    band (± 200 ft) shows a change of at least BAND_ADVISORY the same way."""
    if heading is None:
        return None
    hr = math.radians(heading)
    ex, ey = math.sin(hr), math.cos(hr)
    own_b = PHASE_HW_BIAS.get(phase, 0.0) if phase else 0.0
    per = {}
    for b, (u, v, n) in bands.items():
        if b > max_band:
            continue
        allr = [r for r in refs if b in r]
        use, mode = allr, "all"
        if phase:
            same = [r for r in allr if getattr(r, "ph", "arr") == phase]
            if len(same) >= PHASE_MIN_REF:
                use, mode = same, "same"
        if len(use) < BAND_MIN_REF:
            continue
        rs = [_ref_vec(r, b, bool(phase)) for r in use]
        mu, mv = _median([x[0] for x in rs]), _median([x[1] for x in rs])
        uc, vc = u + own_b * ex, v + own_b * ey          # own vector corrected the same way
        hw, hw0 = -(uc * ex + vc * ey), -(mu * ex + mv * ey)
        per[b] = {"b": b, "a": round(hw - hw0, 1), "ref": round(hw0, 1), "n": len(rs), "np": n,
                  "dv": round(math.hypot(uc - mu, vc - mv), 1)}
        if phase:
            per[b]["ph"] = mode
    if not per:
        return None
    best = max(per.values(), key=lambda x: abs(x["a"]))
    best = dict(best)
    lvl = band_level(best["a"])
    if lvl != "none" and best["np"] < 2:
        nb = [per.get(best["b"] + d) for d in (-200, 200)]
        if not any(x and x["a"] * best["a"] > 0 and abs(x["a"]) >= BAND_ADVISORY for x in nb):
            lvl = "none"
    best["lvl"] = lvl
    return best


def _ref_headwind(refs: list, heading: float) -> dict:
    """{band ft: median headwind kt along heading} of the reference flights
    (bands with at least BAND_MIN_REF of them)."""
    hr = math.radians(heading)
    ex, ey = math.sin(hr), math.cos(hr)
    acc: dict = {}
    for r in refs:
        for b, (u, v, _n) in r.items():
            acc.setdefault(b, []).append((u, v))
    out = {}
    for b, uv in acc.items():
        if len(uv) >= BAND_MIN_REF:
            mu, mv = _median([x[0] for x in uv]), _median([x[1] for x in uv])
            out[b] = -(mu * ex + mv * ey)
    return out


def _at_alt(prof: dict, a: float):
    """prof {band ft: kt} interpolated at a (ft); None more than 200 ft
    outside the bands or across a gap of more than 400 ft."""
    if not prof or a is None:
        return None
    ks = sorted(prof)
    if a <= ks[0]:
        return prof[ks[0]] if ks[0] - a <= 200 else None
    if a >= ks[-1]:
        return prof[ks[-1]] if a - ks[-1] <= 200 else None
    for k0, k1 in zip(ks, ks[1:]):
        if k0 <= a <= k1:
            if k1 - k0 > 400:
                return None
            return prof[k0] + (prof[k1] - prof[k0]) * (a - k0) / (k1 - k0)
    return None


def ramp_rel_level(c: dict | None, loss: bool, ref_hw: dict | None) -> str:
    """Level of one ramp (report "loss" / "gain") with the advisory relative
    to the reference profile (see RAMP_ADV_ABS).  Adds to c "exp" (the change
    the reference flights had from a1 to a2, kt) and "rel" (the ramp beyond
    it, 1-km equivalent kt) when they could be computed."""
    if not c or c.get("sc") is None:
        return "none"
    lv = level_of(c["sc"], loss)
    if lv != "adv" or c["sc"] >= RAMP_ADV_ABS or not ref_hw:
        return lv
    e1, e2 = _at_alt(ref_hw, c.get("a1")), _at_alt(ref_hw, c.get("a2"))
    dv = c.get("dv")
    if e1 is None or e2 is None or not dv:
        return lv
    exp = e2 - e1
    an = dv - exp
    rel = abs(an) * c["sc"] / abs(dv) if (an < 0) == loss else 0.0
    c["exp"], c["rel"] = round(exp, 1), round(rel, 1)
    return "adv" if rel >= LEVEL_ADVISORY else "none"


def ramps_level(rep: dict | None, refs: list | None, heading) -> str:
    """Level of the ramps in the low-level zone of an analysis / stored
    report, advisories relative to the reference flights (refs as from
    vec_refs, heading ° true; without them the ramps alone)."""
    ref_hw = _ref_headwind(refs, heading) if refs and heading is not None else None
    lv = "none"
    for k, loss in (("loss", True), ("gain", False)):
        c = (rep or {}).get(k)
        if c and c.get("zone"):
            lv = max(lv, ramp_rel_level(c, loss, ref_hw), key=LEVELS.index)
    return lv


# ── Confirmation of ramp alerts by the neighbouring landings (from 27 Oct 2026) ──
# A ramp alert is "confirmed" when another landing on the same runway direction
# within ±CONFIRM_WINDOW_SEC had a ramp of the same sign (loss / gain) of at
# least CONFIRM_MIN_SC kt per 1 km whose middle lies within ±CONFIRM_ALT_FT of
# this one's — a shear layer or a front shows to several aircraft, a turbulent
# eddy (strong wind over land) to one.  Only a label: the alert level is not
# changed (the first aircraft into a new shear is always alone at that moment).
# 26 Oct 2026, a turbulent southerly day (ACI median 4.2): of 36 ramp-flagged
# landings since 9 Oct, 12 had no confirming neighbour; the shear layer at
# 1 150–1 350 ft on 22L at 13:08 UTC was confirmed by 4.
CONFIRM_WINDOW_SEC = 15 * 60
CONFIRM_ALT_FT = 300.0
CONFIRM_MIN_SC = 7.0


def rwy_dir(runway) -> str:
    """Runway direction of a designator: '04L' / '04R' → '04', '15' → '15'."""
    s = str(runway or "")
    return s[:2] if s[:2].isdigit() else s


def _ramp_mid(c: dict | None):
    if not c or c.get("a1") is None or c.get("a2") is None:
        return None
    return 0.5 * (c["a1"] + c["a2"])


def alert_ramp(rep: dict | None):
    """(kind, ramp) of the strongest ramp of a report or analysis in the
    low-level zone at advisory strength or more, or (None, None)."""
    best = (None, None)
    for k in ("loss", "gain"):
        c = (rep or {}).get(k)
        if c and c.get("zone") and (c.get("sc") or 0) >= LEVEL_ADVISORY:
            if best[1] is None or c["sc"] > best[1]["sc"]:
                best = (k, c)
    return best


def confirm_count(kind: str, c: dict, others: list) -> int:
    """Number of other landings (their windshear reports) with a ramp of the
    same kind, ≥ CONFIRM_MIN_SC kt per 1 km, middle within ±CONFIRM_ALT_FT."""
    m = _ramp_mid(c)
    if m is None:
        return 0
    n = 0
    for o in others:
        oc = (o or {}).get(kind)
        om = _ramp_mid(oc)
        if om is not None and (oc.get("sc") or 0) >= CONFIRM_MIN_SC and abs(om - m) <= CONFIRM_ALT_FT:
            n += 1
    return n


def confirmation(rep: dict | None, before: list, after: list | None = None) -> dict | None:
    """Confirmation of a report's ramp alert: {"k": kind, "b": confirming
    landings before, "nb": landings before checked, "a" / "na": the same after
    (None until the following window has passed), "fin": final}.  before /
    after: the reports of the landings on the same runway direction within
    CONFIRM_WINDOW_SEC.  None when the report has no ramp at advisory level."""
    kind, c = alert_ramp(rep)
    if c is None:
        return None
    out = {"k": kind, "b": confirm_count(kind, c, before), "nb": len(before),
           "a": None, "na": None, "fin": False}
    if after is not None:
        out.update({"a": confirm_count(kind, c, after), "na": len(after), "fin": True})
    return out


def _r0(v):
    return None if v is None else int(round(v))


def _r2(v):
    return None if v is None else round(v, 2)


def report(rep: dict | None, band: dict | None, refs: list | None = None,
           heading=None) -> dict | None:
    """The stored windshear report of one landing (approach_history.shear_json):
    the analysis plus the band comparison "band" and the overall level "lvl"
    (ramp advisories relative to the reference flights refs, see RAMP_ADV_ABS)."""
    if rep is None and band is None:
        return None
    out = dict(rep or {})
    for k in ("loss", "gain"):
        if out.get(k):
            out[k] = {kk: vv for kk, vv in out[k].items() if kk != "t2"}
    if band:
        out["band"] = band
    if rep is not None:
        out["lvl"] = ramps_level(out, refs, heading)
    lv = [out.get("lvl") or "none", (band or {}).get("lvl") or "none"]
    out["lvl"] = max(lv, key=LEVELS.index)
    out["v"] = REPORT_V
    return out


def ramp_level(rep: dict | None) -> str:
    """Level of the ramps alone of a stored report (its loss / gain in the
    low-level zone), to recombine it with a new band comparison."""
    lv = "none"
    for k, loss in (("loss", True), ("gain", False)):
        c = (rep or {}).get(k)
        if c and c.get("zone"):
            lv = max(lv, level_of(c.get("sc"), loss), key=LEVELS.index)
    return lv
