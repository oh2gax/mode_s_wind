"""
collector/departures.py — climb-out profiles of departing aircraft (from 2026-10-11)

The approach capture (collector/windshear.py) builds a temperature / wind
profile per 200 ft band on final from every raw BDS 5,0 / 6,0 reply.  This
module does the same for departures, so that the airport low-level profile
(/api/lowlevel, Live Map Skew-T) has data from both sides of the airport and
at times with few arrivals (e.g. the early-morning departure wave, when the
night-time surface inversion is strongest).

Detection (every windshear sweep, ~3 s, from live_state):
  start  — within DEP_START_NM of the airport, at most DEP_START_MAX_FT MSL,
           climbing ≥ DEP_MIN_VR fpm, ground speed ≥ DEP_MIN_GS kt;
  record — every raw BDS 6,0 reply since the previous sweep is paired with the
           nearest BDS 5,0 reply (≤ 2 s).  The altitude at the reply time is
           interpolated between the two sweeps (a jet climbing at 3 000 fpm
           moves 150 ft in 3 s), and the reply is assigned to the 200 ft band
           within ±100 ft.  Mach/TAS temperature always; wind only when the
           bank is ≤ 5° (departures turn early) and with the per-airframe
           heading calibration (hdg_off) applied;
  end    — above DEP_TOP_FT + 300 ft, farther than DEP_MAX_NM, descending, or
           not updated for 60 s.  A record with at least 3 bands with
           temperature or wind is committed (one INSERT into
           departure_profiles; turboprops report no Mach, so their climbs
           give winds only).

Compared with approaches, a departure gives fewer replies per band (it climbs
4–5× faster than the 700–800 fpm of a 3° glide path) and turns earlier, so
fewer wind pairs pass the bank gate; the temperature is unaffected by turns.
A go-around climbing out of the approach is flagged ("ga") and kept.
"""

from __future__ import annotations

import logging
import math
import threading
import time

from collector.atmos import tm_temp_c, trimmed_mean
from collector.wind_calc import compute_wind

log = logging.getLogger("modes.departures")

DEP_BANDS        = tuple(range(200, 3001, 200))   # ft MSL, as the approach profile
DEP_BAND_TOL     = 100.0
DEP_START_NM     = 6.0
DEP_START_MAX_FT = 1500.0
DEP_MIN_VR       = 300.0       # fpm
DEP_MIN_GS       = 90.0        # kt
DEP_TOP_FT       = 3000.0
DEP_MAX_NM       = 25.0
DEP_STALE_SEC    = 60.0
DEP_MIN_BANDS    = 3
PAIR_SEC         = 2.0
MAX_ROLL         = 5.0


def _dist_nm(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 3440.065 * math.asin(math.sqrt(a))


def prof_summary(prof: dict) -> dict | None:
    """{band: {"u": [], "v": [], "t": []}} → the approach prof_json format."""
    out = {}
    for band, P in prof.items():
        d = {}
        n = len(P["u"])
        if n:
            um, vm = sum(P["u"]) / n, sum(P["v"]) / n
            d["n"] = n
            d["ws"] = round(math.hypot(um, vm), 1)
            d["wd"] = int(round((math.degrees(math.atan2(-um, -vm)) + 360) % 360)) % 360
            d["sd"] = round(math.sqrt(sum((u - um) ** 2 + (v - vm) ** 2
                                          for u, v in zip(P["u"], P["v"])) / n), 1)
        if P["t"]:
            d["t"] = round(trimmed_mean(P["t"]), 1)
            d["tn"] = len(P["t"])
        if d:
            out[str(band)] = d
    return out or None


class DepartureTracker:
    def __init__(self, airport_lat: float, airport_lon: float, bds_sample_fn,
                 qnh_fn, on_commit=None, approach_state_fn=None,
                 mag_declination: float | None = None) -> None:
        """qnh_fn() → (qnh_hpa or None, pressure-alt − MSL correction ft);
        approach_state_fn(icao) → True if the windshear tracker is following
        the aircraft on an approach (go-around flag)."""
        self.apt_lat, self.apt_lon = airport_lat, airport_lon
        self._bds = bds_sample_fn
        self._qnh = qnh_fn
        self._on_commit = on_commit
        self._on_app = approach_state_fn
        self._decl = mag_declination
        self._state: dict[str, dict] = {}
        self._lock = threading.Lock()
        self.n_committed = 0

    # ── per sweep ─────────────────────────────────────────────────────────
    def update(self, ac: dict, now: float | None = None) -> None:
        icao, alt = ac.get("icao"), ac.get("altitude")
        lat, lon = ac.get("lat"), ac.get("lon")
        if not icao or alt is None or lat is None or lon is None:
            return
        now = now or time.time()
        qnh, corr = self._qnh()
        alt_msl = float(alt) - corr
        dist = _dist_nm(self.apt_lat, self.apt_lon, lat, lon)
        vr = ac.get("vert_rate")
        st = self._state.get(icao)
        if st is None:
            gs = ac.get("groundspeed")
            if (dist <= DEP_START_NM and alt_msl <= DEP_START_MAX_FT
                    and vr is not None and vr >= DEP_MIN_VR
                    and gs is not None and gs >= DEP_MIN_GS):
                st = self._state[icao] = {
                    "t0": now, "since": now - 4.0, "prev_t": now - 3.0, "prev_alt": alt_msl,
                    "last": now, "prof": {}, "qnh": qnh,
                    "track": ac.get("track"), "lat": lat, "lon": lon,
                    "ga": bool(self._on_app and self._on_app(icao)),
                }
            else:
                return
        self._collect(icao, ac, st, now, alt_msl)
        st["last"] = now
        for k in ("callsign", "registration", "aircraft_type"):
            if ac.get(k):
                st[k] = ac[k]
        if (alt_msl > DEP_TOP_FT + 300 or dist > DEP_MAX_NM
                or (vr is not None and vr < -500)):
            self._finish(icao, ac, now)

    def prune(self, now: float | None = None) -> None:
        now = now or time.time()
        for icao in [k for k, s in self._state.items() if now - s["last"] > DEP_STALE_SEC]:
            self._finish(icao, None, now)

    # ── internals ─────────────────────────────────────────────────────────
    def _collect(self, icao, ac, st, now, alt_msl):
        b50, b60 = self._bds(icao, st["since"] - PAIR_SEC)
        t_prev, a_prev = st["prev_t"], st["prev_alt"]
        st["prev_t"], st["prev_alt"] = now, alt_msl

        def alt_at(t):
            if now <= t_prev:
                return alt_msl
            f = min(1.0, max(0.0, (t - t_prev) / (now - t_prev)))
            return a_prev + f * (alt_msl - a_prev)

        decl = ac.get("mag_decl")
        if decl is None:
            decl = self._decl
        hsrc = ac.get("hdg_src")
        hoff = (ac.get("hdg_off") or 0.0) if hsrc in ("A", "T", "F", "D") else 0.0
        excluded = hsrc == "X"
        gs = ac.get("groundspeed")
        since = st["since"]
        for smp in b60:
            ts, _ias, mhdg = smp[0], smp[1], smp[2]
            mach = smp[5] if len(smp) > 5 else None
            if ts <= since:
                continue
            if not b50:
                break
            p5 = min(b50, key=lambda x: abs(x[0] - ts))
            t5, roll5, _trate, ttrk5, bgs5, tas5 = p5
            if abs(t5 - ts) > PAIR_SEC or tas5 is None:
                continue
            if bgs5 is not None and gs is not None and abs(bgs5 - gs) > 50:
                continue
            a = alt_at(ts)
            band = int(round(a / 200.0) * 200)
            if band not in DEP_BANDS or abs(a - band) > DEP_BAND_TOL:
                continue
            P = st["prof"].setdefault(band, {"u": [], "v": [], "t": []})
            tm = tm_temp_c(tas5, mach)
            if tm is not None:
                P["t"].append(tm)
            if (not excluded and mhdg is not None and decl is not None and ttrk5 is not None
                    and bgs5 is not None and roll5 is not None and abs(roll5) <= MAX_ROLL):
                wspd, wdir = compute_wind(float(ttrk5), float(bgs5),
                                          (mhdg + decl - hoff) % 360.0, float(tas5))
                rd = math.radians(wdir)
                P["u"].append(-wspd * math.sin(rd))
                P["v"].append(-wspd * math.cos(rd))
        st["since"] = max(since, now)

    def _finish(self, icao, ac, now):
        st = self._state.pop(icao, None)
        if not st:
            return
        # bands with a temperature or a wind (turboprops report no Mach, so
        # their climbs give winds only — kept, as on the approach profiles)
        n_b = sum(1 for P in st["prof"].values() if P["t"] or P["u"])
        if n_b < DEP_MIN_BANDS:
            return
        prof = prof_summary(st["prof"])
        rec = {"ts": now, "t_start": st["t0"], "icao": icao,
               "callsign": st.get("callsign"), "registration": st.get("registration"),
               "aircraft_type": st.get("aircraft_type"), "qnh_hpa": st["qnh"],
               "track": st["track"], "lat": st["lat"], "lon": st["lon"],
               "ga": st["ga"], "prof": prof}
        self.n_committed += 1
        if self._on_commit:
            try:
                self._on_commit(rec)
            except Exception as exc:
                log.warning("Departure profile commit failed: %s", exc)

    def active(self) -> int:
        return len(self._state)
