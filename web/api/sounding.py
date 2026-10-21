"""
Sounding data aggregation.

Area sounding (last SOUNDING_WINDOW_MIN minutes within SOUNDING_RADIUS_KM
of the receiver), hourly archive soundings (profile_hours) and per-flight
soundings, all in the altitude layers of collector/atmos.py with the
Mach/TAS temperature.

The result is a list of pressure-level dicts suitable for Skew-T rendering.
"""

import math
import sqlite3
import time
import logging
from typing import Optional

from config import Config
from collector.atmos import (TEMP_SQL, aggregate_layers, area_profile,
                             isa_pressure_hpa, unpack_levels)

log = logging.getLogger("modes.sounding")

def build_sounding(cfg: Config, db: sqlite3.Connection,
                   minutes: Optional[int] = None) -> dict:
    """
    Area sounding: all aircraft within SOUNDING_RADIUS_KM of the receiver over
    the last `minutes` (default SOUNDING_WINDOW_MIN), in altitude layers
    (1 000 ft to 10 000 ft, 2 000 ft above — collector/atmos.py).

    Temperature is the Mach/TAS temperature (median per layer; MRAR / MHR
    only where present); pressure is the ISA pressure of the pressure
    altitude.  (Until 2026-10-09 observations were binned by their reported
    pressure, which only the rare MRAR / MHR replies carry, so this view was
    almost always empty.)

    Returns {"mode": "area", "window_min", "radius_km", "obs_used", "aircraft",
             "generated_at", "levels"} — levels surface first; each level
    also has ac_count (distinct aircraft in the layer).
    """
    import datetime
    now = time.time()
    minutes = int(minutes or cfg.SOUNDING_WINDOW_MIN)
    minutes = max(10, min(minutes, 360))
    levels, used, n_ac = area_profile(db, now - minutes * 60, now,
                                      cfg.RECEIVER_LAT, cfg.RECEIVER_LON,
                                      cfg.SOUNDING_RADIUS_KM, with_aircraft=True)
    return {
        "mode":         "area",
        "window_min":   minutes,
        "radius_km":    cfg.SOUNDING_RADIUS_KM,
        "obs_used":     used,
        "aircraft":     n_ac,                 # distinct aircraft (data-validity indicator)
        "generated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "levels":       levels,
    }


def build_hour_sounding(db: sqlite3.Connection, hour_ts: int) -> dict:
    """Area sounding of one completed UTC hour from the profile_hours archive
    (kept after the observations are purged)."""
    import datetime, json
    row = db.execute("SELECT ts, data FROM profile_hours WHERE ts = ?",
                     (int(hour_ts),)).fetchone()
    if not row:
        return {"error": "no profile stored for this hour"}
    d = json.loads(row["data"])
    return {
        "mode":         "hour",
        "hour_ts":      row["ts"],
        "radius_km":    d.get("r"),
        "obs_used":     d.get("n", 0),
        "aircraft":     d.get("a"),           # distinct aircraft; None for hours stored before it was added
        "generated_at": datetime.datetime.utcfromtimestamp(row["ts"]).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "levels":       unpack_levels(d.get("lv")),
        # METAR surface values of the hour (from 2026-10-11): z DDHHMM, q QNH,
        # tt / td temperature / dewpoint °C, cld lowest cloud group
        "sfc":          d.get("m"),
    }


def list_profile_hours(db: sqlite3.Connection, date: str) -> list:
    """Hours (ts, observations) stored in profile_hours for a UTC date."""
    import calendar
    y, m, d = (int(x) for x in date.split("-"))
    t0 = calendar.timegm((y, m, d, 0, 0, 0))
    rows = db.execute(
        "SELECT ts, json_extract(data, '$.n') AS n FROM profile_hours "
        "WHERE ts >= ? AND ts < ? ORDER BY ts", (t0, t0 + 86400)).fetchall()
    return [{"ts": r["ts"], "n": r["n"]} for r in rows]


# ── ISA helper ────────────────────────────────────────────────────────────────

def _isa_pressure_hpa(alt_ft: float) -> float:
    """Convert altitude (ft) to pressure (hPa) using the ISA standard atmosphere."""
    return isa_pressure_hpa(alt_ft)


# ── Per-flight sounding ───────────────────────────────────────────────────────

def build_flight_sounding(flight_id: int, db: sqlite3.Connection) -> dict:
    """
    Build a Skew-T sounding profile from a single flight's observations.

    Observations are binned into altitude layers (1 000 ft to 10 000 ft,
    2 000 ft above).  Each layer becomes one Skew-T level at the ISA pressure
    of its pressure altitude.  Temperature is the median Mach/TAS temperature
    (collector/atmos.py); wind components are averaged as U/V vectors.

    Works best for climbing / descending flights (departures and arrivals)
    where the aircraft samples multiple altitude layers.  For level cruise
    flights only a single or very few levels will be populated.

    Returns the same dict shape as build_sounding() so the same Skew-T
    (static/js/skewt_chart.js) can display it.
    """
    import datetime

    flight_row = db.execute(
        """SELECT id, icao, callsign,
                  datetime(first_seen, 'unixepoch') AS first_seen,
                  datetime(last_seen,  'unixepoch') AS last_seen,
                  max_altitude, min_altitude, obs_count, meteo_count
           FROM flights WHERE id = ?""",
        (flight_id,),
    ).fetchone()
    if not flight_row:
        return {"error": "flight not found"}

    flight = dict(flight_row)

    rows = db.execute(
        f"""SELECT altitude, best_wind_spd, best_wind_dir,
                   {TEMP_SQL} AS temp
            FROM observations
            WHERE flight_id = ?
              AND altitude IS NOT NULL
              AND meteo_source != 'NONE'
            ORDER BY altitude ASC""",
        (flight_id,),
    ).fetchall()

    # Same layers as the area sounding (1 000 ft to 10 000 ft, then 2 000 ft);
    # temperature = Mach/TAS temperature (median), pressure = ISA pressure
    # of the pressure altitude
    levels = aggregate_layers([(r["altitude"], r["temp"], r["best_wind_spd"],
                                r["best_wind_dir"]) for r in rows])
    obs_used = len(rows)
    for lv in levels:
        lv.setdefault("temp_count", 0)
        lv.setdefault("wind_count", 0)

    # Sort high pressure → low pressure (surface → top) for Skew-T
    levels.sort(key=lambda lv: lv["pressure"], reverse=True)

    return {
        "flight":       flight,
        "obs_used":     obs_used,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "levels":       levels,
        "mode":         "flight",
    }


# ── Time–height cross-section (hourly profile archive) ───────────────────────

def build_time_height(db: sqlite3.Connection, end_ts: float, hours: int,
                      lat: float, lon: float, radius_km: float,
                      now: Optional[float] = None, kin_radius_km: float = 200.0) -> dict:
    """
    Time–height cross-section: the hourly area profiles (profile_hours) of the
    `hours` hours before end_ts, one column per UTC hour.  When the period
    reaches the present, the hour in progress is added from the observations
    (flag "partial").  Each column also carries "kz": the vorticity of the
    hour from kinematics_hours ([[alt_lo, vort, se_vort, aircraft], …],
    10⁻⁵ s⁻¹; computed live for the hour in progress).

    Returns {"layers": [layer bottoms, ft], "end_ts", "hours",
             "cols": [{"ts", "a" aircraft, "n" replies, "q" METAR QNH,
                       "tt" METAR temperature, "partial",
                       "lv": [[alt_lo, temp, temp_n, wind_dir, wind_spd,
                               wind_n, aircraft], …],
                       "kz": [[alt_lo, vort, se_vort, aircraft], …],
                       "dv": [[alt_lo, D m, SD m, airframes], …],
                       "tk": [[lo ft, hi ft, Tv °C, SD K, flights, T Mach/TAS °C], …]}, …],
             "gcal": {"soundings", "pairs", "computed"} of the height calibration}
    D-values and thickness temperatures: collector/gnss_heights.py.
    """
    import json
    from collector.atmos import LAYER_EDGES, pack_levels, PROFILE_KEYS
    now = time.time() if now is None else now
    hours = max(6, min(int(hours), 24 * 14))
    end_hour = int(end_ts // 3600 * 3600)
    start = end_hour - hours * 3600
    idx = {k: i for i, k in enumerate(PROFILE_KEYS)}
    pick = [idx[k] for k in ("alt_lo", "temp", "temp_count", "wind_dir",
                             "wind_spd", "wind_count", "ac_count")]

    def slim(packed):
        out = []
        for row in packed or []:
            r = [row[i] if i < len(row) else None for i in pick]
            if r[1] is not None:
                r[1] = round(r[1], 2)
            if r[3] is not None:
                r[3] = round(r[3])
            if r[4] is not None:
                r[4] = round(r[4], 1)
            out.append(r)
        return out

    cols = []
    for ts, data in db.execute(
            "SELECT ts, data FROM profile_hours WHERE ts >= ? AND ts < ? ORDER BY ts",
            (start, end_hour)):
        try:
            d = json.loads(data)
        except (ValueError, TypeError):
            continue
        m = d.get("m") or {}
        cols.append({"ts": ts, "a": d.get("a"), "n": d.get("n"), "q": m.get("q"),
                     "tt": m.get("tt"), "lv": slim(d.get("lv"))})
    # vorticity per hour (kinematics_hours): [alt_lo, vort, se_vort, aircraft]
    kz = {}
    try:
        for ts, data in db.execute(
                "SELECT ts, data FROM kinematics_hours WHERE ts >= ? AND ts < ?", (start, end_hour)):
            try:
                kz[ts] = [[r[0], r[1], r[3], r[5]] for r in json.loads(data).get("lv", [])]
            except (ValueError, TypeError, IndexError):
                pass
    except sqlite3.Error:
        pass
    for c in cols:
        if c["ts"] in kz:
            c["kz"] = kz[c["ts"]]
    # the hour in progress, live from the observations
    cur = int(now // 3600 * 3600)
    if end_hour >= cur and now - cur >= 300:
        levels, used, n_ac = area_profile(db, cur, now, lat, lon, radius_km, with_aircraft=True)
        if used:
            from collector.kinematics import kinematics_profile
            kin = kinematics_profile(db, cur, now, lat, lon, kin_radius_km)
            cols.append({"ts": cur, "a": n_ac, "n": used, "q": None, "tt": None,
                         "partial": True, "lv": slim(pack_levels(levels)),
                         "kz": [[r[0], r[1], r[3], r[5]] for r in kin]})
    # heights of the pressure surfaces (D-value) and thickness temperatures
    # from the GNSS − baro difference, with the current calibration
    gcal = None
    try:
        from collector import gnss_heights as gh
        cal = gh.current(db)
        raw = gh.cells_for_hours(db, start, end_hour + 3600, lat, lon, radius_km, now=now)
        for c in cols:
            cells = raw.get(c["ts"])
            if not cells:
                continue
            dv, tk = gh.column_products(cells, cal, {r[0]: r[1] for r in c["lv"]}, lat)
            if dv:
                c["dv"] = dv
            if tk:
                c["tk"] = tk
        gcal = {"soundings": cal.get("soundings"), "pairs": cal.get("pairs"), "computed": cal.get("t")}
    except Exception:                                    # noqa: BLE001  (never break the section)
        pass
    return {"layers": LAYER_EDGES, "end_ts": end_hour + (3600 if end_hour >= cur else 0),
            "start_ts": start, "hours": hours, "cols": cols, "gcal": gcal,
            "sondes": sonde_columns(start, end_hour + 3600)}


def sonde_columns(t0: float, t1: float) -> list:
    """The Jokioinen soundings launched in [t0, t1) averaged into the
    time–height layers, for drawing them as their own columns:
    [{"key", "launch", "min_p", "lv": [[alt_lo, T °C, wind dir, wind kt,
    D-value m], …]}, …] — T and wind the mean of the sounding's levels in the
    layer (wind as a vector), D = sonde height of the layer-centre pressure
    surface − its standard-atmosphere height (mean sea level)."""
    import math as _m
    from collector import sondes as _sondes
    from collector.atmos import LAYER_EDGES
    st = _sondes.get()
    if st is None:
        return []
    out = []
    for meta in st.items():
        launch = meta.get("launch") or meta.get("nominal")
        if launch is None or not (t0 <= launch < t1):
            continue
        rec = st.load(meta["key"])
        if not rec:
            continue
        lv = sorted([l for l in rec.get("lv") or [] if l[1] is not None], key=lambda l: l[1])
        rows = []
        for k in range(len(LAYER_EDGES) - 1):
            lo, hi = LAYER_EDGES[k], LAYER_EDGES[k + 1]
            inl = [l for l in lv if lo <= l[1] < hi]
            if not inl:
                continue
            ts_ = [l[3] for l in inl if l[3] is not None]
            u = v = 0.0
            nw = 0
            for l in inl:
                if l[5] is not None and l[6] is not None:
                    r = _m.radians(l[5])
                    u += -l[6] * _m.sin(r)
                    v += -l[6] * _m.cos(r)
                    nw += 1
            wd = ws = None
            if nw:
                u /= nw
                v /= nw
                ws = round(_m.hypot(u, v), 1)
                wd = round(_m.degrees(_m.atan2(-u, -v)) % 360)
            # height of the layer-centre surface, interpolated in pressure altitude
            zc = (lo + hi) / 2
            d = None
            zl = [l for l in lv if l[2] is not None]
            for a, b in zip(zl, zl[1:]):
                if a[1] <= zc <= b[1] and b[1] > a[1]:
                    z = a[2] + (zc - a[1]) / (b[1] - a[1]) * (b[2] - a[2])
                    d = round(z - zc * 0.3048, 1)
                    break
            rows.append([lo, round(sum(ts_) / len(ts_), 2) if ts_ else None, wd, ws, d])
        out.append({"key": meta["key"], "launch": launch, "min_p": meta.get("min_p"), "lv": rows})
    out.sort(key=lambda s: s["launch"])
    return out
