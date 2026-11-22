"""
gps_switch.py — when the share of aircraft with degraded GPS steps down in the
morning and up in the evening (from the late evening of 2026-11-22).

The GPS quality tracker (collector/gps_quality.py) keeps, for FL050–250, the
aircraft seen, flagged and saying "no position" (ADS-B type code 0) for every
minute ("t1" of an hourly row) beside the 10-minute slots ("t10").  This file
dates the two daily steps from them.  Pure functions: no state, no database.

Two estimates, side by side:

  * the rule used until now in the study of the interference: the first
    10-minute slot of a run in which the smoothed share (three slots) of
    FL050–250 aircraft degraded is below (morning) or at or above (evening)
    RULE_SHARE, held in four of the next five slots;
  * a change point on the minute counts: the minute that best splits the
    window into two levels (binomial likelihood) — found in the whole window,
    then dated again from the 90 minutes on either side of it — with the
    minutes within CP_RANGE_LL of the best fit as its range.  A step is reported only when it
    goes the right way by at least CP_MIN_STEP, both sides hold at least
    CP_MIN_SIDE aircraft-minutes and CP_MIN_MIN minutes, and two levels fit
    better than one by at least CP_MIN_GAIN.

A study of 79 recorded hours (18–22 Nov 2026) dated clear steps to the minute
this way where the rule was 10 to 30 minutes off.  The fit is a two-level
model: a slow change comes out with a wide range ("ramp"), a change in several
steps as one of them.  What is found is when and how much — not why.
"""
from __future__ import annotations

import math

DOWN_HOURS   = (2, 10)      # UTC: the window searched for the morning step down
UP_HOURS     = (13, 23)     # UTC: the window searched for the evening step up
RULE_SHARE   = 0.35
RULE_MIN_AC  = 3            # a slot with fewer FL050–250 aircraft has no share
CP_MIN_STEP  = 0.20         # the two levels differ by at least this share
CP_MIN_SIDE  = 30           # aircraft-minutes on either side
CP_MIN_MIN   = 10           # minutes with aircraft on either side
CP_MIN_GAIN  = 8.0          # log-likelihood: two levels over one
CP_RANGE_LL  = 2.0          # the range: splits within this of the best
RAMP_MIN     = 10           # a range wider than this many minutes is called a ramp
CP_LOCAL_SEC = 90 * 60      # the step found in the whole window is dated again from this much on either side


def _ll(k: float, n: float) -> float:
    if n <= 0:
        return 0.0
    p = min(max(k / n, 1e-6), 1.0 - 1e-6)
    return k * math.log(p) + (n - k) * math.log(1.0 - p)


def _fit(mins: list, up: bool) -> dict | None:
    """mins: [(minute_ts, n, k), …] in time order, minutes with n > 0 only.
    The best split into two levels going the given way, or None."""
    m = len(mins)
    if m < 2 * CP_MIN_MIN:
        return None
    pn = [0.0]
    pk = [0.0]
    for _, n, k in mins:
        pn.append(pn[-1] + n)
        pk.append(pk[-1] + min(k, n))
    one = _ll(pk[m], pn[m])
    best = None
    fits = []
    for i in range(CP_MIN_MIN, m - CP_MIN_MIN + 1):          # mins[i] is the first minute of the second level
        n0, k0, n1, k1 = pn[i], pk[i], pn[m] - pn[i], pk[m] - pk[i]
        if n0 < CP_MIN_SIDE or n1 < CP_MIN_SIDE:
            continue
        p0, p1 = k0 / n0, k1 / n1
        if (p1 - p0 if up else p0 - p1) < CP_MIN_STEP:
            continue
        ll = _ll(k0, n0) + _ll(k1, n1)
        fits.append((ll, i))
        if best is None or ll > best[0]:
            best = (ll, i, p0, p1, n0, n1)
    if best is None or best[0] - one < CP_MIN_GAIN:
        return None
    near = [mins[i][0] for ll, i in fits if ll >= best[0] - CP_RANGE_LL]
    lo, hi = min(near), max(near)
    return {"t": mins[best[1]][0], "lo": lo, "hi": hi, "p0": round(best[2], 3), "p1": round(best[3], 3),
            "n0": int(best[4]), "n1": int(best[5]), "gain": round(best[0] - one, 1),
            "ramp": (hi - lo) // 60 + 1 > RAMP_MIN}



def change_point(mins: list, up: bool) -> dict | None:
    """The step of a window.  The level is not constant through a night or a
    day, so the split of the whole window (many hours) only finds where the
    main change is; it is then dated again from the CP_LOCAL_SEC on either side
    of it, where two levels do describe the counts — and once more if that
    moved it."""
    g = _fit(mins, up)
    if g is None:
        return None
    for _ in range(3):
        loc = _fit([m for m in mins if abs(m[0] - g["t"]) <= CP_LOCAL_SEC], up)
        if loc is None:
            break
        same = loc["t"] == g["t"]
        g = loc
        if same:
            break
    return g


def rule_time(slots: dict, t0: int, t1: int, up: bool) -> int | None:
    """The 10-minute rule.  slots: {slot_ts: (mac, mdeg)}."""
    def frac(s):
        v = slots.get(s)
        return None if not v or v[0] < RULE_MIN_AC else v[1] / v[0]

    def smooth(s):
        vals = [x for x in (frac(s - 600), frac(s), frac(s + 600)) if x is not None]
        return sum(vals) / len(vals) if len(vals) >= 2 else None

    ok = (lambda x: x >= RULE_SHARE) if up else (lambda x: x < RULE_SHARE)
    for s in range(int(t0), int(t1), 600):
        v = smooth(s)
        if v is not None and ok(v):
            nxt = [x for x in (smooth(s + 600 * k) for k in range(1, 5)) if x is not None]
            if nxt and sum(1 for x in nxt if ok(x)) >= len(nxt) - 1:
                return s
    return None


def day_steps(day0: int, minutes: dict, slots: dict, now: float) -> dict:
    """The two steps of the UTC day that starts at day0.
    minutes: {minute_ts: (mac, mdeg, mtc0)} — mtc0 None where it was not counted;
    slots: {slot_ts: (mac, mdeg)}."""
    out = {"day": int(day0)}
    for name, (h0, h1), up in (("down", DOWN_HOURS, False), ("up", UP_HOURS, True)):
        t0, t1 = day0 + h0 * 3600, day0 + h1 * 3600
        if now < t0 + 3600:                      # the window has hardly begun
            out[name] = None
            continue
        seq = [(t, minutes[t]) for t in range(int(t0), int(min(t1, now)), 60) if t in minutes]
        deg = [(t, v[0], v[1]) for t, v in seq if v[0]]
        tc0 = [(t, v[0], v[2]) for t, v in seq if v[0] and v[2] is not None]
        out[name] = {
            "open": now < t1,                    # the window is not over: the answer may still change
            "minutes": len(seq),                 # minutes of the window with counts
            "ac_min": int(sum(v[0] for _, v in seq)),
            "cp": change_point(deg, up),
            "cp_tc0": change_point(tc0, up),
            "rule": rule_time(slots, t0, min(t1, now), up),
        }
    return out
