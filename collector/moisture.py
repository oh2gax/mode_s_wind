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

— roughly the relative humidity of the layer (%).  Its ± combines the
scatter of the flights (± their SD / √n) with a systematic part SYS_K that
does not average out: the first comparison with four soundings (22 Oct 2026)
gave aircraft − sonde differences of Tv − T that changed by 0.2–0.45 K from
one sounding to the next (part of it the 95 km between Helsinki and
Jokioinen), an RMS of about 37 % in the index and no gain from the learnt
offsets yet.  With it the index is uncertain by about ±30–35 % at
1 000–10 000 ft and ±50 % at 10 000–15 000 ft in daytime traffic — a
tendency, not a measurement.  Shown as dry (< 40), moist (40–70) and humid
(≥ 70), faint where the ± exceeds UNCERTAIN_PCT.

Offsets
-------
At each Jokioinen sounding of the last CAL_DAYS days the aircraft value of
±SONDE_WINDOW_H hours around the balloon — climbs and descents separately —
is compared with the sonde's own Tv − T of the layer (from its temperature
and dewpoint).  The offset is the mean difference, shrunk towards 0 with
PRIOR_N soundings — so with the first
soundings it stays small and follows the data as it accumulates.  Computed
when asked for, cached until a new sounding arrives (or for CACHE_SEC).

From 24 Oct 2026 the offsets are also learnt from the MEPS weather model
(collector/meps.py, model levels, the same 150 km area): every hour of the
last MEPS_CAL_DAYS days with at least MEPS_MIN_FLIGHTS climbs (or descents)
in a layer gives a pair aircraft − model Tv − T (the model's from its
temperature and specific humidity, ln-p weighted), many more than the 2–3
soundings a day, also at night.  Where a layer and direction has at least
MEPS_MIN_HOURS such hours the MEPS offset (shrunk with MEPS_PRIOR_H hours) is
used, otherwise the sonde offset — so without the model (USE_MEPS False, or
no model data) the indicator works as before on the soundings alone.  A
leave-one-day-out test on the front of 23–24 Oct 2026 (8 soundings per
layer): the bias against the sondes went from +11 / +1 / +13 to +0 / +2 / −6
points (1–5k / 5–10k / 10–15k ft); the scatter (RMS 30 / 50 / 63) is not
changed by any offset — that is the noise of the method itself.

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
USE_MEPS = True                 # offsets also from the MEPS model (config MOIST_MEPS_OFFSETS)
MEPS_CAL_DAYS = 14
MEPS_MIN_FLIGHTS = 4            # climbs or descents in the layer within the hour
MEPS_MIN_HOURS = 12             # hours needed before the MEPS offset replaces the sonde offset
MEPS_PRIOR_H = 6.0              # MEPS offset shrunk towards 0 with this many hours
DRY_BELOW, HUMID_FROM = 40.0, 70.0
SYS_K = 0.3                     # systematic uncertainty of Tv − T (K), added in quadrature
UNCERTAIN_PCT = 40              # index ± above this: drawn faint


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
    newest_ml = None
    if USE_MEPS:
        try:
            newest_ml = db.execute("SELECT MAX(ts) FROM meps_ml_hours").fetchone()[0]
        except Exception:                                # noqa: BLE001  (no model table)
            newest_ml = None
    key = (items[0]["key"] if items else None, cal.get("t"), newest_ml)
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
    mp = _meps_pairs(db, cal, lat, lon, radius_km, now) if newest_ml else {}
    out = {}
    for lo, p in pairs.items():
        o = {"pairs": p}
        src = set()
        for dr, name in ((1, "climb"), (-1, "descent")):
            d = [x[2] for x in p if x[1] == dr]
            o["sonde_" + name] = round(sum(d) / (len(d) + PRIOR_N), 3) if d else 0.0
            o["n_" + name] = len(d)
            m = [x for _, x in mp.get((lo, dr), [])]
            o["n_meps_" + name] = len(m)
            if len(m) >= MEPS_MIN_HOURS:
                o["meps_" + name] = round(sum(m) / (len(m) + MEPS_PRIOR_H), 3)
                o[name] = o["meps_" + name]
                src.add("meps")
            else:
                o[name] = o["sonde_" + name]
                src.add("sondes" if d else "none")
        o["off"] = round((o["climb"] + o["descent"]) / 2, 3)
        o["n"] = len({x[0] for x in p})
        o["src"] = "meps" if src == {"meps"} else "meps+sondes" if "meps" in src else \
            "sondes" if "sondes" in src else "none"
        o["n_meps"] = min(o["n_meps_climb"], o["n_meps_descent"])
        out[lo] = o
    _cache.update(key=key, t=now, val=out)
    return out


def meps_layer_dtv(col: dict) -> dict:
    """{layer bottom: Tv − T K} of a MEPS model column {"p": hPa, "t": °C,
    "q": g/kg per level} (ln-p weighted, as sonde_layers)."""
    p, t, q = col.get("p") or [], col.get("t") or [], col.get("q") or []
    pts = sorted([(p[i], t[i], q[i]) for i in range(min(len(p), len(t), len(q)))
                  if p[i] is not None and t[i] is not None and q[i] is not None], key=lambda x: -x[0])
    out = {}
    for lo, hi in MOIST_LAYERS:
        plo, phi = _isa_p(lo), _isa_p(hi)
        num = den = 0.0
        for a, b in zip(pts, pts[1:]):
            pa, pb = min(a[0], plo), max(b[0], phi)
            if pa <= pb:
                continue
            w = math.log(pa / pb)
            for _, tt, qq in (a, b):
                num += w / 2 * 0.608 * (qq / 1000.0) * (tt + 273.15)
                den += w / 2
        if den >= 0.8 * math.log(plo / phi):
            out[lo] = num / den
    return out


def _meps_pairs(db, cal: dict, lat: float, lon: float, radius_km: float, now: float) -> dict:
    """{(layer bottom, ±1): [(hour, aircraft − MEPS Tv − T K), …]} of the last
    MEPS_CAL_DAYS days: each hour's climbs (descents) of a layer, at least
    MEPS_MIN_FLIGHTS of them, against the MEPS area column of that hour."""
    import json
    from collector import gnss_heights as gh
    from collector import meps
    t1 = int(now // 3600 * 3600)
    t0 = t1 - int(MEPS_CAL_DAYS * 86400)
    try:
        ml = meps.hours(db, t0, t1 + 3600, kind="ml")
    except Exception:                                    # noqa: BLE001
        return {}
    if not ml:
        return {}
    raw = gh.cells_for_hours(db, t0, t1, lat, lon, radius_km, now=now)
    prof = {}
    for ts, data in db.execute("SELECT ts, data FROM profile_hours WHERE ts >= ? AND ts < ?", (t0, t1)):
        try:
            prof[ts] = {r[0]: r[1] for r in json.loads(data).get("lv") or [] if r[1] is not None}
        except (ValueError, TypeError, IndexError):
            pass
    out: dict = {}
    for h, cells in raw.items():
        col = meps._hour_mean(ml, h)                      # the model over the hour [h, h + 1 h)
        if h not in prof or not col:
            continue
        md = meps_layer_dtv(col)
        for lo, v in flight_values(cells, cal, prof[h], lat).items():
            if lo not in md:
                continue
            for dr in (1, -1):
                tm = trimmed([x for x, _, d in v if d == dr])
                if tm and tm[2] >= MEPS_MIN_FLIGHTS:
                    out.setdefault((lo, dr), []).append((h, tm[0] - md[lo]))
    return out


# ── the indicator per hour ──────────────────────────────────────────────────

def columns(raw: dict, prof: dict, cal: dict, offs: dict, lat: float, hours: list) -> dict:
    """{hour: [[lo, hi, index %, ± % (total), flights, Tv − T corrected K, raw K,
    ± % from the flights' scatter alone], …]} for
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
            se_r = (tm[1] / math.sqrt(tm[2])) if tm[1] is not None else None
            se = math.hypot(se_r if se_r is not None else 0.0, SYS_K)
            rows.append([lo, hi, round(100 * tm[0] / sat), round(100 * se / sat),
                         tm[2], round(tm[0], 2), round(raw_m[0], 2),
                         round(100 * se_r / sat) if se_r is not None else None])
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


def _src_of(offs: dict) -> str:
    """Overall source of the offsets: "meps", "meps+sondes", "sondes" or "none"."""
    s = {o.get("src") for o in offs.values()}
    if s == {"meps"}:
        return "meps"
    if any(x and "meps" in x for x in s):
        return "meps+sondes"
    return "sondes" if "sondes" in s else "none"


def for_hour(db, h: int, lat: float, lon: float, radius_km: float,
             live_levels: list | None = None, now: float | None = None) -> dict:
    """The indicator of one hour for the Skew-T (Area · hour, or Area · now
    with h = the hour in progress and live_levels its area profile):
    {"hour", "rows": [[lo, hi, index %, ± % (total), flights, Tv − T corrected K, raw K,
     ± % from the flights], …], "window_h": {layer bottom: ± hours}, "offsets_n": soundings,
     "uncertain_pct": the ± above which it is drawn faint}."""
    import json
    from collector import gnss_heights as gh
    now = _time.time() if now is None else now
    h = int(h // 3600 * 3600)
    k = max(WINDOW_H.values())
    cal = gh.current(db)
    raw = gh.cells_for_hours(db, h - k * 3600, h + (k + 1) * 3600, lat, lon, radius_km, now=now)
    prof = {}
    for ts, data in db.execute("SELECT ts, data FROM profile_hours WHERE ts >= ? AND ts < ?",
                               (h - k * 3600, h + (k + 1) * 3600)):
        try:
            prof[ts] = {r[0]: r[1] for r in json.loads(data).get("lv") or [] if r[1] is not None}
        except (ValueError, TypeError, IndexError):
            pass
    if live_levels:
        prof.setdefault(h, {lv["alt_lo"]: lv["temp"] for lv in live_levels
                            if lv.get("temp") is not None and lv.get("alt_lo") is not None})
    offs = offsets(db, cal, lat, lon, radius_km, now=now)
    rows = columns(raw, prof, cal, offs, lat, [h]).get(h, [])
    return {"hour": h, "rows": rows, "window_h": {str(lo): w for lo, w in WINDOW_H.items()},
            "offsets_n": max((o.get("n", 0) for o in offs.values()), default=0),
            "offsets_meps_h": max((o.get("n_meps", 0) for o in offs.values()), default=0),
            "offsets_src": _src_of(offs),
            "uncertain_pct": UNCERTAIN_PCT}
