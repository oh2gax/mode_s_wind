"""
collector/approach_cond.py

Approach-conditions index — a single 0–10 number per landing describing how
"rough" the established final approach was, computed from the roughness
summary the windshear tracker stores in approach_history.rough_json (see
WindshearTracker._rough_record).

PROVISIONAL (2026-10-06): the reference values below were set from the first
day of data (gusty, METAR 280/18–21G32) and general expectations for calm
days.  They are meant to be re-tuned once calm and windy days have been
collected.  The index is computed when the API is called and is never stored,
so changing the constants here re-scores all past landings.

Components (per altitude segment "hi" 3000–1000 ft / "lo" 1000–200 ft MSL):

  ias   IAS fluctuation (kt)        — gust response along the flight path
  roll  bank-angle fluctuation (°)  — lateral gusts / roll upsets
  vr    vertical-rate fluctuation   — up- and downdrafts (ft/min)
  crab  crab-angle std (°)          — gusty crosswind

Each component is scored 0–10 linearly between a "calm" and a "rough"
reference value; the segment score is the weighted mean of the available
components; the landing index is the mean of the available segments,
divided by an aircraft-class factor (light aircraft respond more to the same
air) and clipped to 0–10.

The "high-pass" statistics (rhp / ihp / vhp, from 2026-10-06 ~16 UTC) are
preferred; the first records only have the plain statistics (rr / isd / vsd),
which also contain slow changes (intercept turn, glideslope capture) and use
their own, higher references.
"""

from __future__ import annotations

# (key, fallback key, calm ref, rough ref, fallback calm, fallback rough, weight)
_COMPONENTS = (
    ("ias",  "ihp", "isd", 1.0,  5.0,  1.2,  6.0,  0.35),
    ("roll", "rhp", "rr",  0.4,  3.0,  0.6,  4.0,  0.30),
    ("vr",   "vhp", "vsd", 40.0, 250.0, 60.0, 300.0, 0.20),
    ("crab", "csd", None,  0.5,  2.5,  None, None, 0.15),
)

SEG_MIN_SAMPLES = 8          # replies needed before a segment is scored

LEVELS = (                   # (upper bound, label)
    (2.0,  "Smooth"),
    (4.0,  "Light"),
    (6.0,  "Choppy"),
    (8.0,  "Rough"),
    (99.0, "Very rough"),
)

# Aircraft class → response factor (index divided by this)
CLASS_FACTOR = {"T": 1.35, "B": 1.25, "R": 1.15, "N": 1.0, "W": 0.85, "?": 1.0}
CLASS_NAME   = {"T": "turboprop", "B": "business jet", "R": "regional jet",
                "N": "narrowbody", "W": "widebody", "?": "unknown"}

_TURBOPROP = ("AT4", "AT7", "ATP", "DH8", "SF34", "SB20", "D328", "F50", "JS3",
              "JS4", "E120", "L410", "PC12", "C208", "B190", "BE20", "BE9",
              "SW4", "DHC6", "C130", "AN26", "AN24", "P180", "TBM", "PC6")
_REGIONAL  = ("E170", "E75", "E190", "E195", "E290", "E295", "E135", "E145",
              "CRJ", "BCS1", "BCS3", "F100", "F70", "RJ8", "RJ1", "B462",
              "B463", "SU95")
_WIDEBODY  = ("A30", "A310", "A33", "A34", "A35", "A38", "B74", "B76", "B77",
              "B78", "MD11", "IL96", "A3ST")
_BIZJET    = ("GLF", "GL5", "GL6", "GL7", "GLEX", "CL30", "CL35", "CL60", "F900",
              "FA", "C25", "C5", "C68", "C70", "C750", "E50", "E55", "LJ",
              "PC24", "H25", "G28", "HDJT")


def aircraft_class(type_code: str | None) -> str:
    """T turboprop, B business jet, R regional jet, N narrowbody, W widebody, ? unknown."""
    t = (type_code or "").upper().strip()
    if not t:
        return "?"
    if t.startswith(_TURBOPROP):
        return "T"
    if t.startswith(_REGIONAL):
        return "R"
    if t.startswith(_WIDEBODY):
        return "W"
    if t.startswith(_BIZJET):
        return "B"
    return "N"


def level_label(idx: float) -> tuple[int, str]:
    for i, (ub, lbl) in enumerate(LEVELS):
        if idx < ub:
            return i, lbl
    return len(LEVELS) - 1, LEVELS[-1][1]


def _score(v: float, calm: float, rough: float) -> float:
    return max(0.0, min(10.0, (v - calm) / (rough - calm) * 10.0))


def _segment(seg: dict) -> dict | None:
    n = max(seg.get("n5") or 0, seg.get("n6") or 0)
    if n < SEG_MIN_SAMPLES:
        return None
    vals, scores, wsum = {}, 0.0, 0.0
    for name, key, fb, c, r, fc, fr, w in _COMPONENTS:
        v = seg.get(key)
        cc, rr = c, r
        if v is None and fb is not None:
            v, cc, rr = seg.get(fb), fc, fr
        if v is None:
            continue
        vals[name] = v
        scores += _score(float(v), cc, rr) * w
        wsum   += w
    if wsum == 0:
        return None
    return {"idx": round(scores / wsum, 1), "n": n, **vals}


def _metar_str(m: dict | None) -> str | None:
    if not m:
        return None
    d = "VRB" if m.get("dir") is None else f"{m['dir']:03d}"
    g = f"G{m['gst']:02d}" if m.get("gst") else ""
    return f"{d}{m.get('spd', 0):02d}{g}KT"


def approach_index(rough: dict | None, aircraft_type: str | None = None) -> dict | None:
    """Approach-conditions index for one landing, or None when not enough data.

    Returns {"idx": 0–10, "lvl": 0–4, "lbl": "Smooth"…"Very rough",
             "cls": class letter, "raw": index before the class factor,
             "hi": {...} / "lo": {...} segment scores and component values,
             "metar": "28018G30KT" or None}
    """
    if not rough:
        return None
    segs = {}
    for name in ("hi", "lo"):
        if isinstance(rough.get(name), dict):
            s = _segment(rough[name])
            if s:
                segs[name] = s
    metar = _metar_str(rough.get("metar"))
    if not segs:
        return {"idx": None, "metar": metar} if metar else None
    raw = sum(s["idx"] for s in segs.values()) / len(segs)
    cls = aircraft_class(aircraft_type)
    idx = round(min(10.0, raw / CLASS_FACTOR[cls]), 1)
    lvl, lbl = level_label(idx)
    return {"idx": idx, "lvl": lvl, "lbl": lbl, "cls": cls, "raw": round(raw, 1),
            **segs, "metar": metar}
