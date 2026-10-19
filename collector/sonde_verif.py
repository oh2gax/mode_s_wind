"""
Automatic verification of the Mode S area profile against the radiosonde
(collector/sondes.py, Jokioinen, FMI open data).

Run by the hourly jobs thread (run.py), two kinds of rows in the table
sonde_verification (a few small INSERTs an hour):

  launch  the area profile of ±1 h around each sounding's launch (computed
          from the observations, all aircraft within SOUNDING_RADIUS_KM, as
          in the comparisons of the upper-air article) minus the sounding:
          how well the Mode S profile agrees with the balloon;
  hour    each archived hourly area profile (profile_hours) minus the newest
          sounding launched by the middle of that hour (+ 15 min; at most
          24 h before): how far the atmosphere has moved away from an ageing
          sounding (age_h = hour middle − launch, ≥ 0).  Hours are taken once
          they are 3 h old, so the sounding launched before them has been
          published; a row made with an older sounding because the one
          launched in that hour was stored only later (FMI late, an extra
          launch found by the start-up back-fill) is computed again.

Per row: layers used, temperature bias (area − sonde) and RMS, wind vector
RMS difference and speed bias, and the same per altitude band (bands JSON).
Layers count when they have ≥ 3 replies (temperature / wind) and lie within
the sounding's range (FMI profiles may stop early).  Sonde values are
interpolated in log pressure to the layer's ISA pressure.
"""

from __future__ import annotations

import json
import logging
import math
import time
from typing import Optional

log = logging.getLogger("modes.sonde_verif")

BANDS = ((0, 5000, "0-5k"), (5000, 10000, "5-10k"), (10000, 20000, "10-20k"),
         (20000, 30000, "20-30k"), (30000, 45000, "30k+"))
MIN_REPLIES = 3
HOUR_DELAY_SEC = 3 * 3600        # an hour is verified once it is this old
MAX_SONDE_AGE_SEC = 24 * 3600
BACKFILL_DAYS = 14

SCHEMA = """
CREATE TABLE IF NOT EXISTS sonde_verification (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    kind      TEXT    NOT NULL,      -- 'launch' | 'hour'
    ts        INTEGER NOT NULL,      -- launch time (launch) / hour start (hour)
    sonde_key TEXT    NOT NULL,      -- YYYYMMDDHH of the sounding
    age_h     REAL,                  -- profile middle − launch (h)
    min_p     REAL,                  -- top of the sounding (hPa)
    aircraft  INTEGER,               -- distinct aircraft behind the area profile
    obs       INTEGER,               -- observations used
    n_t       INTEGER, t_bias REAL, t_rms REAL,
    n_w       INTEGER, w_rms  REAL, ws_bias REAL,
    bands     TEXT,                  -- {"0-5k": {n_t, t_bias, t_rms, n_w, w_rms}, …}
    UNIQUE(kind, ts)
);
CREATE INDEX IF NOT EXISTS idx_sondever_ts ON sonde_verification(ts);
"""


def ensure_table(db) -> None:
    db.executescript(SCHEMA)


# ── Comparison ───────────────────────────────────────────────────────────

class SondeProfile:
    """Stored sounding record (collector/sondes.py) for interpolation."""

    def __init__(self, rec: dict):
        rows = [r for r in rec.get("lv") or [] if r[0]]
        rows.sort(key=lambda r: -r[0])           # pressure descending
        self.t = [(math.log(r[0]), r[3]) for r in rows if r[3] is not None]
        self.uv = []
        for r in rows:
            if r[5] is not None and r[6] is not None:
                a = math.radians(r[5])
                self.uv.append((math.log(r[0]), -r[6] * math.sin(a), -r[6] * math.cos(a)))
        self.min_p = min((r[0] for r in rows), default=None)
        self.max_p = max((r[0] for r in rows), default=None)

    @staticmethod
    def _interp(series, lp, k):
        # series: ascending in -lp order (pressure descending → log p descending)
        prev = None
        for row in series:
            if row[0] <= lp:
                if prev is None:
                    return row[k] if abs(row[0] - lp) < 1e-3 else None
                f = (prev[0] - lp) / (prev[0] - row[0]) if prev[0] != row[0] else 0.0
                return prev[k] + (row[k] - prev[k]) * f
            prev = row
        return None

    def temp(self, p: float) -> Optional[float]:
        return self._interp(self.t, math.log(p), 1)

    def wind_uv(self, p: float):
        lp = math.log(p)
        u = self._interp(self.uv, lp, 1)
        v = self._interp(self.uv, lp, 2)
        return None if u is None or v is None else (u, v)


def _isa_p(alt_ft: float) -> float:
    return 1013.25 * (1 - alt_ft / 145366.45) ** (1 / 0.190263)


def compare(levels: list, sonde: SondeProfile) -> dict:
    """Area-profile levels (atmos.aggregate_layers / unpack_levels dicts) minus
    the sounding → stats dict (None values when no common layer)."""
    acc = {"all": [0, 0.0, 0.0, 0, 0.0, 0.0]}     # n_t, sum dT, sum dT², n_w, sum dV², sum dS
    for _, _, name in BANDS:
        acc[name] = [0, 0.0, 0.0, 0, 0.0, 0.0]
    for lv in levels:
        alt = lv.get("altitude")
        if alt is None:
            lo, hi = lv.get("alt_lo"), lv.get("alt_hi")
            alt = (lo + hi) / 2 if lo is not None and hi is not None else None
        if alt is None:
            continue
        p = lv.get("pressure") or _isa_p(alt)
        band = next((n for lo, hi, n in BANDS if lo <= alt < hi), None)
        targets = [acc["all"]] + ([acc[band]] if band else [])
        if lv.get("temp") is not None and (lv.get("temp_count") or 0) >= MIN_REPLIES:
            ts = sonde.temp(p)
            if ts is not None:
                d = lv["temp"] - ts
                for a in targets:
                    a[0] += 1; a[1] += d; a[2] += d * d
        if (lv.get("wind_spd") is not None and lv.get("wind_dir") is not None
                and (lv.get("wind_count") or 0) >= MIN_REPLIES):
            uv = sonde.wind_uv(p)
            if uv is not None:
                r = math.radians(lv["wind_dir"])
                ua, va = -lv["wind_spd"] * math.sin(r), -lv["wind_spd"] * math.cos(r)
                dv2 = (ua - uv[0]) ** 2 + (va - uv[1]) ** 2
                ds = lv["wind_spd"] - math.hypot(*uv)
                for a in targets:
                    a[3] += 1; a[4] += dv2; a[5] += ds

    def stats(a):
        n_t, st, st2, n_w, sv2, ss = a
        return {"n_t": n_t,
                "t_bias": round(st / n_t, 2) if n_t else None,
                "t_rms": round(math.sqrt(st2 / n_t), 2) if n_t else None,
                "n_w": n_w,
                "w_rms": round(math.sqrt(sv2 / n_w), 1) if n_w else None,
                "ws_bias": round(ss / n_w, 1) if n_w else None}
    out = stats(acc["all"])
    out["bands"] = {name: stats(acc[name]) for _, _, name in BANDS if acc[name][0] or acc[name][3]}
    return out


# ── Hourly job ───────────────────────────────────────────────────────────

def _insert(db, kind, ts, key, age_h, rec, aircraft, obs, st) -> None:
    db.execute(
        """INSERT OR REPLACE INTO sonde_verification
           (kind, ts, sonde_key, age_h, min_p, aircraft, obs, n_t, t_bias, t_rms,
            n_w, w_rms, ws_bias, bands)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (kind, int(ts), key, None if age_h is None else round(age_h, 2), rec.get("min_p"),
         aircraft, obs, st["n_t"], st["t_bias"], st["t_rms"], st["n_w"], st["w_rms"],
         st["ws_bias"], json.dumps(st["bands"], separators=(",", ":"))))


def run_verification(db, store, lat: float, lon: float, radius_km: float,
                     now: Optional[float] = None, backfill_days: float = BACKFILL_DAYS) -> int:
    """Add the missing launch and hour rows of the last backfill_days.
    Returns the number of rows written (one commit)."""
    from collector.atmos import area_profile, unpack_levels
    now = time.time() if now is None else now
    if store is None:
        return 0
    ensure_table(db)
    since = now - backfill_days * 86400
    items = [it for it in store.items() if (it.get("launch") or it.get("nominal") or 0) >= since - MAX_SONDE_AGE_SEC]
    if not items:
        return 0
    cache: dict = {}

    def profile(key):
        if key not in cache:
            rec = store.load(key)
            cache[key] = (rec, SondeProfile(rec)) if rec else (None, None)
        return cache[key]

    launches = sorted(((it.get("launch") or it.get("nominal")), it["key"]) for it in items)

    def sonde_for_hour(ts):
        """(launch, key) of the newest sounding launched by the hour middle
        (a balloon launched up to 15 min after it still counts: launches are
        at about HH:30, age ≈ 0), at most MAX_SONDE_AGE_SEC old; else None."""
        mid = ts + 1800
        prev = [(t, k) for t, k in launches if t <= mid + 900]
        if not prev or mid - prev[-1][0] > MAX_SONDE_AGE_SEC:
            return None
        return prev[-1]

    # Rows made with an earlier version of a sounding — a fuller copy stored
    # later, or a top cut by the quality check (sondes.quality_cut) — have a
    # different top (min_p): delete them so they are computed again.  The same
    # for an hour row made with an older sounding because the one launched in
    # that hour was stored only after the row (FMI late, or a restart).
    top = {it["key"]: it.get("min_p") for it in items}
    launch_of = {k: t for t, k in launches}
    have, redo = set(), []
    n_newer = 0
    for k, t, key, mp in db.execute(
            "SELECT kind, ts, sonde_key, min_p FROM sonde_verification WHERE ts >= ?",
            (int(since - 3600),)):
        if key in top and top[key] is not None and mp is not None and abs(top[key] - mp) > 0.5:
            redo.append((k, t))
            continue
        if k == "hour":
            want = sonde_for_hour(t)
            if (want is not None and want[1] != key and key in launch_of
                    and want[0] > launch_of[key]):
                redo.append((k, t))
                n_newer += 1
                continue
        have.add((k, t))
    if redo:
        db.executemany("DELETE FROM sonde_verification WHERE kind = ? AND ts = ?", redo)
        log.info("Sonde verification: %d row(s) of changed soundings recomputed%s", len(redo),
                 f" ({n_newer} hour row(s) now with a newer sounding)" if n_newer else "")
    n = 0
    # launch rows: area profile ±1 h around the launch, once the hour after it is over
    for it in items:
        t0 = it.get("launch") or it.get("nominal")
        if t0 is None or t0 < since or t0 + 3600 > now - 300 or ("launch", int(t0)) in have:
            continue
        rec, sp = profile(it["key"])
        if sp is None:
            continue
        levels, used, n_ac = area_profile(db, t0 - 3600, t0 + 3600, lat, lon, radius_km, with_aircraft=True)
        if not used:
            continue
        _insert(db, "launch", t0, it["key"], 0.0, rec, n_ac, used, compare(levels, sp))
        n += 1
    # hour rows: archived hourly profiles vs the newest sounding launched before the hour middle
    for ts, data in db.execute(
            "SELECT ts, data FROM profile_hours WHERE ts >= ? AND ts < ? ORDER BY ts",
            (int(since // 3600 * 3600), int(now - HOUR_DELAY_SEC))):
        if ("hour", int(ts)) in have:
            continue
        mid = ts + 1800
        pick = sonde_for_hour(ts)
        if pick is None:
            continue
        t0, key = pick
        rec, sp = profile(key)
        if sp is None:
            continue
        try:
            d = json.loads(data)
        except ValueError:
            continue
        st = compare(unpack_levels(d.get("lv") or []), sp)
        if not st["n_t"] and not st["n_w"]:
            continue
        _insert(db, "hour", ts, key, max(0.0, (mid - t0) / 3600), rec, d.get("a"), d.get("n"), st)
        n += 1
    if n or redo:
        db.commit()
    return n


# ── Summary for the web page ─────────────────────────────────────────────

AGE_BINS = ((0, 1), (1, 2), (2, 3), (3, 4), (4, 6), (6, 8), (8, 10), (10, 12), (12, 18), (18, 24))


def _pool(rows, prefix=""):
    """Pool per-row stats (each weighted by its layer count)."""
    nt = sum(r["n_t"] or 0 for r in rows)
    nw = sum(r["n_w"] or 0 for r in rows)
    st = sum((r["t_bias"] or 0) * (r["n_t"] or 0) for r in rows)
    st2 = sum((r["t_rms"] or 0) ** 2 * (r["n_t"] or 0) for r in rows)
    sv2 = sum((r["w_rms"] or 0) ** 2 * (r["n_w"] or 0) for r in rows)
    ss = sum((r["ws_bias"] or 0) * (r["n_w"] or 0) for r in rows)
    bias = st / nt if nt else None
    rms = math.sqrt(st2 / nt) if nt else None
    return {"rows": len(rows), "n_t": nt, "n_w": nw,
            "t_bias": None if bias is None else round(bias, 2),
            "t_rms": None if rms is None else round(rms, 2),
            "t_sd": None if rms is None else round(math.sqrt(max(0.0, rms * rms - bias * bias)), 2),
            "w_rms": round(math.sqrt(sv2 / nw), 1) if nw else None,
            "ws_bias": round(ss / nw, 1) if nw else None}


def summary(db, days: float = 30, now: Optional[float] = None) -> dict:
    now = time.time() if now is None else now
    ensure_table(db)
    cols = ("kind", "ts", "sonde_key", "age_h", "min_p", "aircraft", "obs",
            "n_t", "t_bias", "t_rms", "n_w", "w_rms", "ws_bias", "bands")
    rows = [dict(zip(cols, r)) for r in db.execute(
        f"SELECT {', '.join(cols)} FROM sonde_verification WHERE ts >= ? ORDER BY ts",
        (int(now - days * 86400),))]
    for r in rows:
        try:
            r["bands"] = json.loads(r["bands"]) if r["bands"] else {}
        except ValueError:
            r["bands"] = {}
    launch = [r for r in rows if r["kind"] == "launch"]
    hours = [r for r in rows if r["kind"] == "hour"]
    bands = []
    for _, _, name in BANDS:
        sub = [b for b in (r["bands"].get(name) for r in launch) if b]
        if sub:
            bands.append(dict(_pool(sub), band=name))
    age = []
    for lo, hi in AGE_BINS:
        sub = [r for r in hours if r["age_h"] is not None and lo <= r["age_h"] < hi]
        if sub:
            age.append(dict(_pool(sub), lo=lo, hi=hi))
    return {"days": days, "launch_total": _pool(launch), "bands": bands, "age": age,
            "hour_total": _pool(hours),
            "launches": [{k: r[k] for k in cols if k != "bands"} for r in reversed(launch)]}
