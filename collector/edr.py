"""
collector/edr.py — turbulence intensity (EDR) of each landing and departure
(from 2026-10-29; RESEARCH).

EDR (eddy dissipation rate, ε^⅓ in m^⅔ s⁻¹) is the ICAO measure of
turbulence: ICAO Annex 3 grades the *peak* EDR of a medium-size transport
aircraft as light 0.10–0.20, moderate 0.20–0.45, severe ≥ 0.45.  Here it is
estimated from the aircraft's own Mode S replies, after the method of the
study of 29 Oct 2026 (Kopeć et al. 2016, AMT, structure-function approach):

  1. the headwind TAS − GS of every BDS 5,0 reply (the raw series kept with
     each landing / departure, approach_series / departure_series), from
     200 to 3 000 ft above the threshold elevation;
  2. the along-track distance from the ground speed;
  3. the series cut into straight pieces of about 2 km (track change ≤ 15°;
     in a turn the headwind part of the mean wind changes and would look like
     turbulence), each piece linearly detrended;
  4. the second-order structure function at 100–200 m separation,
     D = mean (Δu)², minus the noise floor of the 2-kt TAS / GS
     resolution N0 = 0.35 m² s⁻² (the calmest day);
  5. inertial-range scaling D = 2 ε^⅔ r^⅔ at r = 141 m:
     EDR = √((D − N0) / (2 · 141^⅔)).

Per flight: "m" over all pieces (the pairs pooled), "lo" 200–1 000 ft and
"hi" 1 000–3 000 ft above the threshold, "pk" the strongest piece, "n" the
pieces, "top" the upper limit and "seg" — each piece's EDR, height range and
4 positions for the map.  Departures (from 29 Oct 2026) use the climb up to
5 000 ft (top = DEP_TOP_FT, "hi" 1 000–5 000 ft): their stored climb-out
series now reach 5 000 ft, because a climb crosses 200–3 000 ft in about 80 s
and turns early, so only about a third of them had two straight pieces there
(a heading-based wind vector or the turning pieces were tried on the stored
flights and did not agree with the straight-piece values: r 0.28 / 0.33).  The 2-s reply rate only reaches the 100–200 m scale, so the r^⅔ law is
assumed there; the values are a research estimate, an average over the
approach (not the ICAO 1-min peak), to be calibrated against pilot reports.
Study (4 255 landings 9–29 Oct 2026): per-landing correlation with ACI 0.66,
daily 0.98, with the METAR wind 0.68; nearly the same for all aircraft
classes (ACI needs class factors).  About 85 % of the landings and 40 % of
the departures (their stored replies cover about 1 000–3 000 ft and they turn
early) get a value.

Record version 2 (31 Oct 2026): before the pieces, replies with the same time
as an earlier one and replies stamped more than FUTURE_SEC later than a reply
stored after them are dropped (receiver timestamps ahead of the clock, see
collector/receiver.py TS_MAX_AGE_SEC; in the climb-out series one stale reply
could be repeated at several heights — FIN3A on 30 Oct read EDR 0.34 / peak
0.40 instead of 0.07 / 0.09).  Departures 27–31 Oct: peak ≥ 0.20 14 → 8;
landings practically unchanged.  The stored records are recomputed once at the
start (run.py _edr_backfill, by version).

Record version 3 (23 Nov 2026): a second pair distance for the flights that
got no value.  The two radars' sweeps reach an aircraft alternately; when they
arrive almost together (gaps like 0.4 s and 3.6 s) neighbouring replies are
under 100 m or over 200 m apart and no pair falls in the 100–200 m bin, though
the series is complete — about a quarter of the flights.  Such a flight (fewer
than MIN_PAIRS pairs at 100–200 m) now uses the pairs 200–400 m apart, and its
record carries "w": 1.  A flight with enough 100–200 m pairs is computed
exactly as before.  The wider pairs do not follow the r^⅔ law fully (pieces
detrended over 2 km, low heights), so they are not scaled by it but
calibrated against the 100–200 m values on the daily sums of the flights that
have both (9 097 landings, 5 422 departures, 9 Oct–23 Nov 2026):
D₂ − N0₂ = k · (D₁ − N0), landings N0₂ 0.40, k 1.23 (r 0.996 over 45 days),
departures N0₂ 0.47, k 1.51 (r 0.93 over 26 days; the law would give 1.59).
Landings with both: mean difference 0.001, same class in 85 %; against the
mean of the hour's other landings the wide value correlates 0.82, the
100–200 m value 0.71, and 0.73 on the landings that only have the wide one.
With a value: landings 75.5 → 98.4 %, departures 71.9 → 97.4 %.  Version-2
records with a value are the same in version 3 and are left as they are
(KEEP_VERSIONS); run.py _edr_backfill computes only the flights without one.

compute(series) takes the decoded series (WindshearTracker.decode_series);
from_blob(blob) the stored blob.  Cheap: only pairs within 400 m are formed.
"""

from __future__ import annotations

import bisect
import math

VERSION = 3                   # 2: duplicate / future-stamped replies dropped (2026-10-31)
                              # 3: flights without 100–200 m pairs use 200–400 m ("w": 1, 2026-11-23)
KEEP_VERSIONS = (2,)          # a stored record of these versions that has a value is unchanged in VERSION
KT = 0.514444                 # kt → m/s
N0 = 0.35                     # noise floor of D at 100–200 m (m² s⁻²)
R_MID = math.sqrt(100 * 200)  # 141 m, the middle of the separation bin
R_LO, R_HI = 100.0, 200.0
R2_LO, R2_HI = 200.0, 400.0   # the wider pairs (version 3), used only without enough 100–200 m pairs
# (noise floor of D at 200–400 m, D ratio to the 100–200 m bin) — measured, see the module text
WIDE_LANDING = (0.40, 1.23)
WIDE_DEPARTURE = (0.47, 1.51)
FUTURE_SEC = 3.0              # a reply this much later than one stored after it is mis-stamped
PIECE_M = 2000.0              # straight piece length
TURN_DEG = 15.0               # largest track change within a piece
MIN_REPLIES = 8               # replies per piece
MIN_PAIRS_PIECE = 3
MIN_PAIRS = 6                 # pairs for a value (flight / layer)
LO_FT, MID_FT, HI_FT = 200.0, 1000.0, 3000.0   # heights above the threshold
DEP_TOP_FT = 5000.0           # departures: up to 5 000 ft above the airport (from 2026-10-29)

ELEV_FT = 179.0               # threshold elevation (set from WINDSHEAR_THR_ELEVATION_FT by run.py)

# ICAO Annex 3 (peak EDR, medium aircraft)
LIGHT, MODERATE, SEVERE = 0.10, 0.20, 0.45


def level(v: float | None) -> str | None:
    """'smooth' / 'light' / 'moderate' / 'severe' (None without a value)."""
    if v is None:
        return None
    return "severe" if v >= SEVERE else "moderate" if v >= MODERATE else "light" if v >= LIGHT else "smooth"


def _edr(s: float, c: int) -> float:
    return math.sqrt(max(s / c - N0, 0.0) / (2.0 * R_MID ** (2.0 / 3.0)))


def _edr_wide(s: float, c: int, cal: tuple) -> float:
    """EDR from the 200–400 m pairs: D brought to the 100–200 m scale by the
    measured noise floor and ratio (cal), then as _edr."""
    return math.sqrt(max((s / c - cal[0]) / cal[1], 0.0) / (2.0 * R_MID ** (2.0 / 3.0)))


def _detrend(x: list, u: list) -> list:
    n = len(x)
    mx, mu = sum(x) / n, sum(u) / n
    sxx = sum((a - mx) ** 2 for a in x)
    b = sum((a - mx) * (c - mu) for a, c in zip(x, u)) / sxx if sxx else 0.0
    return [c - mu - b * (a - mx) for a, c in zip(x, u)]


def _pieces(rows: list) -> list:
    """rows: (t, tas, gs, alt, trk) sorted by t → [{t0, t1, a0, a1, s, c, s2, c2}]
    (s, c: the 100–200 m pairs; s2, c2: the 200–400 m pairs, version 3)."""
    t = [r[0] for r in rows]
    x = [0.0]
    for i in range(1, len(rows)):
        x.append(x[-1] + (rows[i][2] + rows[i - 1][2]) / 2 * KT * (t[i] - t[i - 1]))
    hw = [(r[1] - r[2]) * KT for r in rows]
    out, i, n = [], 0, len(x)
    while i < n:
        j = i
        while j < n and x[j] - x[i] < PIECE_M:
            j += 1
        if j - i >= MIN_REPLIES and x[j - 1] - x[i] > PIECE_M * 0.75:
            d = [((rows[k][4] - rows[i][4] + 180) % 360) - 180 for k in range(i, j)]
            if max(d) - min(d) <= TURN_DEG:
                xs = x[i:j]
                us = _detrend(xs, hw[i:j])
                s, c, s2, c2 = 0.0, 0, 0.0, 0
                for a in range(len(xs)):
                    for b in range(a + 1, len(xs)):
                        r = xs[b] - xs[a]
                        if r >= R2_HI:
                            break
                        if r >= R_HI:
                            s2 += (us[b] - us[a]) ** 2
                            c2 += 1
                        elif r >= R_LO:
                            s += (us[b] - us[a]) ** 2
                            c += 1
                if c >= MIN_PAIRS_PIECE or c2 >= MIN_PAIRS_PIECE:
                    out.append({"t0": t[i], "t1": t[j - 1], "a0": rows[i][3], "a1": rows[j - 1][3],
                                "s": s, "c": c, "s2": s2, "c2": c2})
        i = j
    return out


def _clean(rows: list) -> list:
    """rows in stored order (t first) → without the replies whose time repeats
    an earlier one, and without every copy of a reply stamped more than
    FUTURE_SEC later than a reply stored after it (version 2)."""
    later_min, bad = math.inf, set()
    for i in range(len(rows) - 1, -1, -1):
        t = rows[i][0]
        if t is None:
            continue
        if t - later_min > FUTURE_SEC:
            bad.add(i)
        later_min = min(later_min, t)
    bad_t = {rows[i][0] for i in bad}          # every copy of a mis-stamped reply
    seen, out = set(), []
    for r in rows:
        if r[0] in bad_t or r[0] in seen:
            continue
        seen.add(r[0])
        out.append(r)
    return out


def compute(series: dict | None, elev_ft: float | None = None, top_ft: float | None = None,
            dep: bool | None = None) -> dict | None:
    """EDR record of one flight from its decoded raw series, or None
    (top_ft: the upper limit above the threshold, default HI_FT; dep: a
    departure — picks the calibration of the wider pairs, default: top above
    HI_FT)."""
    if not series:
        return None
    if elev_ft is None:
        elev_ft = ELEV_FT
    top = HI_FT if top_ft is None else float(top_ft)
    b5 = series.get("b50") or {}
    cols = [b5.get(k) or [] for k in ("t", "tas", "gs", "alt", "trk")]
    rows = sorted(r for r in _clean(list(zip(*cols)))
                  if None not in r and LO_FT <= r[3] - elev_ft < top and r[2] > 30)
    if len(rows) < MIN_REPLIES:
        return None
    every = _pieces(rows)
    pcs = [p for p in every if p["c"] >= MIN_PAIRS_PIECE]
    wide = sum(p["c"] for p in pcs) < MIN_PAIRS
    if wide:                                  # version 3: the 200–400 m pairs instead
        pcs = [dict(p, s=p["s2"], c=p["c2"]) for p in every if p["c2"] >= MIN_PAIRS_PIECE]
        if sum(p["c"] for p in pcs) < MIN_PAIRS:
            return None
        cal = WIDE_DEPARTURE if (top > HI_FT if dep is None else dep) else WIDE_LANDING
        val = lambda s, c: _edr_wide(s, c, cal)
    else:
        val = _edr

    def pooled(ps):
        c = sum(p["c"] for p in ps)
        return round(val(sum(p["s"] for p in ps), c), 3) if c >= MIN_PAIRS else None

    mid = lambda p: (p["a0"] + p["a1"]) / 2 - elev_ft
    sw = series.get("sw") or {}
    pos = sorted(r for r in zip(sw.get("t") or [], sw.get("lat") or [], sw.get("lon") or [])
                 if r[1] is not None and r[2] is not None)
    pt = [p[0] for p in pos]

    def where(tt):
        if not pos:
            return None
        k = min(max(bisect.bisect_left(pt, tt), 0), len(pos) - 1)
        return [round(pos[k][1], 4), round(pos[k][2], 4)]

    seg = []
    for p in pcs:
        pts = [where(p["t0"] + i * (p["t1"] - p["t0"]) / 3) for i in range(4)]
        seg.append({"e": round(val(p["s"], p["c"]), 3),
                    "a": [int(round(p["a0"])), int(round(p["a1"]))],
                    "p": [q for q in pts if q]})
    rec = {"v": VERSION, "m": pooled(pcs),
           "lo": pooled([p for p in pcs if mid(p) < MID_FT]),
           "hi": pooled([p for p in pcs if mid(p) >= MID_FT]),
           "pk": max(s["e"] for s in seg), "n": len(pcs), "top": int(top), "seg": seg}
    if wide:
        rec["w"] = 1
    return rec


def from_blob(blob, elev_ft: float | None = None, top_ft: float | None = None,
              dep: bool | None = None) -> dict | None:
    """EDR record from a stored approach_series / departure_series blob.  Never raises."""
    if not blob:
        return None
    try:
        from collector.windshear import WindshearTracker
        return compute(WindshearTracker.decode_series(blob), elev_ft, top_ft, dep)
    except Exception:                         # noqa: BLE001  (a damaged blob)
        return None


def summary(rec: dict | None) -> dict | None:
    """The record without the pieces (for the history lists)."""
    if not rec:
        return None
    out = {k: rec.get(k) for k in ("m", "lo", "hi", "pk", "n", "top")}
    if rec.get("w"):
        out["w"] = 1                          # from the 200–400 m pairs (version 3)
    return out
