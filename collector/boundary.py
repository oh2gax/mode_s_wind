"""
collector/boundary.py — the boundary layer at the airport, hour by hour
(from 2026-10-29; RESEARCH): the wind profile up to 5 000 ft, the
low-level jet and the surface inversion.

Per UTC hour (table bl_hours, written by the hourly jobs thread a few
minutes after the hour; the hour in progress is computed when asked):

  wind   the median wind (u / v) of the observations of all aircraft within
         BL_RADIUS_KM (25 km) of the airport in 250-ft bins from 250 to
         5 000 ft MSL (pressure altitude corrected with the METAR QNH),
         at least 3 observations per bin → "w": [[ft, kt, dir°, n], …]
  temp   the airport low-level profile of the hour (web/api/lowlevel.py: the
         200-ft bands of the landings and departures, at least 4 flights per
         band — 400–3 000 ft MSL from both, and from 30 Oct 2026 3 200–5 000 ft
         from the climb-outs, collector/departures.py DEP_BANDS), smoothed over
         ±200 ft → "t": [[ft, °C, n]]
         and the METAR temperature "tt" (°C) and QNH "q"
  llj    low-level jet (Baas et al. 2009, made stricter by the study of
         29 Oct 2026): the strongest local wind maximum ("nose") at most
         2 000 ft above the airport whose speed falls by at least 2.5 m/s
         and 25 % within 1 500 ft above it, and is at least 4 kt above the
         lowest speed below it → {"ft", "kt", "dir", "drop" (m/s), "sh"
         (kt per 1 000 ft below the nose)}
  inv    surface inversion: the air at 600–1 000 ft MSL at least 0.5 K
         warmer than the METAR temperature → {"dT" (K), "top" (the highest
         band still at least half that much warmer, ft MSL)}

Study (29 Sep – 29 Oct 2026): a jet in 10 % of the hours (16 % at night,
4 % at midday; typical nose 1 500 ft, 23 kt); a surface inversion in 15 %
(23 % at night, 2 % by day; 49 % with a wind under 5 kt, none from 10 kt;
up to +9 K on the calm, clear night of 19–20 Oct).  The aircraft
temperatures at 600–1 000 ft read 1.75 K below the METAR in windy daytime
hours — the dry-adiabatic 1.8 K — so they carry no measurable bias there.
Under an inversion the turbulence (EDR) below 1 000 ft was nil.  The
nights 01–05 local have few flights, so the jet's peak hours are often
unseen ("w" empty).

Rows are small (about 1–1.5 kB), one a hour; never purged.
"""

from __future__ import annotations

import json
import math
import statistics as st
import time

KT_MS = 0.514444
BL_RADIUS_KM = 25.0
BIN_FT = 250
TOP_FT = 5000
MIN_OBS = 3
QNH_FT_PER_HPA = 27.0

# low-level jet (heights above the airport)
LLJ_NOSE_MAX_FT = 2000
LLJ_SPAN_FT = 1500
LLJ_DROP_MS = 2.5
LLJ_DROP_REL = 1.25
LLJ_BELOW_KT = 2 / KT_MS             # 2 m/s ≈ 3.9 kt above the lowest speed below

INV_DT = 0.5                          # K
INV_MIN_FLIGHTS = 4

_cfg = {"lat": 60.3172, "lon": 24.9634, "elev": 179.0}


def init(cfg) -> None:
    _cfg["lat"] = float(getattr(cfg, "WINDSHEAR_AIRPORT_LAT", _cfg["lat"]))
    _cfg["lon"] = float(getattr(cfg, "WINDSHEAR_AIRPORT_LON", _cfg["lon"]))
    _cfg["elev"] = float(getattr(cfg, "WINDSHEAR_THR_ELEVATION_FT", _cfg["elev"]))


def _metar_for_hour(db, h: int) -> dict:
    """METAR temperature / QNH for the hour: the stored METAR closest to
    h + 30 min (metar_reports, from 29 Oct 2026), else the "m" of the hourly
    profile archive (from 11 Oct 2026)."""
    try:
        r = db.execute("SELECT tt, qnh FROM metar_reports WHERE ts BETWEEN ? AND ? AND tt IS NOT NULL "
                       "ORDER BY abs(ts - ?) LIMIT 1", (h - 1800, h + 4200, h + 1800)).fetchone()
        if r:
            return {"tt": r[0], "q": r[1]}
    except Exception:                                # noqa: BLE001  (table missing)
        pass
    try:
        r = db.execute("SELECT data FROM profile_hours WHERE ts = ?", (h,)).fetchone()
        m = (json.loads(r[0]) or {}).get("m") if r else None
        if m and m.get("tt") is not None:
            return {"tt": m.get("tt"), "q": m.get("q")}
    except Exception:                                # noqa: BLE001
        pass
    return {}


def _wind_bins(db, t0: float, t1: float, qnh: float | None) -> list:
    lat, lon = _cfg["lat"], _cfg["lon"]
    dlat = BL_RADIUS_KM / 111.2
    dlon = BL_RADIUS_KM / (111.2 * math.cos(math.radians(lat)))
    corr = (1013.25 - qnh) * QNH_FT_PER_HPA if qnh else 0.0
    bins: dict[int, list] = {}
    for alt, spd, dr in db.execute(
            "SELECT altitude, best_wind_spd, best_wind_dir FROM observations "
            "WHERE ts >= ? AND ts < ? AND altitude BETWEEN ? AND ? "
            "AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? "
            "AND best_wind_spd IS NOT NULL AND best_wind_dir IS NOT NULL",
            (t0, t1, -1000, TOP_FT + 1200, lat - dlat, lat + dlat, lon - dlon, lon + dlon)):
        msl = alt - corr
        b = int((msl + BIN_FT / 2) // BIN_FT * BIN_FT)
        if b < BIN_FT or b > TOP_FT:
            continue
        r = math.radians(dr)
        bins.setdefault(b, []).append((spd * math.sin(r), spd * math.cos(r)))
    out = []
    for b in sorted(bins):
        o = bins[b]
        if len(o) < MIN_OBS:
            continue
        u, v = st.median(x[0] for x in o), st.median(x[1] for x in o)
        out.append([b, round(math.hypot(u, v)), round((math.degrees(math.atan2(u, v)) + 360) % 360), len(o)])
    return out


def detect_llj(w: list, elev: float | None = None) -> dict | None:
    """Low-level jet from the wind bins [[ft MSL, kt, dir, n]] (see the module text)."""
    elev = _cfg["elev"] if elev is None else elev
    if len(w) < 5:
        return None
    p = {b: (kt, d) for b, kt, d, *_ in w}
    bs = sorted(p)
    s = {b: st.mean(p[x][0] for x in bs if abs(x - b) <= BIN_FT) for b in bs}   # ±250 ft smoothing
    best = None
    for b in bs:
        if b - elev > LLJ_NOSE_MAX_FT:
            break
        nb = [s[x] for x in bs if abs(x - b) == BIN_FT]
        if not nb or any(n > s[b] for n in nb):
            continue
        above = [s[x] for x in bs if b < x <= b + LLJ_SPAN_FT]
        if len(above) < 4:
            continue
        mn = min(above)
        drop = (s[b] - mn) * KT_MS
        below = [x for x in bs if x < b]
        if drop < LLJ_DROP_MS or s[b] < LLJ_DROP_REL * mn:
            continue
        if below and s[b] - min(s[x] for x in below) < LLJ_BELOW_KT:
            continue
        if best is None or s[b] > best["kt"]:
            sh = None
            if below:
                lo = min(below, key=lambda x: s[x])
                if b > lo:
                    sh = round((s[b] - s[lo]) / ((b - lo) / 1000), 1)
            best = {"ft": b, "kt": round(s[b]), "dir": p[b][1], "drop": round(drop, 1), "sh": sh}
    return best


def _temps(db, t1: float) -> list:
    from web.api.lowlevel import lowlevel_profile
    prof = lowlevel_profile(db, minutes=60, now=t1)
    lv = {l["alt_msl"]: (l["temp"], l.get("temp_count", 0)) for l in prof.get("levels") or []
          if l.get("temp") is not None and (l.get("temp_count") or 0) >= INV_MIN_FLIGHTS}
    bs = sorted(lv)
    return [[b, round(st.mean(lv[c][0] for c in bs if abs(c - b) <= 200), 1), lv[b][1]] for b in bs]


def detect_inv(t: list, tt) -> dict | None:
    """Surface inversion from the smoothed bands [[ft, °C, n]] and the METAR temperature."""
    if tt is None or not t:
        return None
    sm = {b: v for b, v, _ in t}
    low = [sm[b] for b in (600, 800, 1000) if b in sm]
    if len(low) < 2:
        return None
    dT = st.mean(low) - tt
    if dT < INV_DT:
        return None
    top = None
    for b in sorted(sm):
        if sm[b] >= tt + dT / 2:
            top = b
        elif top is not None:
            break
    return {"dT": round(dT, 1), "top": top}


def compute_hour(db, h: int, t1: float | None = None) -> dict:
    """The record of the hour starting at h (t1: end, default h + 1 h)."""
    t1 = h + 3600 if t1 is None else t1
    m = _metar_for_hour(db, h)
    w = _wind_bins(db, h, t1, m.get("q"))
    t = _temps(db, t1)
    rec = {"ts": h, "w": w, "t": t, "tt": m.get("tt"), "q": m.get("q")}
    rec["llj"] = detect_llj(w)
    rec["inv"] = detect_inv(t, m.get("tt"))
    return rec


def store_missing(db, max_hours: int = 48, now: float | None = None, pause_sec: float = 0.0) -> int:
    """Compute and store every completed hour of the last max_hours without a
    bl_hours row that has observations (the first start back-fills from the
    observations still in the database).  Returns the hours stored."""
    now = time.time() if now is None else now
    cur = int(now // 3600 * 3600)
    oldest = db.execute("SELECT MIN(ts) FROM observations").fetchone()[0]
    if oldest is None:
        return 0
    first = max(cur - max_hours * 3600, int(oldest // 3600 * 3600))
    have = {r[0] for r in db.execute("SELECT ts FROM bl_hours WHERE ts >= ? AND ts < ?", (first, cur))}
    rows, n = [], 0
    for h in range(first, cur, 3600):
        if h in have:
            continue
        rec = compute_hour(db, h)
        if pause_sec:
            time.sleep(pause_sec)               # back-fill: leave CPU / SD card to the collector
        if not rec["w"] and not rec["t"]:
            continue
        rows.append((h, json.dumps({k: v for k, v in rec.items() if k != "ts"}, separators=(",", ":"))))
        if len(rows) >= 48:
            db.executemany("INSERT OR IGNORE INTO bl_hours (ts, data) VALUES (?, ?)", rows)
            db.commit()
            n += len(rows)
            rows = []
    if rows:
        db.executemany("INSERT OR IGNORE INTO bl_hours (ts, data) VALUES (?, ?)", rows)
        db.commit()
        n += len(rows)
    return n


def recompute(db, hours, now: float | None = None, pause_sec: float = 0.0) -> int:
    """Compute again and replace the stored completed hours `hours` (hour
    starts) — after a back-fill changed their flights' profiles (from 30 Oct
    2026: the departure bands to 5 000 ft).  Returns the hours stored."""
    now = time.time() if now is None else now
    cur = int(now // 3600 * 3600)
    n = 0
    for h in sorted(set(int(x) for x in hours)):
        if h >= cur:
            continue
        rec = compute_hour(db, h)
        if pause_sec:
            time.sleep(pause_sec)
        if not rec["w"] and not rec["t"]:
            continue
        db.execute("INSERT OR REPLACE INTO bl_hours (ts, data) VALUES (?, ?)",
                   (h, json.dumps({k: v for k, v in rec.items() if k != "ts"}, separators=(",", ":"))))
        n += 1
        if n % 24 == 0:
            db.commit()
    db.commit()
    _live["t"] = 0.0                            # the hour in progress again with the new profiles
    return n


_live = {"t": 0.0, "h": None, "rec": None}


def _live_rec(db, now: float) -> dict:
    """The hour in progress (computed, cached 2 min)."""
    cur = int(now // 3600 * 3600)
    if _live["h"] != cur or now - _live["t"] > 120:
        _live.update(t=now, h=cur, rec=compute_hour(db, cur, now))
    return dict(_live["rec"], partial=1)


def at(db, end: float | None = None, now: float | None = None) -> dict | None:
    """The boundary layer for the Skew-T airport profile (/api/lowlevel "bl",
    from 2026-10-29): with `end` in the past the stored hour that ends the
    window (the hour containing end − 1 s); else the hour in progress when it
    already has at least 5 wind bins, otherwise the newest stored hour of the
    last 2 h.  {ts, llj, inv, tt, elev[, partial]} or None.  Never computes
    a stored hour (no extra load on the polling Live Map)."""
    now = time.time() if now is None else now
    r = None
    if end is not None and end < now - 60:
        h = int((end - 1) // 3600 * 3600)
        row = db.execute("SELECT data FROM bl_hours WHERE ts = ?", (h,)).fetchone()
        r = {"ts": h, **json.loads(row[0])} if row else None
    else:
        live = _live_rec(db, now)
        if len(live.get("w") or []) >= 5:
            r = live
        else:
            row = db.execute("SELECT ts, data FROM bl_hours WHERE ts >= ? ORDER BY ts DESC LIMIT 1",
                             (int(now // 3600 * 3600) - 2 * 3600,)).fetchone()
            r = {"ts": row[0], **json.loads(row[1])} if row else None
    if not r:
        return None
    out = {"ts": r["ts"], "llj": r.get("llj"), "inv": r.get("inv"), "tt": r.get("tt"), "elev": round(_cfg["elev"])}
    if r.get("partial"):
        out["partial"] = 1
    return out


def query(db, hours: float = 24, now: float | None = None, end: float | None = None) -> list:
    """The stored hours of the last `hours` (max 14 days) and the hour in
    progress (computed, cached 2 min), oldest first.  With `end` (Unix s) in
    the past (the Time–height section's "ending" date, from 29 Oct 2026):
    only the stored hours that start in [end − hours, end)."""
    now = time.time() if now is None else now
    hours = max(1.0, min(float(hours), 336.0))
    if end is not None and end < now - 3600:
        t1 = int(end // 3600 * 3600)
        out = []
        for ts, data in db.execute("SELECT ts, data FROM bl_hours WHERE ts >= ? AND ts < ? ORDER BY ts",
                                   (t1 - int(hours) * 3600, t1)):
            try:
                out.append({"ts": ts, **json.loads(data)})
            except ValueError:
                pass
        return out
    cur = int(now // 3600 * 3600)
    out = []
    for ts, data in db.execute("SELECT ts, data FROM bl_hours WHERE ts >= ? AND ts < ? ORDER BY ts",
                               (cur - int(hours) * 3600 - 3600, cur)):
        try:
            out.append({"ts": ts, **json.loads(data)})
        except ValueError:
            pass
    have = {r["ts"] for r in out}
    prev = cur - 3600
    if prev not in have and now - prev < 2 * 3600:   # the last hour not stored yet (job runs a few min after)
        out.append(compute_hour(db, prev))
    out.append(_live_rec(db, now))
    return out
