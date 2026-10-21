"""
moisture.py — trial humidity indicator from the aircraft heights (from 2026-10-21).

Aircraft report no humidity, but moist air is lighter than dry air at the
same temperature: a layer of moist air is a little thicker.  The thickness
temperature of a layer from the GNSS heights gained by climbing and
descending aircraft (collector/gnss_heights.py, "tk") is the mean *virtual*
temperature Tv; the Mach / TAS temperature is the real temperature T.  Their
difference is the moisture of the layer:

    Tv − T ≈ 0.608 · q · T          (q specific humidity, kg/kg)

The same principle as the ADS-B study at Amsterdam Schiphol (EGUsphere
preprint 2026-717).  The signal is small — in the Jokioinen soundings of
October 2026, 1 000–5 000 ft: 0.86 K in humid (RH ≥ 70 %) and 0.24 K in dry
(RH < 40 %) air; 5 000–10 000 ft 0.64 / 0.20 K; 10 000–15 000 ft
0.45 / 0.14 K; above that under 0.3 K, so only these three layers are used.
A single flight scatters by about 1 K (5 000–15 000 ft) and 1.8 K
(1 000–5 000 ft, where the altimeter error changes with the flaps and the
speed), so the flights of several hours are averaged.

Indicator
---------
For each hour and layer, the flights of a window around it (±WINDOW_H hours)
give the trimmed mean of Tv − T (each flight with the Mach / TAS temperature
of its own hour).  An offset per layer, learnt against the soundings (below),
is subtracted, and the result is divided by the value saturated air of the
same temperature would give:

    index = (Tv − T − offset) / (0.608 · q_sat(T, p) · T) × 100

— roughly the relative humidity of the layer (%), uncertain by about ±20 %
at 5 000–15 000 ft in daytime traffic.  Shown as dry (< 40), moist (40–70)
and humid (≥ 70).

Offsets
-------
At each Jokioinen sounding of the last CAL_DAYS days the aircraft value of
±SONDE_WINDOW_H hours around the balloon — climbs and descents separately —
is compared with the sonde's own Tv − T of the layer (from its temperature
and dewpoint).  The offset is the mean difference, shrunk towards 0 with
PRIOR_N soundings — so with the first
soundings it stays small and follows the data as it accumulates.  Computed
when asked for, cached until a new sounding arrives (or for CACHE_SEC).

Read only, pure Python.  An experiment: to be tuned with more weather.
"""

from __future__ import annotations

import math
import time as _time

MOIST_LAYERS = [(1000, 5000), (5000, 10000), (10000, 15000)]
WINDOW_H = {1000: 2, 5000: 1, 10000: 1}     # ± hours of flights averaged per layer
MIN_FLIGHTS = {1000: 12, 5000: 6, 10000: 6}
SONDE_WINDOW_H = 2.0
SONDE_MIN_FLIGHTS = 8
CAL_DAYS = 30
PRIOR_N = 3.0                                # offset shrunk towards 0 with this many soundings
CACHE_SEC = 3600
DRY_BELOW, HUMID_FROM = 40.0, 70.0


def _isa_p(ft: float) -> float:
    return 1013.25 * (1 - 6.8756e-6 * ft) ** 5.2559


def _es(tc: float) -> float:
    """Saturation vapour pressure over water (hPa), Bolton."""
    return 6.112 * math.exp(17.67 * tc / (tc + 243.5))


def _q(e: float, p: float) -> float:
    return 0.622 * e / (p - 0.378 * e)


def sat_dtv(lv_temps: dict, lo: float, hi: float):
    """Tv − T (K) of the layer [lo, hi] if it were saturated, from the layer
    temperatures {layer bottom ft: °C} (ln-p weighted), or None."""
    from collector.atmos import LAYER_EDGES
    num = den = 0.0
    for k in range(len(LAYER_EDGES) - 1):
        a, b = LAYER_EDGES[k], LAYER_EDGES[k + 1]
        t = lv_temps.get(a)
        if t is None or b <= lo or a >= hi:
            continue
        x0, x1 = max(a, lo), min(b, hi)
        w = math.log(_isa_p(x0) / _isa_p(x1))
        p = _isa_p((x0 + x1) / 2)
        num += w * 0.608 * _q(_es(t), p) * (t + 273.15)
        den += w
    full = math.log(_isa_p(lo) / _isa_p(hi))
    return num / den if den >= 0.8 * full else None


def flight_values(cells: dict, cal: dict, lv_temps: dict, lat: float) -> dict:
    """{layer bottom: [(Tv − T K, mid time, +1 climb / −1 descent / 0 unknown), …]}
    of the climbs / descents of one hour's raw cells (Tv from the calibrated GNSS
    heights, T the Mach / TAS temperature of the same hour)."""
    from collector import gnss_heights as gh
    out: dict = {}
    want = dict(MOIST_LAYERS)
    for r in cells.get("tk") or []:
        lo_ft, hi_ft, icao, z1, z2, mid = r[:6]
        dr = r[6] if len(r) > 6 else 0
        if want.get(lo_ft) != hi_ft:
            continue
        tref = gh._layer_temp_k(lv_temps, lo_ft, hi_ft)
        if tref is None:
            continue
        z1c = z1 - gh.correction(cal, lo_ft, icao)
        z2c = z2 - gh.correction(cal, hi_ft, icao)
        dH = gh.geopotential(z2c, lat) - gh.geopotential(z1c, lat)
        tv = gh.G0 * dH / (gh.R_D * math.log(gh.isa_pressure(lo_ft) / gh.isa_pressure(hi_ft)))
        out.setdefault(lo_ft, []).append((tv - tref, mid, dr))
    return out


def trimmed(v: list):
    """(mean with the highest and lowest 10 % left out, SD, n) or None."""
    n = len(v)
    if n == 0:
        return None
    s = sorted(v)
    k = int(n * 0.1) if n >= 10 else 0
    core = s[k:n - k] if k else s
    m = sum(core) / len(core)
    sd = math.sqrt(sum((x - m) ** 2 for x in v) / (n - 1)) if n > 1 else None
    return m, sd, n


def sonde_layers(rec: dict) -> dict:
    """{layer bottom: (Tv − T K, mean RH %, sat Tv − T K)} of a sounding, from
    its temperature and dewpoint (ln-p weighted; layers with too few levels
    are left out)."""
    out = {}
    lv = [l for l in rec.get("lv") or []
          if l[0] is not None and l[1] is not None and l[3] is not None and l[4] is not None]
    for lo, hi in MOIST_LAYERS:
        pts = sorted([l for l in lv if lo <= l[1] <= hi], key=lambda l: -l[0])
        if len(pts) < 5:
            continue
        num = den = rh = sat = 0.0
        for a, b in zip(pts, pts[1:]):
            w = math.log(a[0] / b[0])
            if w <= 0:
                continue
            for l in (a, b):
                p, t, td = l[0], l[3], l[4]
                e, es = _es(td), _es(t)
                num += w / 2 * 0.608 * _q(e, p) * (t + 273.15)
                sat += w / 2 * 0.608 * _q(es, p) * (t + 273.15)
                rh += w / 2 * 100 * e / es
                den += w / 2
        if den < 0.8 * math.log(_isa_p(lo) / _isa_p(hi)):
            continue
        out[lo] = (num / den, rh / den, sat / den)
    return out


def classify(idx):
    if idx is None:
        return None
    return "dry" if idx < DRY_BELOW else "humid" if idx >= HUMID_FROM else "moist"


# ── offsets against the soundings ───────────────────────────────────────────

_cache: dict = {"key": None, "t": 0.0, "val": None}


def offsets(db, cal: dict, lat: float, lon: float, radius_km: float,
            now: float | None = None) -> dict:
    """{layer bottom: {"climb": K, "descent": K, "off": their mean, "n": soundings,
    "n_climb", "n_descent", "pairs": [[key, ±1, acft − sonde K, flights], …]}}
    from the soundings of the last CAL_DAYS days (cached).  Climbs and
    descents have their own offsets: below 5 000 ft descents read about
    0.6 K higher (the altimeter error changes with the speed and flaps)."""
    from collector import sondes as _sondes
    from collector import gnss_heights as gh
    import json
    now = _time.time() if now is None else now
    st = _sondes.get()
    items = st.items() if st is not None else []
    key = (items[0]["key"] if items else None, cal.get("t"))
    if _cache["val"] is not None and _cache["key"] == key and now - _cache["t"] < CACHE_SEC:
        return _cache["val"]
    pairs: dict = {lo: [] for lo, _ in MOIST_LAYERS}
    for meta in items:
        launch = meta.get("launch") or meta.get("nominal")
        if launch is None or launch < now - CAL_DAYS * 86400 or launch > now:
            continue
        t_mid = launch + 900                       # the balloon passes 1 000–15 000 ft in ~5–25 min
        h0 = int((t_mid - SONDE_WINDOW_H * 3600) // 3600 * 3600)
        h1 = int((t_mid + SONDE_WINDOW_H * 3600) // 3600 * 3600) + 3600
        if h1 > now - 3600:                        # wait until the hours after the launch have flown
            continue
        rec = st.load(meta["key"])
        if not rec:
            continue
        sl = sonde_layers(rec)
        if not sl:
            continue
        raw = gh.cells_for_hours(db, h0, h1, lat, lon, radius_km, now=now)
        if not raw:
            continue
        prof = {}
        for ts, data in db.execute("SELECT ts, data FROM profile_hours WHERE ts >= ? AND ts < ?", (h0, h1)):
            try:
                prof[ts] = {r[0]: r[1] for r in json.loads(data).get("lv") or [] if r[1] is not None}
            except (ValueError, TypeError, IndexError):
                pass
        vals: dict = {}
        for h, cells in raw.items():
            if h not in prof:
                continue
            for lo, v in flight_values(cells, cal, prof[h], lat).items():
                for x, t, dr in v:
                    if abs(t - t_mid) <= SONDE_WINDOW_H * 3600 and dr:
                        vals.setdefault((lo, dr), []).append(x)
        for (lo, dr), v in vals.items():
            s = sl.get(lo)
            tm = trimmed(v)
            if s is None or tm is None or tm[2] < SONDE_MIN_FLIGHTS:
                continue
            pairs[lo].append([meta["key"], dr, round(tm[0] - s[0], 3), tm[2]])
    out = {}
    for lo, p in pairs.items():
        o = {"pairs": p}
        for dr, name in ((1, "climb"), (-1, "descent")):
            d = [x[2] for x in p if x[1] == dr]
            o[name] = round(sum(d) / (len(d) + PRIOR_N), 3) if d else 0.0
            o["n_" + name] = len(d)
        o["off"] = round((o["climb"] + o["descent"]) / 2, 3)
        o["n"] = len({x[0] for x in p})
        out[lo] = o
    _cache.update(key=key, t=now, val=out)
    return out


# ── the indicator per hour ──────────────────────────────────────────────────

def columns(raw: dict, prof: dict, cal: dict, offs: dict, lat: float, hours: list) -> dict:
    """{hour: [[lo, hi, index %, ± %, flights, Tv − T corrected K, raw K], …]} for
    the given hours.  raw: {hour: gnss_hours cells}, prof: {hour: {layer bottom:
    °C}} — both should reach WINDOW_H hours beyond the shown hours."""
    per_hour: dict = {}
    for h, cells in raw.items():
        lv = prof.get(h)
        if lv:
            per_hour[h] = flight_values(cells, cal, lv, lat)

    def off_of(lo, dr):
        o = offs.get(lo) or {}
        return o.get("climb" if dr > 0 else "descent" if dr < 0 else "off", 0.0)
    out = {}
    for h in hours:
        lv = prof.get(h)
        if not lv:
            continue
        rows = []
        for lo, hi in MOIST_LAYERS:
            k = WINDOW_H[lo]
            fl = [f for dh in range(-k, k + 1) for f in (per_hour.get(h + dh * 3600) or {}).get(lo, [])]
            tm = trimmed([x - off_of(lo, dr) for x, _, dr in fl])
            raw_m = trimmed([x for x, _, _ in fl])
            sat = sat_dtv(lv, lo, hi)
            if tm is None or tm[2] < MIN_FLIGHTS[lo] or not sat or sat < 0.05:
                continue
            se = (tm[1] / math.sqrt(tm[2])) if tm[1] is not None else None
            rows.append([lo, hi, round(100 * tm[0] / sat), round(100 * se / sat) if se is not None else None,
                         tm[2], round(tm[0], 2), round(raw_m[0], 2)])
        if rows:
            out[h] = rows
    return out


def sonde_index(rec: dict) -> list:
    """[[lo, hi, index %, mean RH %], …] of a sounding: its own Tv − T over the
    saturated value (the same quantity as the aircraft index) and its mean RH."""
    out = []
    for lo, (dtv, rh, sat) in sorted(sonde_layers(rec).items()):
        hi = dict(MOIST_LAYERS)[lo]
        out.append([lo, hi, round(100 * dtv / sat) if sat > 0.05 else None, round(rh)])
    return out
