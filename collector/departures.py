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
  end    — above DEP_SERIES_TOP_FT + 300 ft (5 300 ft MSL; until 29 Oct 2026
           DEP_TOP_FT + 300 = 3 300 ft), farther than DEP_MAX_NM, descending,
           or not updated for 60 s.  The band comparison and the trial ramps
           still end at DEP_TOP_FT + 300 ft (the final windshear report is made
           there, as before; the band comparison itself only uses the bands up
           to shear.BAND_MAX_FT, 1 800 ft); above it the raw series grows, for
           the turbulence (EDR) of the climb (collector/edr.py uses 200–5 000 ft
           for departures), and — from 30 Oct 2026 — the 200 ft bands too, up
           to 5 000 ft (DEP_BANDS; until then 3 000 ft): the boundary-layer
           temperature (collector/boundary.py via web/api/lowlevel.py) and the
           airport profile reach 5 000 ft from the climb-outs.  A record with at least 3 bands with
           temperature or wind is committed (one INSERT into
           departure_profiles; turboprops report no Mach, so their climbs
           give winds only).

Compared with approaches, a departure gives fewer replies per band (it climbs
4–5× faster than the 700–800 fpm of a 3° glide path) and turns earlier, so
fewer wind pairs pass the bank gate; the temperature is unaffected by turns.
A go-around climbing out of the approach is flagged ("ga") and kept: the
aircraft was established on an approach (descending in an ILS corridor) in
the windshear tracker when its climb began.

Windshear band comparison (from 2026-10-24): after each sweep with new wind
pairs and once more at the end, the climb-out's band winds are handed to
shear_fn (WindshearTracker.dep_shear) and compared with all landings and
departures of the previous 45 minutes as the headwind along its runway
direction; the result is stored with the profile (shear_json).

Raw climb-out series and trial ramps (from 2026-10-27): every BDS 5,0 and 6,0
reply of the climb (with the height interpolated to its time), the ADS-B
airborne velocity messages (TC 19) and one row per sweep (height, distance
from the airport, position) are kept and stored in departure_series in the
format of approach_series (WindshearTracker._series_blob; "sw" column dthr =
distance from the airport reference point, NM).  The headwind-ramp analysis of
the landings (collector/shear.analyze) is run on it at the end of the climb as
a TRIAL: the result goes into the report as "trial" and raises no alert, until
enough climb-outs have been checked (acceleration and the few replies of a
fast climb are the open questions).
"""


from __future__ import annotations

import logging
import math
import threading
import time

from collector.atmos import tm_temp_c, trimmed_mean
from collector.wind_calc import compute_wind

log = logging.getLogger("modes.departures")

DEP_BANDS        = tuple(range(200, 5001, 200))   # ft MSL (to 3 000 ft, as the approach profile, until 30 Oct 2026)
DEP_BAND_TOL     = 100.0
DEP_START_NM     = 6.0
DEP_START_MAX_FT = 1500.0
DEP_MIN_VR       = 300.0       # fpm
DEP_MIN_GS       = 90.0        # kt
DEP_TOP_FT       = 3000.0      # bands, band comparison, trial ramps
DEP_SERIES_TOP_FT = 5000.0     # raw climb-out series (EDR), from 2026-10-29
DEP_MAX_NM       = 25.0
DEP_STALE_SEC    = 60.0
DEP_MIN_BANDS    = 3
PAIR_SEC         = 2.0
MAX_ROLL         = 5.0
SERIES_MAX_ROWS  = 600         # per list per climb-out (≈ 10 min at 1 reply/s)
DEP_MARK_SEC     = 900.0       # a finished climb-out stays marked as a departure for the maps (2026-10-29)


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


HIBAND_KEY = "dep_hiband_backfill"   # maintenance_config: the one-time back-fill below is done


def backfill_high_bands(db, pause_sec: float = 0.2) -> tuple[int, set]:
    """One-time back-fill (from 30 Oct 2026, when DEP_BANDS went from 3 000
    to 5 000 ft): the temperatures of the bands above DEP_TOP_FT of the stored
    departures whose raw climb series (departure_series, up to 5 000 ft since
    29 Oct 2026) reaches them, computed as the live capture does — every BDS 6,0
    reply paired with the nearest BDS 5,0 reply (≤ PAIR_SEC), Mach/TAS
    temperature, the 200 ft band within ±DEP_BAND_TOL, trimmed mean — and
    added to prof_json ("t", "tn"; no winds: they need the heading calibration
    of that moment, and the boundary-layer wind comes from the observations).
    Profiles that already have a band above DEP_TOP_FT are left as they are.
    Marks itself done in maintenance_config, so it runs once.  Returns
    (profiles updated, the hour starts whose boundary layer to recompute)."""
    import bisect
    import json
    try:
        if db.execute("SELECT value FROM maintenance_config WHERE key = ?", (HIBAND_KEY,)).fetchone():
            return 0, set()
    except Exception:                                     # noqa: BLE001  (older database)
        return 0, set()
    from collector.windshear import WindshearTracker
    hi = [b for b in DEP_BANDS if b > DEP_TOP_FT]
    todo = db.execute(
        "SELECT p.id, p.ts, p.icao, p.prof_json FROM departure_profiles p "
        "WHERE EXISTS (SELECT 1 FROM departure_series s WHERE s.ts = p.ts AND s.icao = p.icao) "
        "ORDER BY p.ts").fetchall()
    n, hours = 0, set()
    for rid, ts, icao, pj in todo:
        try:
            prof = json.loads(pj) if pj else {}
        except (TypeError, ValueError):
            continue
        if any(int(b) > DEP_TOP_FT for b in prof if str(b).isdigit()):
            continue
        row = db.execute("SELECT data FROM departure_series WHERE ts = ? AND icao = ?", (ts, icao)).fetchone()
        try:
            d = WindshearTracker.decode_series(row[0]) if row else None
        except Exception:                                 # noqa: BLE001
            d = None
        if not d:
            continue
        b5, b6 = d.get("b50") or {}, d.get("b60") or {}
        p5 = sorted((t, tas) for t, tas in zip(b5.get("t") or [], b5.get("tas") or [])
                    if t is not None and tas is not None)
        tl = [p[0] for p in p5]
        temps: dict[int, list] = {}
        for t, m, a in zip(b6.get("t") or [], b6.get("mach") or [], b6.get("alt") or []):
            if t is None or m is None or a is None or not p5 or a < DEP_TOP_FT:
                continue
            k = bisect.bisect_left(tl, t)
            q = min((p5[j] for j in (k - 1, k) if 0 <= j < len(p5)), key=lambda p: abs(p[0] - t))
            if abs(q[0] - t) > PAIR_SEC:
                continue
            band = int(round(a / 200.0) * 200)
            if band not in hi or abs(a - band) > DEP_BAND_TOL:
                continue
            tm = tm_temp_c(q[1], m)
            if tm is not None:
                temps.setdefault(band, []).append(tm)
        if not temps:
            continue
        for band, v in temps.items():
            prof[str(band)] = {"t": round(trimmed_mean(v), 1), "tn": len(v)}
        db.execute("UPDATE departure_profiles SET prof_json = ? WHERE id = ?",
                   (json.dumps(prof, separators=(",", ":")), rid))
        n += 1
        hours.add(int((ts - 1e-6) // 3600 * 3600))     # the hour whose airport profile window ends after it
        if n % 25 == 0:
            db.commit()
            if pause_sec:
                time.sleep(pause_sec)
    db.execute("INSERT OR REPLACE INTO maintenance_config (key, value) VALUES (?, ?)", (HIBAND_KEY, "1"))
    db.commit()
    return n, hours


class DepartureTracker:
    def __init__(self, airport_lat: float, airport_lon: float, bds_sample_fn,
                 qnh_fn, on_commit=None, approach_state_fn=None,
                 mag_declination: float | None = None, shear_fn=None,
                 vel_sample_fn=None) -> None:
        """qnh_fn() → (qnh_hpa or None, pressure-alt − MSL correction ft);
        approach_state_fn(icao) → True if the windshear tracker is following
        the aircraft on an approach (go-around flag);
        shear_fn(icao, state, now, final) → windshear band comparison of the
        climb (WindshearTracker.dep_shear; returns the report when final)."""
        self.apt_lat, self.apt_lon = airport_lat, airport_lon
        self._bds = bds_sample_fn
        self._qnh = qnh_fn
        self._on_commit = on_commit
        self._on_app = approach_state_fn
        self._decl = mag_declination
        self._shear = shear_fn
        # optional callable(icao, since_ts) → ADS-B ground-speed samples (series "v19")
        self._vel = vel_sample_fn
        self._state: dict[str, dict] = {}
        self._recent: dict[str, tuple] = {}     # icao → (until, runway) of finished climb-outs
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
                    "raw5": [], "raw6": [], "raw19": [], "sw": [],
                }
            else:
                return
        n_w = sum(len(P["u"]) for P in st["prof"].values())
        self._collect(icao, ac, st, now, alt_msl)
        if len(st["sw"]) < SERIES_MAX_ROWS:                # sweep row of the series
            def _f(v, nd):
                return None if v is None else round(v, nd)
            st["sw"].append([round(now, 1), int(round(alt_msl)), alt, round(dist, 2), None,
                             _f(lat, 5), _f(lon, 5), ac.get("groundspeed"), _f(ac.get("track"), 1),
                             None, None])
        st["last"] = now
        for k in ("callsign", "registration", "aircraft_type"):
            if ac.get(k):
                st[k] = ac[k]
        if (self._shear and not st["ga"] and not st.get("top_done")
                and sum(len(P["u"]) for P in st["prof"].values()) != n_w):
            try:
                self._shear(icao, st, now, False)
            except Exception as exc:                      # noqa: BLE001
                log.debug("Departure windshear check failed: %s", exc)
        if alt_msl > DEP_TOP_FT + 300 and not st.get("top_done"):
            # the end of the band profile: the final windshear report now, as before
            st["top_done"] = True
            st["t_top"] = now                 # the record keeps this time (as before the 5 000 ft series)
            st["shear_res"] = self._final_shear(icao, st, now)
        if (alt_msl > DEP_SERIES_TOP_FT + 300 or dist > DEP_MAX_NM
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

        def _rd(v, nd):
            return None if v is None else (int(round(v)) if nd == 0 else round(v, nd))
        # raw series (every reply since the previous sweep, height at its time)
        for t5, roll5, trate5, trk5, gs5, tas5 in b50:
            if t5 > since and len(st["raw5"]) < SERIES_MAX_ROWS:
                st["raw5"].append([round(t5, 2), _rd(roll5, 2), _rd(trate5, 3), _rd(trk5, 2),
                                   gs5, tas5, int(round(alt_at(t5)))])
        for smp in b60:
            if smp[0] > since and len(st["raw6"]) < SERIES_MAX_ROWS:
                st["raw6"].append([round(smp[0], 2), smp[1], _rd(smp[2], 2), _rd(smp[3], 0),
                                   _rd(smp[4], 0), _rd(smp[5] if len(smp) > 5 else None, 3),
                                   int(round(alt_at(smp[0])))])
        if self._vel is not None:
            try:
                for tv, vgs, vtrk, vvr in self._vel(icao, st.get("vlast", since)):
                    st["vlast"] = tv
                    if len(st["raw19"]) < SERIES_MAX_ROWS:
                        st["raw19"].append([round(tv, 2), vgs, _rd(vtrk, 1), vvr,
                                            int(round(alt_at(tv)))])
            except Exception as exc:                      # noqa: BLE001
                log.debug("Velocity sample fetch failed for %s: %s", icao, exc)
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

    def _final_shear(self, icao, st, now):
        # windshear band comparison: also for climbs without a stored profile
        # (the climb-out still becomes a reference for the next 45 min)
        if not self._shear or st["ga"]:
            return None
        try:
            return self._shear(icao, st, now, True)
        except Exception as exc:                          # noqa: BLE001
            log.debug("Departure windshear report failed: %s", exc)
            return None

    def _finish(self, icao, ac, now):
        st = self._state.pop(icao, None)
        if not st:
            return
        if not st["ga"]:                     # still a departure for the maps for a while
            self._recent[icao] = (now + DEP_MARK_SEC, (st.get("ws_rwy") or (None, None))[0])
        shear = st.get("shear_res") if st.get("top_done") else self._final_shear(icao, st, now)
        # bands with a temperature or a wind (turboprops report no Mach, so
        # their climbs give winds only — kept, as on the approach profiles)
        n_b = sum(1 for P in st["prof"].values() if P["t"] or P["u"])
        if n_b < DEP_MIN_BANDS:
            return
        prof = prof_summary(st["prof"])
        series = None
        try:
            from collector.windshear import WindshearTracker
            series = WindshearTracker._series_blob(
                st, {"icao": icao, "aircraft_type": st.get("aircraft_type"),
                     "runway": (st.get("ws_rwy") or (None, None))[0]})
        except Exception as exc:                          # noqa: BLE001
            log.debug("Departure series failed: %s", exc)
        rec = {"ts": st.get("t_top") or now, "t_start": st["t0"], "icao": icao,
               "callsign": st.get("callsign"), "registration": st.get("registration"),
               "aircraft_type": st.get("aircraft_type"), "qnh_hpa": st["qnh"],
               "track": st["track"], "lat": st["lat"], "lon": st["lon"],
               "ga": st["ga"], "prof": prof, "shear": shear, "series": series,
               "runway": (st.get("ws_rwy") or (None, None))[0]}
        self.n_committed += 1
        if self._on_commit:
            try:
                self._on_commit(rec)
            except Exception as exc:
                log.warning("Departure profile commit failed: %s", exc)

    def active(self) -> int:
        return len(self._state)

    def following(self, now: float | None = None) -> dict:
        """{icao: departure runway or None} of the departures, go-arounds
        excluded (from 2026-10-29): the climb-outs being followed now (up to
        5 300 ft) and, for DEP_MARK_SEC (15 min) after, the finished ones — so
        that the maps hide a departure for its whole climb through the
        windshear area (up to 5 000 ft and 15 NM), not only to 3 300 ft, and
        the windshear tracker does not take a climb-out that turns into
        another runway's approach corridor for an approach.  The windshear
        state marks them (``dep``)."""
        now = time.time() if now is None else now
        try:
            items = list(self._state.items())          # the sweep thread may add one meanwhile
            recent = list(self._recent.items())
        except RuntimeError:
            return {}
        out = {k: r for k, (until, r) in recent if until > now}
        if len(out) != len(recent):
            try:
                self._recent = {k: v for k, v in self._recent.items() if v[0] > now}
            except RuntimeError:
                pass
        out.update({k: (st.get("ws_rwy") or (None, None))[0] for k, st in items if not st.get("ga")})
        return out
