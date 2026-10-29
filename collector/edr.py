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
pieces, and "seg" — each piece's EDR, height range and 4 positions for the
map.  The 2-s reply rate only reaches the 100–200 m scale, so the r^⅔ law is
assumed there; the values are a research estimate, an average over the
approach (not the ICAO 1-min peak), to be calibrated against pilot reports.
Study (4 255 landings 9–29 Oct 2026): per-landing correlation with ACI 0.66,
daily 0.98, with the METAR wind 0.68; nearly the same for all aircraft
classes (ACI needs class factors).  About 85 % of the landings and 40 % of
the departures (their stored replies cover about 1 000–3 000 ft and they turn
early) get a value.

compute(series) takes the decoded series (WindshearTracker.decode_series);
from_blob(blob) the stored blob.  Cheap: only pairs within 200 m are formed.
"""

from __future__ import annotations

import bisect
import math

VERSION = 1
KT = 0.514444                 # kt → m/s
N0 = 0.35                     # noise floor of D at 100–200 m (m² s⁻²)
R_MID = math.sqrt(100 * 200)  # 141 m, the middle of the separation bin
R_LO, R_HI = 100.0, 200.0
PIECE_M = 2000.0              # straight piece length
TURN_DEG = 15.0               # largest track change within a piece
MIN_REPLIES = 8               # replies per piece
MIN_PAIRS_PIECE = 3
MIN_PAIRS = 6                 # pairs for a value (flight / layer)
LO_FT, MID_FT, HI_FT = 200.0, 1000.0, 3000.0   # heights above the threshold

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


def _detrend(x: list, u: list) -> list:
    n = len(x)
    mx, mu = sum(x) / n, sum(u) / n
    sxx = sum((a - mx) ** 2 for a in x)
    b = sum((a - mx) * (c - mu) for a, c in zip(x, u)) / sxx if sxx else 0.0
    return [c - mu - b * (a - mx) for a, c in zip(x, u)]


def _pieces(rows: list) -> list:
    """rows: (t, tas, gs, alt, trk) sorted by t → [{t0, t1, a0, a1, s, c}]."""
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
                s, c = 0.0, 0
                for a in range(len(xs)):
                    for b in range(a + 1, len(xs)):
                        r = xs[b] - xs[a]
                        if r >= R_HI:
                            break
                        if r >= R_LO:
                            s += (us[b] - us[a]) ** 2
                            c += 1
                if c >= MIN_PAIRS_PIECE:
                    out.append({"t0": t[i], "t1": t[j - 1], "a0": rows[i][3], "a1": rows[j - 1][3],
                                "s": s, "c": c})
        i = j
    return out


def compute(series: dict | None, elev_ft: float | None = None) -> dict | None:
    """EDR record of one flight from its decoded raw series, or None."""
    if not series:
        return None
    if elev_ft is None:
        elev_ft = ELEV_FT
    b5 = series.get("b50") or {}
    cols = [b5.get(k) or [] for k in ("t", "tas", "gs", "alt", "trk")]
    rows = sorted(r for r in zip(*cols)
                  if None not in r and LO_FT <= r[3] - elev_ft < HI_FT and r[2] > 30)
    if len(rows) < MIN_REPLIES:
        return None
    pcs = _pieces(rows)
    c_all = sum(p["c"] for p in pcs)
    if c_all < MIN_PAIRS:
        return None

    def pooled(ps):
        c = sum(p["c"] for p in ps)
        return round(_edr(sum(p["s"] for p in ps), c), 3) if c >= MIN_PAIRS else None

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
        seg.append({"e": round(_edr(p["s"], p["c"]), 3),
                    "a": [int(round(p["a0"])), int(round(p["a1"]))],
                    "p": [q for q in pts if q]})
    return {"v": VERSION, "m": pooled(pcs),
            "lo": pooled([p for p in pcs if mid(p) < MID_FT]),
            "hi": pooled([p for p in pcs if mid(p) >= MID_FT]),
            "pk": max(s["e"] for s in seg), "n": len(pcs), "seg": seg}


def from_blob(blob, elev_ft: float | None = None) -> dict | None:
    """EDR record from a stored approach_series / departure_series blob.  Never raises."""
    if not blob:
        return None
    try:
        from collector.windshear import WindshearTracker
        return compute(WindshearTracker.decode_series(blob), elev_ft)
    except Exception:                         # noqa: BLE001  (a damaged blob)
        return None


def summary(rec: dict | None) -> dict | None:
    """The record without the pieces (for the history lists)."""
    if not rec:
        return None
    return {k: rec.get(k) for k in ("m", "lo", "hi", "pk", "n")}
