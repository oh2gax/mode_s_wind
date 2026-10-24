"""
collector/tcorr.py — upper-level temperature correction learnt from the MEPS
model (from 2026-10-24).

The Mach / TAS temperature of the fleet reads warm at cruise levels: against
the MEPS weather model over the same 150 km area (MEPS check) +0.7 to +0.8 K
at 300–250 hPa and +0.6 K at 200 hPa, steady over a month (22 Oct study) and
through the front of 23–24 Oct 2026, while MEPS itself agrees with the
Jokioinen soundings there within ±0.1 K.  Below 400 hPa the difference is
within ±0.3 K and not steady, so nothing is corrected there.

Learning: every hour (hourly-jobs thread), from the stored hourly area
profiles (profile_hours — always the raw Mach / TAS values) and the MEPS
hours (meps_hours, leads ≤ 2 h) of the last DAYS days, hours with at least
BUSY aircraft: the mean difference Mode S − MEPS per pressure level, shrunk
towards 0 with PRIOR_H hours and used only with at least MIN_H hours.  One
row per update in t_correction (kept KEEP_DAYS days).

Applying (web/api/sounding.py — the Skew-T area profile, live and per hour,
flight profiles and the time–height section): the correction −bias at 400,
300, 250 and 200 hPa, interpolated in ln p between them, held above 200 hPa
and tapered to 0 between 400 and 500 hPa (about FL180–FL240).  The Wind Map,
the MEPS check, the Sonde check, the moisture indicator and everything stored
keep the raw values, so the correction can always be learnt again and checked.

Independent of the model when needed: without new model data the last learnt
values are used; with no learnt values (or TEMP_CORRECTION = False in
config.py) nothing is corrected.  Test on 27 soundings of 12–24 Oct 2026
(bias learnt from 19–24 Oct leaving out each sounding's day): 200–300 hPa RMS
1.27 → 0.96 K, bias +0.8–0.9 → +0.1–0.3 K; 400–925 hPa unchanged.
"""

from __future__ import annotations

import json
import logging
import math
import time

log = logging.getLogger("modes.tcorr")

ENABLED = True               # config TEMP_CORRECTION
DAYS = 21.0                  # config TEMP_CORRECTION_DAYS: learning window
BUSY = 8                     # aircraft in the hour
MIN_H = 24                   # hours needed at a level
PRIOR_H = 24.0               # shrink towards 0 with this many hours
KEEP_DAYS = 90
LEVELS = (400.0, 300.0, 250.0, 200.0)   # corrected levels (hPa)
TAPER_P = 500.0                          # correction 0 at and below this pressure (hPa)

_cache = {"t": 0.0, "val": None}
CACHE_SEC = 600


def init(cfg) -> None:
    global ENABLED, DAYS
    ENABLED = bool(getattr(cfg, "TEMP_CORRECTION", True))
    DAYS = float(getattr(cfg, "TEMP_CORRECTION_DAYS", 21))


def ensure_table(db) -> None:
    db.execute("""CREATE TABLE IF NOT EXISTS t_correction (
                      ts   INTEGER PRIMARY KEY,   -- time of learning
                      data TEXT    NOT NULL)""")


def learn(db, now: float | None = None) -> dict | None:
    """Mode S − MEPS per pressure level over the last DAYS days:
    {"ts", "days", "src": "meps", "n": {hPa: hours}, "bias": {hPa: K},
     "corr": {hPa: K applied}} or None without model data."""
    from collector import meps
    now = time.time() if now is None else now
    t1 = int(now // 3600 * 3600)
    t0 = t1 - int(DAYS * 86400)
    rows = meps.hours(db, t0, t1 + 7200, meps.VERIF_MAX_LEAD)
    if not rows:
        return None
    P = next(iter(rows.values()))["p"]
    diffs: dict = {p: [] for p in P}
    for h, data in db.execute("SELECT ts, data FROM profile_hours WHERE ts >= ? AND ts < ?", (t0, t1)):
        try:
            pr = json.loads(data)
        except (ValueError, TypeError):
            continue
        if (pr.get("a") or 0) < BUSY:
            continue
        m = meps._hour_mean(rows, h)
        if not m:
            continue
        a = meps.modes_levels(pr.get("lv"), P)
        for i, p in enumerate(P):
            if a["t"][i] is not None and m["t"][i] is not None:
                diffs[p].append(a["t"][i] - m["t"][i])
    out = {"ts": int(now), "days": DAYS, "src": "meps", "n": {}, "bias": {}, "corr": {}}
    for p, d in diffs.items():
        if not d:
            continue
        key = str(int(p))
        out["n"][key] = len(d)
        out["bias"][key] = round(sum(d) / len(d), 2)
        if p in LEVELS and len(d) >= MIN_H:
            out["corr"][key] = round(-sum(d) / (len(d) + PRIOR_H), 2)
    return out


def update(db, now: float | None = None) -> dict | None:
    """Learn and store a new row (hourly); returns it (None without model data)."""
    now = time.time() if now is None else now
    ensure_table(db)
    val = learn(db, now)
    if val is None:
        return None
    db.execute("INSERT OR REPLACE INTO t_correction (ts, data) VALUES (?, ?)",
               (val["ts"], json.dumps(val, separators=(",", ":"))))
    db.execute("DELETE FROM t_correction WHERE ts < ?", (int(now - KEEP_DAYS * 86400),))
    db.commit()
    _cache["t"] = 0.0
    return val


def current(db) -> dict | None:
    """The newest learnt correction (cached), or None (off / never learnt)."""
    if not ENABLED:
        return None
    now = time.time()
    if now - _cache["t"] < CACHE_SEC:
        return _cache["val"]
    val = None
    try:
        row = db.execute("SELECT data FROM t_correction ORDER BY ts DESC LIMIT 1").fetchone()
        if row:
            val = json.loads(row[0])
            if not val.get("corr"):
                val = None
    except Exception:                                    # noqa: BLE001  (no table yet)
        val = None
    _cache.update(t=now, val=val)
    return val


def _isa_p(ft: float) -> float:
    return 1013.25 * (1 - 6.8756e-6 * ft) ** 5.2559


def at_ft(corr: dict | None, ft: float | None) -> float:
    """Correction (K, to add) at a pressure altitude (ft)."""
    if not corr or ft is None:
        return 0.0
    c = {float(k): v for k, v in (corr.get("corr") or {}).items()}
    if not c:
        return 0.0
    p = _isa_p(ft)
    if p >= TAPER_P:
        return 0.0
    pts = sorted([(TAPER_P, 0.0)] + list(c.items()), key=lambda x: -x[0])   # 500, 400, 300, …
    if p <= pts[-1][0]:
        return pts[-1][1]
    for (pa, ca), (pb, cb) in zip(pts, pts[1:]):
        if pa >= p >= pb:
            w = math.log(pa / p) / math.log(pa / pb)
            return ca + (cb - ca) * w
    return 0.0


def info(corr: dict | None) -> dict | None:
    """Small summary for the pages: {"src", "ts", "days", "corr": {hPa: K}}."""
    if not corr:
        return None
    return {"src": corr.get("src"), "ts": corr.get("ts"), "days": corr.get("days"),
            "corr": corr.get("corr"), "n": {k: corr.get("n", {}).get(k) for k in (corr.get("corr") or {})}}


def layer_top(lo: float):
    """Top (ft) of the area-profile layer starting at lo (collector/atmos.py)."""
    from collector.atmos import LAYER_EDGES
    try:
        k = LAYER_EDGES.index(lo)
        return LAYER_EDGES[k + 1] if k + 1 < len(LAYER_EDGES) else None
    except ValueError:
        return None


def apply_levels(levels: list, corr: dict | None, alt_key: str = "alt_lo", top_key: str = "alt_hi") -> None:
    """Correct a list of level dicts in place (temp, temp_p10, temp_p90 at the
    layer centre); the raw value is kept as temp_uncorr, the correction as temp_corr."""
    if not corr:
        return
    for lv in levels or []:
        if lv.get("temp") is None:
            continue
        lo, hi = lv.get(alt_key), lv.get(top_key)
        if lo is not None and hi is None:
            hi = layer_top(lo)
        ft = (lo + hi) / 2 if lo is not None and hi is not None else (lo if lo is not None else lv.get("altitude"))
        if ft is None and lv.get("pressure"):
            ft = (1 - (lv["pressure"] / 1013.25) ** (1 / 5.2559)) / 6.8756e-6
        k = at_ft(corr, ft)
        if abs(k) < 0.05:
            continue
        lv["temp_uncorr"] = lv["temp"]
        lv["temp_corr"] = round(k, 2)
        for key in ("temp", "temp_p10", "temp_p90"):
            if lv.get(key) is not None:
                lv[key] = round(lv[key] + k, 2)
