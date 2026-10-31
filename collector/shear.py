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
   ≥ 15 kt · MBA (microburst alert) ≥ 30 kt loss.  From v7 (28 Oct 2026) a
   WSA or MBA also needs the headwind change itself to be ≥ 14 kt
   (RAMP_WSA_MIN_DV, as the HKO lidar alerting); a shorter change stays an
   advisory.  Only ramps under 1 km are affected: from 1 km up the 1-km
   equivalent is never larger than the change itself.

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
# WSA / MBA from a ramp need |ΔV| ≥ this as well (from 28 Oct 2026, REPORT_V 7).
# The HKO lidar system (GLYGA; Shun & Chan 2008, Hon & Chan 2021) alerts on the
# headwind change itself (≥ 14 kt) and uses ΔV/L^⅓ only to rank ramps.  Here
# the 1-km scaling lifts a 400-m ramp by 1.36, so changes of 11 kt measured by
# three or four replies at each end became WSAs (26 Oct 2026: FIN7SM, FIN9EJ).
# Replay 9–28 Oct 2026 (4 155 landings): ramp WSAs 3 → 1, advisories 83 → 85;
# limits of 12–15 kt give the same.  14 rather than 15: the 400-m running mean
# flattens short, sharp changes a little.  See the study log, Phase 6.
RAMP_WSA_MIN_DV = 14.0
# Advisory from a ramp (from 26 Oct 2026, REPORT_V 4): a ramp of 10–12 kt per
# km is an advisory only when it is also LEVEL_ADVISORY beyond the change the
# other flights of the last 45 min had over the same altitudes (their median
# band winds along this runway) — so the normal increase of the wind with
# height in a stable evening boundary layer (25 Oct: 20 kt at 400 ft, 35 kt
# at 1 800 ft; 10 of 39 landings flagged) is no longer an advisory.  At or
# above RAMP_ADV_ABS, and with no references (quiet night), the ramp alone
# decides as before; windshear and microburst alerts are never relative.
RAMP_ADV_ABS = 12.0

HP_BIN_FT, HP_LO_FT, HP_HI_FT = 100, 200, 5000   # fine headwind profile "hp" (from 31 Oct 2026)
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
REPORT_V = 8                  # report version (3: band comparison on the wind vector,
                              #     4: ramp advisories relative to the reference profile,
                              #     5: band comparison by flight phase, see PHASE_HW_BIAS,
                              #     6: higher band limits for turboprop departures, see TP_DEP_SCALE,
                              #     7: WSA / MBA from a ramp only with |ΔV| ≥ RAMP_WSA_MIN_DV,
                              #     8: the ramps from detection v8 — both airspeed registers
                              #        against the ADS-B ground speed, see report8; v7 kept
                              #        beside it as "v7", from 31 Oct 2026)

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

# Turboprop departures (from 27 Oct 2026, REPORT_V 6).  The band winds of the
# ATR 72 climb-outs scatter more than those of the jets: replay 13–27 Oct 2026,
# every band, SD 3.2–3.8 kt at 1 200–1 800 ft against 2.7–2.9 kt (ratio ≈ 1.3),
# although they have more wind pairs per band (slow climb; acceleration, flap
# retraction and the first turn there).  With the jets' limits 2.9 % of the
# turboprop departures got a band alert (jets 0.6 %).  A real per-type offset
# exists but is small (≤ 1.4 kt, E190 / A220 / A330) and removing it barely
# changed the alerts, so the limits are scaled by the scatter instead: band
# advisory / windshear alert 13 / 19.5 kt for a turboprop's departure (test
# 19–27 Oct: 3.3 % → 1.4 % flagged; jets and all landings unchanged).
TURBOPROP_TYPES = frozenset((
    "AT43", "AT44", "AT45", "AT46", "AT72", "AT73", "AT75", "AT76",   # ATR 42 / 72
    "DH8A", "DH8B", "DH8C", "DH8D",                                   # Dash 8 / Q400
    "SF34", "SB20", "F50", "D328", "JS31", "JS32", "JS41", "B190",
    "BE20", "BE30", "BE35", "B350", "PC12", "C208", "L410", "E120", "SW4",
))
TP_DEP_SCALE = 1.3            # band limits × this for a turboprop's departure


def band_scale(phase: str | None, aircraft_type: str | None) -> float:
    """Factor of the band limits (BAND_ADVISORY / BAND_WSA) for this flight."""
    if phase == "dep" and aircraft_type and aircraft_type.upper() in TURBOPROP_TYPES:
        return TP_DEP_SCALE
    return 1.0

LEVELS = ("none", "adv", "wsa", "mba")


def level_of(sc_kt: float | None, loss: bool, dv_kt: float | None = None) -> str:
    """Level of a 1-km-equivalent ramp (kt, magnitude); with its headwind
    change dv_kt a WSA / MBA also needs |ΔV| ≥ RAMP_WSA_MIN_DV (v7)."""
    if sc_kt is None:
        return "none"
    if sc_kt >= LEVEL_WSA and dv_kt is not None and abs(dv_kt) < RAMP_WSA_MIN_DV:
        return "adv"
    if loss and sc_kt >= LEVEL_MBA:
        return "mba"
    if sc_kt >= LEVEL_WSA:
        return "wsa"
    if sc_kt >= LEVEL_ADVISORY:
        return "adv"
    return "none"


def band_level(a_kt: float | None, scale: float = 1.0) -> str:
    if a_kt is None:
        return "none"
    a = abs(a_kt)
    return "wsa" if a >= BAND_WSA * scale else "adv" if a >= BAND_ADVISORY * scale else "none"


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
        if not (60 <= gs <= 330 and 80 <= tas <= 300) or abs(tas - gs) > 80:   # (to 31 Oct 2026 GS ≤ 280, TAS ≤ 260:
            #  the climb-outs above about 3 000 ft at 250 kt IAS were cut)
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
            # the ramp that sets the level is kept (v7: a WSA needs |ΔV| ≥ 14 kt,
            # so the strongest by the 1-km equivalent need not be the one alerting)
            rank = (LEVELS.index(level_of(round(sc, 1), kind == "loss", round(dv, 1))), round(sc, 1))
            cand = {"dv": round(dv, 1), "sc": round(sc, 1), "L": int(L),
                    "a1": None if p1[2] is None else int(round(p1[2])),
                    "a2": None if p2[2] is None else int(round(p2[2])),
                    "d1": None if p1[3] is None else round(p1[3], 2),
                    "d2": None if p2[3] is None else round(p2[3], 2),
                    "t2": None if p2[4] is None else round(p2[4], 1)}
            zone = _in_zone(p2[2], p2[3], thr_ft) or _in_zone(p1[2], p1[3], thr_ft)
            cand["zone"] = zone
            cand["_rank"] = rank
            cur = best_any[kind]
            if cur is None or rank > cur["_rank"]:
                best_any[kind] = cand
            if zone:
                cur = best[kind]
                if cur is None or rank > cur["_rank"]:
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
    # fine headwind profile (from 31 Oct 2026, the Time–height section's flight
    # columns): every 100 ft 200–5 000 ft MSL the mean of the cleaned values
    # within ±50 ft (at least 2), else within ±100 ft (at least 1 — a climb-out
    # passes 100 ft in about 2 s, one reply) — {"lo": lowest ft, "v": [kt | None]}
    hv = sorted((p["alt"], p["hw"]) for p in pts if p["alt"] is not None)
    hp_v = {}
    for b in range(HP_LO_FT, HP_HI_FT + HP_BIN_FT, HP_BIN_FT):
        near = [w for a, w in hv if abs(a - b) <= HP_BIN_FT / 2]
        if len(near) < 2:
            near = [w for a, w in hv if abs(a - b) <= HP_BIN_FT]
        if near:
            hp_v[b] = round(sum(near) / len(near), 1)
    hp = None
    if hp_v:
        lo, hi = min(hp_v), max(hp_v)
        hp = {"lo": lo, "v": [hp_v.get(b) for b in range(lo, hi + HP_BIN_FT, HP_BIN_FT)]}
    out = {"n": len(pts), "drop": dropped,
           "noise": None if noise is None else round(noise, 2),
           "len": int(round(pts[-1]["x"])),
           "a": [_r0(max((p["alt"] for p in pts if p["alt"] is not None), default=None)),
                 _r0(min((p["alt"] for p in pts if p["alt"] is not None), default=None))],
           "d": [_r2(max((p["d"] for p in pts if p["d"] is not None), default=None)),
                 _r2(min((p["d"] for p in pts if p["d"] is not None), default=None))],
           "fh": None if fh is None else round(fh, 3),
           "fh_a": _r0(fh_a), "bd": bands, "hp": hp}
    for kind in ("loss", "gain"):
        c = best[kind] or best_any[kind]
        out[kind] = {k: v for k, v in c.items() if k != "_rank"} if c else None
    lv_loss = level_of(best["loss"]["sc"], True, best["loss"]["dv"]) if best["loss"] else "none"
    lv_gain = level_of(best["gain"]["sc"], False, best["gain"]["dv"]) if best["gain"] else "none"
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


def band_changes(bands: dict, refs: list, heading: float, max_band: float = BAND_MAX_FT,
                 phase: str | None = None) -> dict:
    """The change of every band of this flight from the median of the reference
    flights, as in band_anomaly (same references, phase correction and sign):
    {band ft: {"b", "a", "ref", "n", "np", "dv"(, "ph")}}; empty when nothing can
    be compared.  Used by band_anomaly (the largest one) and by the space–time
    diagram of the Windshear page (every band, from 27 Oct 2026)."""
    per: dict = {}
    if heading is None:
        return per
    hr = math.radians(heading)
    ex, ey = math.sin(hr), math.cos(hr)
    own_b = PHASE_HW_BIAS.get(phase, 0.0) if phase else 0.0
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
    return per


def band_anomaly(bands: dict, refs: list, heading: float, max_band: float = BAND_MAX_FT,
                 phase: str | None = None, aircraft_type: str | None = None) -> dict | None:
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
     (with phase), "lvl": level, "thr": the advisory limit kt when it is not
     BAND_ADVISORY (a turboprop's departure, REPORT_V 6)}.
    A band resting on a single wind pair gets a level only when a neighbouring
    band (± 200 ft) shows a change of at least the advisory limit the same way."""
    per = band_changes(bands, refs, heading, max_band, phase) if heading is not None else {}
    if not per:
        return None
    best = max(per.values(), key=lambda x: abs(x["a"]))
    best = dict(best)
    scale = band_scale(phase, aircraft_type)
    lvl = band_level(best["a"], scale)
    if lvl != "none" and best["np"] < 2:
        nb = [per.get(best["b"] + d) for d in (-200, 200)]
        if not any(x and x["a"] * best["a"] > 0 and abs(x["a"]) >= BAND_ADVISORY * scale for x in nb):
            lvl = "none"
    best["lvl"] = lvl
    if scale != 1.0:
        best["thr"] = round(BAND_ADVISORY * scale, 1)
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
    lv = level_of(c["sc"], loss, c.get("dv"))
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
            lv = max(lv, level_of(c.get("sc"), loss, c.get("dv")), key=LEVELS.index)
    return lv


# ── ICAO-style alert message (from 28 Oct 2026) ──────────────────────────────
# The short form that the airport windshear systems (US LLWAS / TDWR, Hong Kong
# WTWS) give to the controllers, e.g. "15A WSA 15K+ 2MF":
#   runway + A (arrival) / D (departure) · level · headwind change in kt with
#   "-" loss / "+" gain · where it is first met: RWY (on the runway, < 0.5 NM),
#   <n>MF (n-mile final).  The controllers read it out as "Runway one five
#   arrival, windshear alert, one five knot gain, two mile final".
# Our own additions: ADV (advisory, not a standard level) and, for climb-outs,
# the altitude (e.g. 1400FT) instead of a distance — the departures' alerts
# come from the band comparison, which has no along-track position.
# Research messages from Mode S data, not operational alerts.

MSG_LEVEL = {"adv": ("ADV", "windshear advisory"), "wsa": ("WSA", "windshear alert"),
             "mba": ("MBA", "microburst alert")}
GS_FT_PER_NM = 318.0           # 3° glide path: ft per NM
_DIGIT = ("zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "niner")
_SIDE = {"L": "left", "R": "right", "C": "centre"}


def _say_digits(s) -> str:
    return " ".join(_DIGIT[int(ch)] for ch in str(s) if ch.isdigit())


def _say_rwy(rwy: str) -> str:
    side = _SIDE.get(rwy[-1:].upper())
    return _say_digits(rwy) + (f" {side}" if side else "")


def _say_ft(ft: int) -> str:
    th, hu = divmod(int(ft), 1000)
    parts = ([f"{_say_digits(th)} thousand"] if th else []) + ([f"{_DIGIT[hu // 100]} hundred"] if hu // 100 else [])
    return " ".join(parts) or "zero"


def alert_msg(ev: dict, thr_ft: float = 0.0) -> tuple:
    """(message, spoken) of a live alert (ws_events / ws_log entry)."""
    lvl = ev.get("lvl") or "adv"
    code, word = MSG_LEVEL.get(lvl, MSG_LEVEL["adv"])
    dep = ev.get("ph") == "dep"
    rwy = ev.get("rwy") or ""
    band = ev.get("kind") == "band"
    kt = int(round(abs((ev.get("a") if band else ev.get("dv")) or 0)))
    loss = ev.get("dir") == "loss"
    alt = ev.get("b") if band else ev.get("a1")
    if dep:
        ft = int(round((alt or 0) / 100.0)) * 100
        where, where_s = f"{ft}FT", f"at {_say_ft(ft)} feet"
    else:
        d = None if band else ev.get("d1")
        if d is None and alt is not None:
            d = max(0.0, (alt - thr_ft) / GS_FT_PER_NM)
        if d is None or d < 0.5:
            where, where_s = "RWY", "on the runway"
        else:
            n = max(1, int(round(d)))
            where, where_s = f"{n}MF", f"{_say_digits(n)} mile final"
    msg = f"{rwy or '??'}{'D' if dep else 'A'} {code} {kt}K{'-' if loss else '+'} {where}"
    say = (f"Runway {_say_rwy(rwy)} {'departure' if dep else 'arrival'}, " if rwy else
           f"{'Departure' if dep else 'Arrival'}, ") + \
          f"{word}, {_say_digits(kt)} knot {'loss' if loss else 'gain'}, {where_s}"
    return msg, say


# ── Detection v8 (from 30 Oct 2026 in shadow; THE DETECTION from 31 Oct 2026) ──────
# The headwind from both Comm-B airspeed registers against the ADS-B ground speed
# (TC 19 airborne velocity, about twice a second at 1-kt resolution, stored with
# every landing and departure since 24 Oct 2026):
#   BDS 5,0:  TAS − GS(ADS-B)
#   BDS 6,0:  TAS from the indicated airspeed (pressure altitude of the sweep,
#             temperature ISA + the flight's own deviation from BDS 5,0 TAS /
#             BDS 6,0 Mach pairs) − GS(ADS-B)
# Check on 1 062 landings 24–30 Oct 2026: the ADS-B GS taken 0.5 s before the
# reply matches the registers (BDS 5,0 GS vs ADS-B GS RMS 0.92 kt); the BDS 6,0
# headwind agrees with the BDS 5,0 one (bias 0.02 kt, RMS 0.98 kt; per flight
# p10/p90 ±0.4 kt, removed); a headwind every 0.5 s instead of 1.9 s, 2.3× the
# values per approach, noise 1.48 kt instead of 1.59; more 400–600 m ramps,
# each seen by both registers separately where both had data.
# 30–31 Oct 2026 beside v7 in shadow; replay of 1 245 landings 24–31 Oct: v7 32 ADV
# + 1 WSA, v8 41 ADV (19 both; 22 v8 only, mostly 8–10 kt over 400–600 m on the
# gusty 25–27 Oct, EDR median 0.17, neighbour flags as often as the common ones).
# From 31 Oct 2026 (REPORT_V 8) the live alerts and the reports use v8, and v7
# (BDS 5,0 TAS − GS alone) is the fallback for a flight without ADS-B ground speed
# and the shadow "v7" of the report.
V8 = 8
V8_GS_LAG = -0.5              # s: the ADS-B GS at t − 0.5 s matches the reply received at t
V8_ROLL_SEC = 4.0             # a BDS 6,0 reply takes the roll of a BDS 5,0 reply within this
V8_MIN_DT_PAIRS = 5           # TAS / Mach pairs for the flight's own ISA deviation
V8_MIN_OFF_PAIRS = 10         # BDS 6,0 / BDS 5,0 pairs for the per-flight offset
_A0 = 661.4788                # kt, speed of sound at sea level (ISA)
_AK = 38.967854               # kt per √K
_P0 = 1013.25


def _isa_t(palt: float) -> float:
    return 288.15 - 0.0019812 * palt


def tas_from_ias(ias: float, palt: float, t_k: float) -> float:
    """True airspeed (kt) from the indicated airspeed (kt), the pressure
    altitude (ft) and the temperature (K): compressible flow, ISA pressure."""
    p = _P0 * (1 - 6.8756e-6 * palt) ** 5.2559
    qc = _P0 * ((1 + 0.2 * (ias / _A0) ** 2) ** 3.5 - 1)
    m = math.sqrt(5 * ((qc / p + 1) ** (2 / 7) - 1))
    return m * _AK * math.sqrt(t_k)


def _sorted_xy(rows, ix: int, iy: int):
    pts = sorted((r[ix], r[iy]) for r in rows if r and r[ix] is not None and r[iy] is not None)
    return [p[0] for p in pts], [p[1] for p in pts]


def _interp_gap(ts: list, vs: list, t: float, gap: float):
    """Linear interpolation of vs(ts) at t when the bracketing points are at most gap s apart."""
    if not ts:
        return None
    lo, hi = 0, len(ts)
    while lo < hi:
        mid = (lo + hi) // 2
        if ts[mid] < t:
            lo = mid + 1
        else:
            hi = mid
    if lo == 0 or lo == len(ts):
        return None
    t0, t1 = ts[lo - 1], ts[lo]
    if t1 - t0 > gap:
        return None
    w = (t - t0) / (t1 - t0) if t1 > t0 else 0.0
    return vs[lo - 1] + (vs[lo] - vs[lo - 1]) * w


def isa_dev(b50: list, b60: list, sw: list):
    """The flight's own ISA deviation (K): median over BDS 5,0 TAS / BDS 6,0 Mach
    pairs within 1 s, at the pressure altitude of the sweeps (None with fewer
    than V8_MIN_DT_PAIRS pairs — turboprops send no Mach)."""
    mt, mm = _sorted_xy(b60, 0, 5)
    pt, pa = _sorted_xy(sw, 0, 2)
    out = []
    j = 0
    for r in sorted((r for r in b50 if r and r[0] is not None and r[5]), key=lambda r: r[0]):
        t, tas = r[0], r[5]
        while j < len(mt) and mt[j] < t - 1.0:
            j += 1
        k = j
        while k < len(mt) and mt[k] <= t + 1.0:
            if mm[k] and mm[k] > 0.15:
                p = _interp_gap(pt, pa, t, 10.0)
                if p is not None:
                    out.append((tas / (_AK * mm[k])) ** 2 - _isa_t(p))
                break
            k += 1
    if len(out) < V8_MIN_DT_PAIRS:
        return None
    out.sort()
    m = len(out)
    dt = out[m // 2] if m % 2 else 0.5 * (out[m // 2 - 1] + out[m // 2])
    return dt if abs(dt) < 30 else None


def v8_rows(b50: list, b60: list, v19: list, sw: list, dt_fallback=None):
    """Rows for analyze() from both registers against the ADS-B ground speed:
    [t, roll, track rate, track, GS(ADS-B), TAS, alt] (BDS 6,0 rows with the
    roll of the nearest BDS 5,0 reply and track rate / track None), and the
    info {"n50", "n60", "dT", "dTsrc" own|near|none, "off"}.  None without
    ADS-B ground speed."""
    vt, vg = _sorted_xy(v19 or [], 0, 1)
    if len(vt) < 10:
        return None, None
    rows = []
    prev = None
    for r in sorted((r for r in (b50 or []) if r and r[0] is not None), key=lambda r: r[0]):
        t, roll, tr, trk, gs, tas = r[:6]
        alt = r[6] if len(r) > 6 else None
        if gs is None or tas is None:
            continue
        if prev is not None and gs == prev[1] and tas == prev[2] and t - prev[0] < REPEAT_SEC:
            continue                       # the same register content again (its own GS / TAS)
        prev = (t, gs, tas)
        g = _interp_gap(vt, vg, t + V8_GS_LAG, 2.0)
        if g is not None:
            rows.append([t, roll, tr, trk, round(g, 2), tas, alt])
    dt = isa_dev(b50 or [], b60 or [], sw or [])
    src = "own"
    if dt is None:
        dt, src = (dt_fallback, "near") if dt_fallback is not None else (None, "none")
    r60 = []
    if dt is not None and b60:
        rt, rr = _sorted_xy(b50 or [], 0, 1)
        pt, pa = _sorted_xy(sw or [], 0, 2)
        prev = None
        for r in sorted((r for r in b60 if r and r[0] is not None), key=lambda r: r[0]):
            t, ias, hdg = r[0], r[1], r[2]
            mach = r[5] if len(r) > 5 else None
            alt = r[6] if len(r) > 6 else None
            if not ias:
                continue
            key = (ias, hdg, mach)
            if prev is not None and key == prev[1] and t - prev[0] < REPEAT_SEC:
                continue                   # the same register content again
            prev = (t, key)
            p = _interp_gap(pt, pa, t, 10.0)
            g = _interp_gap(vt, vg, t + V8_GS_LAG, 2.0)
            roll = _interp_gap(rt, rr, t, V8_ROLL_SEC)
            if p is None or g is None or roll is None:
                continue
            tas = tas_from_ias(ias, p, _isa_t(p) + dt)
            r60.append([t, roll, None, None, round(g, 2), round(tas, 2), alt])
    # the BDS 6,0 headwind against the BDS 5,0 one of the same flight: the offset
    # is removed, so that a change in the mix of the two along the path is no ramp
    off = None
    if r60:
        ht = [r[0] for r in rows]
        hv = [r[5] - r[4] for r in rows]
        dif = []
        for r in r60:
            h = _interp_gap(ht, hv, r[0], 2.5)
            if h is not None:
                dif.append((r[5] - r[4]) - h)
        if len(dif) >= V8_MIN_OFF_PAIRS:
            dif.sort()
            m = len(dif)
            off = dif[m // 2] if m % 2 else 0.5 * (dif[m // 2 - 1] + dif[m // 2])
            for r in r60:
                r[5] = round(r[5] - off, 2)
        else:
            r60 = []
    info = {"n50": len(rows), "n60": len(r60), "dT": None if dt is None else round(dt, 1),
            "dTsrc": src, "off": None if off is None else round(off, 2)}
    return rows + r60, info


def analyze_v8(b50: list, b60: list, v19: list, sw: list, thr_ft: float = 179.0,
               dt_fallback=None) -> dict | None:
    """analyze() on the v8 headwind (see above); the result carries "v8" (the
    info of v8_rows).  None without ADS-B ground speed or enough data."""
    rows, info = v8_rows(b50, b60, v19, sw, dt_fallback)
    if not rows:
        return None
    a = analyze(rows, sw, thr_ft)
    if a is not None:
        a["v8"] = info
    return a


def shadow_report(a: dict | None, band: dict | None, refs: list | None, heading,
                  v: int) -> dict | None:
    """A second analysis of a flight stored beside its report (the v7 shadow
    "v7" of a landing from 31 Oct 2026; v8 "v8" / "trial8" 30–31 Oct): the
    analysis without t2 and the per-reply data, the level of its ramps "rlvl"
    (advisories relative to the reference flights) combined with the band
    comparison when given, the v8 info, and "v"."""
    if a is None:
        return None
    out = {k: a.get(k) for k in ("n", "drop", "noise", "len", "a", "d", "fh", "fh_a")}
    for k in ("loss", "gain"):
        if a.get(k):
            out[k] = {kk: vv for kk, vv in a[k].items() if kk != "t2"}
    lv = ramps_level(out, refs, heading)
    out["rlvl"] = lv
    out["lvl"] = max(lv, (band or {}).get("lvl") or "none", key=LEVELS.index)
    out.update(a.get("v8") or {})
    out["v"] = v
    return out


def v8_report(a: dict | None, band: dict | None, refs: list | None, heading) -> dict | None:
    """The v8 result of a flight as stored 30–31 Oct 2026 (the departures'
    trial ramps "trial8")."""
    return shadow_report(a, band, refs, heading, V8)


def report8(a8: dict | None, a7: dict | None, band: dict | None, refs: list | None = None,
            heading=None) -> dict | None:
    """The windshear report of a landing from 31 Oct 2026 (REPORT_V 8): the
    ramps of detection v8 (analyze_v8) when the flight has ADS-B ground speed,
    else of v7 (analyze) — "src" "v8" / "v7" — with the band comparison and the
    level as report(); the v8 info (n50, n60, dT, dTsrc, off) at the top level;
    v7 beside it as "v7" (shadow_report) when both could be computed."""
    main = a8 if a8 is not None else a7
    out = report(main, band, refs, heading)
    if out is None:
        return None
    info = out.pop("v8", None)
    if a8 is not None:
        out.update(info or {})
    out["src"] = "v8" if a8 is not None else "v7"
    if a8 is not None and a7 is not None:
        out["v7"] = shadow_report(a7, band, refs, heading, 7)
    return out
