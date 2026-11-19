"""Approach record without a position (from 2026-11-19).

An arrival that has lost GNSS before it reaches the ILS corridor has no
position, so the windshear tracker (collector/windshear.py) never sees it on
final and it leaves no Approach History record.  This mixin of the
WindshearTracker finds such a landing from what the aircraft still sends:

  runway direction   the BDS 5,0 true track (inertial), within TRK_DEV of a
                     runway heading
  distance           the QNH altitude on the 3° path:
                     (height above the threshold − TCH_FT) / 318.5 ft per NM
  on final           descending VS_MIN … VS_MAX ft/min between HAT_MIN and
                     HAT_MAX above the threshold, for EST_SEC; after that the
                     descent alone keeps it on final (low down the radars'
                     BDS 5,0 replies often stop), unless a new track says
                     it has turned away
  landing            down to LAND_HAT and no climb for CONFIRM_SEC (or the
                     replies end below STALE_HAT)
  runway side        15 / 33: none needed.  Parallel runways: one time
                     difference of two GPS-timed receivers (collector/
                     mlat_rec.py) where it separates the two finals, else the
                     side of the recent landings with a position ("assumed")

Measured on the stored landings of 20 Oct – 19 Nov 2026: the track is within
10° of the runway heading on 99.2 % of the samples on final; the distance is
within 0.5 NM on 99 % of the samples while descending 300–1 300 ft/min
(median −0.07 … +0.03 NM).

The same logic runs on every low aircraft.  For one with a position it is the
**check** ("shadow"): what it would have recorded is compared with the
landing the tracker recorded from the position — runway, side, distance,
landing time — and logged (nopos_log), so each day measures the method on
hundreds of landings.  For one without a position it makes the record
(reason NO-POSITION), marked in gnss_json: {"np": {...}}.  Such a record
raises no windshear alert, is not drawn on the maps, and there is no
go-around event from it.

All methods run in the windshear sweep thread with the tracker's lock held
by the caller where the tracker's buffers are touched.
"""
from __future__ import annotations

import logging
import math
import time
from collections import deque

log = logging.getLogger("modes.windshear")

# ── when an aircraft counts as having no position ────────────────────────────
NOPOS_SEC    = 30.0     # no new position for this long
POS_MEM_SEC  = 900.0    # a last known position this recent must be near enough
POS_NM_BASE  = 12.0     # … within POS_NM_BASE + POS_NM_MIN × its age in minutes
POS_NM_MIN   = 4.5      #   of the airport (270 kt), else not this airport
ALT_FRESH    = 12.0     # s: altitude heard within
TRK_FRESH    = 20.0     # s: BDS 5,0 track heard within
# ── the candidate ────────────────────────────────────────────────────────────
TRK_DEV      = 10.0     # ° track against the runway heading
HAT_TOP      = 2500.0   # ft above the airport: aircraft below it are followed
HAT_MAX      = 2000.0   # ft above the threshold: the part of the final used
HAT_MIN      = 300.0
VS_MIN       = -1300.0  # ft/min
VS_MAX       = -300.0
VS_WIN       = 30.0     # s of altitudes kept for the descent rate
VS_MIN_DT    = 10.0     # s: shortest span for a rate
EST_SEC      = 60.0     # on final by these rules for this long …
EST_N        = 10       # … with at least this many 3-s sweeps
GAP_SEC      = 20.0     # the rules may fail this long
GAP_EST_SEC  = 40.0     # … and this long once on final (low down the replies thin out)
# ── the landing ──────────────────────────────────────────────────────────────
LAND_HAT     = 400.0    # ft above the threshold: low enough to be landing
STALE_HAT    = 1000.0   # replies ended below this: taken as landed
CONFIRM_SEC  = 45.0     # s without a climb after LAND_HAT
CLIMB_FT     = 300.0    # a climb this far above the lowest height: not a landing
TCH_FT       = 50.0     # threshold crossing height of the 3° path
# ── guards and the runway side ───────────────────────────────────────────────
INUSE_SEC    = 1800.0   # a landing with a position on the same direction this recently
TAIL_KT      = 8.0      # without any landing to compare: METAR tailwind limit
SIDE_SEC     = 3600.0   # the recent landings that give the assumed side
SIDE_DEFAULT = {"04": "04L", "22": "22L"}
TD_MIN_N     = 8        # time differences needed for the side
TD_MAX_NS    = 2500.0   # the chosen final must fit this well (median |difference|)
TD_SEP_NS    = 3000.0   # … and the other one this much worse
MATCH_SEC    = 300.0    # check: a landing and its position-free twin within this
LOG_MAX      = 400      # events kept in RAM for the page


def _hd(a: float, b: float) -> float:
    return abs((a - b + 180.0) % 360.0 - 180.0)


def _nm(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 3440.065 * 2 * math.asin(min(1.0, math.sqrt(a)))


def _dest(lat, lon, brg, nm):
    """Point nm from (lat, lon) on true bearing brg (flat earth: a few NM)."""
    b = math.radians(brg)
    return (lat + nm * math.cos(b) / 60.0,
            lon + nm * math.sin(b) / (60.0 * math.cos(math.radians(lat))))


def _med(v):
    s = sorted(v)
    n = len(s)
    return None if not n else (s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2.0)


class BlindApproachMixin:
    """The position-free approach logic of the WindshearTracker."""

    def _blind_init(self) -> None:
        self.blind_enabled = True          # APPROACH_NO_POSITION (run.py)
        self.on_blind_event = None         # callable(row) → nopos_log (run.py)
        # callable(icao, t0, t1) → [(t, a, b, tdoa ns, pressure alt ft)] and
        # callable(a, b, lat, lon, h_m) → expected tdoa ns | None (mlat_rec.py)
        self.tdoa_fn = None
        self.tdoa_expected_fn = None
        self._blind: dict[str, dict] = {}          # icao → entry
        self._bl_would: dict[str, dict] = {}       # check: position-free results waiting for the landing
        self._bl_norm: dict[str, dict] = {}        # check: landings waiting for the position-free result
        self._bl_log: deque = deque(maxlen=LOG_MAX)
        self._bl_fams: list | None = None
        self._bl_day: dict = {}                    # UTC day → counters

    # ── runway families ──────────────────────────────────────────────────────
    def _blind_families(self) -> list:
        """[{"key": "04", "hdg": 48.0, "elev": ft, "rwys": [runway dicts]}]:
        the runways grouped by direction (parallels together)."""
        if self._bl_fams is None:
            fams: list = []
            for r in self.runways or []:
                for f in fams:
                    if _hd(f["hdg"], r["heading"]) <= 5.0:
                        f["rwys"].append(r)
                        break
                else:
                    fams.append({"key": str(r["name"])[:2], "hdg": float(r["heading"]), "rwys": [r]})
            for f in fams:
                f["elev"] = sum(r.get("thr_elevation_ft", self.thr_elevation_ft) for r in f["rwys"]) / len(f["rwys"])
            self._bl_fams = fams
        return self._bl_fams

    def _blind_fam(self, trk: float):
        best = None
        for f in self._blind_families():
            d = _hd(trk, f["hdg"])
            if d <= TRK_DEV and (best is None or d < best[0]):
                best = (d, f)
        return best[1] if best else None

    def _blind_fam_of(self, runway: str | None):
        for f in self._blind_families():
            if any(r["name"] == runway for r in f["rwys"]):
                return f
        return None

    # ── per sweep ────────────────────────────────────────────────────────────
    def _blind_pre(self, ac: dict, now: float) -> bool:
        """One sweep of one aircraft.  True: the aircraft is followed without a
        position this sweep — the caller skips the normal update."""
        if not self.blind_enabled or self._qnh_hpa is None:
            return False
        icao, alt = ac.get("icao"), ac.get("altitude")
        if not icao or alt is None:
            return False
        from collector.windshear import GS_FT_PER_NM, is_blocked_registration
        alt_ts = ac.get("alt_ts")
        alt_fresh = alt_ts is not None and now - alt_ts <= ALT_FRESH
        qnh_corr = self._qnh_corr_ft()
        e = self._blind.get(icao)
        if e is None:
            if not alt_fresh:
                return False
            h0 = alt - qnh_corr - self.thr_elevation_ft
            if h0 > HAT_TOP or h0 < -300.0:
                return False
            if is_blocked_registration(ac.get("registration") or "", self.blocked_reg_prefixes):
                return False
            e = self._blind[icao] = {
                "alts": deque(), "t50": now - TRK_FRESH, "trk": None, "trk_ts": 0.0, "gs": None,
                "fam": None, "ok0": None, "ok1": None, "n": 0, "nb": 0, "hmin": None,
                "low": None, "dist": None, "dist_ts": None, "derr": [], "true_rwy": None,
                "done": None, "t0": now, "hat": None,
            }
        e["sweep"] = now
        e["cs"] = (ac.get("callsign") if ac.get("callsign") and ac.get("callsign") != icao else e.get("cs")) or icao
        e["reg"], e["typ"] = ac.get("registration") or e.get("reg"), ac.get("aircraft_type") or e.get("typ")
        if e["done"] is not None:
            if now - e["done"] > MATCH_SEC:
                del self._blind[icao]
            return False

        # descent rate from the altitudes heard (source-independent)
        vs = None
        if alt_fresh:
            al = e["alts"]
            if not al or alt_ts > al[-1][0]:
                al.append((alt_ts, float(alt)))
            while al and alt_ts - al[0][0] > VS_WIN:
                al.popleft()
            if len(al) >= 2 and al[-1][0] - al[0][0] >= VS_MIN_DT:
                vs = (al[-1][1] - al[0][1]) / (al[-1][0] - al[0][0]) * 60.0

        # the newest BDS 5,0 true track
        if self._bds_sample_fn is not None:
            try:
                b50, _ = self._bds_sample_fn(icao, e["t50"])
            except Exception:                              # noqa: BLE001
                b50 = []
            for s in b50:
                ts, ttrk, bgs = s[0], s[3], s[4]
                e["t50"] = max(e["t50"], ts)
                if ttrk is not None and (bgs is None or 60 <= bgs <= 300):
                    e["trk"], e["trk_ts"], e["gs"] = float(ttrk), ts, bgs
        fam = None
        if e["trk"] is not None and now - e["trk_ts"] <= TRK_FRESH:
            fam = self._blind_fam(e["trk"])

        lat, pos_ts = ac.get("lat"), ac.get("last_pos_update_ts")
        fresh_pos = lat is not None and pos_ts is not None and now - pos_ts <= NOPOS_SEC
        st = self._state.get(icao)
        norm = bool(st and (st.get("in_corridor") or st.get("landing_rwy") is not None
                            or st.get("ga_phase", "NONE") != "NONE"))
        blind_sweep = not fresh_pos and not norm and self._blind_plausible(ac, now)

        ref = self._blind_fam_of(e["rwy"]) if e.get("rwy") else fam
        thr = ref["elev"] if ref else self.thr_elevation_ft
        alt_msl = alt - qnh_corr
        hat = alt_msl - thr
        if alt_fresh:
            e["hat"] = hat
            if hat > HAT_TOP and e["low"] is None:
                self._blind_drop(icao, e, "above")
                return False

        est = bool(e["ok0"] is not None and e["ok1"] - e["ok0"] >= EST_SEC and e["n"] >= EST_N)
        trk_ok = fam is not None and (e["fam"] is None or e["fam"] == fam["key"])
        if not trk_ok and est:
            # on final already: the descent is enough while no fresh track says otherwise
            f0 = next((f for f in self._blind_families() if f["key"] == e["fam"]), None)
            trk_ok = bool(f0) and (now - e["trk_ts"] > TRK_FRESH or _hd(e["trk"], f0["hdg"]) <= 2 * TRK_DEV)
        qual = bool(alt_fresh and vs is not None and VS_MIN <= vs <= VS_MAX
                    and HAT_MIN <= hat <= HAT_MAX and trk_ok)
        if qual:
            if e["ok0"] is None:
                e.update(ok0=now, fam=fam["key"], n=0, nb=0, hmin=hat, derr=[], true_rwy=None)
                e["rwy"] = self._blind_side(fam, now, icao)
            e["ok1"] = now
            e["n"] += 1
            thr_r = self._thr_ft(e["rwy"])
            dist = max(0.0, (alt_msl - thr_r - TCH_FT) / GS_FT_PER_NM)
            e["dist"], e["dist_ts"] = dist, now
            if st and st.get("in_corridor") and fresh_pos and st.get("dist_thr_nm") is not None:
                e["derr"].append(dist - st["dist_thr_nm"])
                e["true_rwy"] = st.get("approach_runway")
            if blind_sweep:
                e["nb"] += 1
                self._blind_capture(icao, ac, e, now, alt_msl, dist)
        if e["ok0"] is not None:
            if alt_fresh:
                e["hmin"] = min(e["hmin"], hat)
            est = e["ok1"] - e["ok0"] >= EST_SEC and e["n"] >= EST_N
            active = now - e["ok1"] <= (GAP_EST_SEC if est else GAP_SEC)
            if e["low"] is None:
                if alt_fresh and hat <= LAND_HAT and active and est:
                    e["low"] = now
                elif not active:
                    self._blind_reset(icao, e, "left the final")
            elif alt_fresh and hat > e["hmin"] + CLIMB_FT:
                self._blind_reset(icao, e, "climb")
            elif now - e["low"] >= CONFIRM_SEC:
                self._blind_land(icao, e, now, "low")
        return bool(blind_sweep and e["ok0"] is not None and e["nb"] > 0)

    def _blind_plausible(self, ac: dict, now: float) -> bool:
        """False when a recent last known position is too far from the airport
        for the aircraft to be on its final now."""
        lat, lon, pts = ac.get("lat"), ac.get("lon"), ac.get("last_pos_update_ts")
        if lat is None or lon is None or pts is None:
            return True
        age = now - pts
        if age > POS_MEM_SEC:
            return True
        return _nm(self.airport_lat, self.airport_lon, lat, lon) <= POS_NM_BASE + POS_NM_MIN * age / 60.0

    # ── capture (the tracker's own buffers, under the key icao + "~") ───────
    def _blind_capture(self, icao: str, ac: dict, e: dict, now: float,
                       alt_msl: float, dist: float) -> None:
        from collector.windshear import APPROACH_HISTORY_BANDS, BAND_TOL_FT
        key = icao + "~"
        wind_spd, wind_dir = ac.get("best_wind_spd"), ac.get("best_wind_dir")
        wts = ac.get("wind_ts")
        stale = bool(ac.get("meteo_source") == "COMPUTED" and wts is not None
                     and now - wts > self.wind_max_age)
        with self._lock:
            if (wind_spd is not None and wind_dir is not None and not stale
                    and ac.get("meteo_source", "NONE") != "NONE"):
                bw = self._band_winds.setdefault(key, {
                    "icao": icao, "callsign": e["cs"], "runway": e["rwy"],
                    "bands": {str(b): None for b in APPROACH_HISTORY_BANDS}})
                bw["callsign"] = e["cs"]
                for band in APPROACH_HISTORY_BANDS:
                    k = str(band)
                    if bw["bands"][k] is None and abs(alt_msl - band) <= BAND_TOL_FT:
                        bw["bands"][k] = {"dir": round(wind_dir), "spd": round(wind_spd, 1)}
            self._capture_gnss(key, ac, now, alt_msl, dist, False)
            ac2 = dict(ac)
            ac2.update(track=e["trk"], groundspeed=None, lat=None, lon=None)
            self._capture_rough(icao, ac2, now, alt_msl, e["rwy"], 0.0, "APPROACHING", dist,
                                key=key, blind=True)

    def _blind_pop(self, icao: str):
        key = icao + "~"
        with self._lock:
            return (self._band_winds.pop(key, None), self._band_gnss.pop(key, None),
                    self._rough.pop(key, None))

    def _blind_why(self, e: dict | None) -> str:
        if e is None:
            return "not followed"
        if e["trk"] is None:
            return "no BDS 5,0 track"
        if e["ok0"] is None:
            return "never on final by the rules"
        if not (e["ok1"] - e["ok0"] >= EST_SEC and e["n"] >= EST_N):
            return "too short (%d s, %d sweeps)" % (e["ok1"] - e["ok0"], e["n"])
        if e["low"] is None and (e["hmin"] is None or e["hmin"] > STALE_HAT):
            return "not heard low enough (%d ft)" % (e["hmin"] or 0)
        return "other"

    def _blind_reset(self, icao: str, e: dict, why: str) -> None:
        """The candidate ended without a landing: forget it (the aircraft stays followed)."""
        if icao in self._bl_norm:
            self._bl_norm[icao]["why"] = self._blind_why(e) if why != "climb" else "climb after the low point"
        if e["nb"]:
            self._blind_pop(icao)
            log.debug("Approach without position: %s dropped (%s)", icao, why)
        e.update(ok0=None, ok1=None, n=0, nb=0, fam=None, hmin=None, low=None,
                 derr=[], true_rwy=None, dist=None, dist_ts=None)
        e.pop("rwy", None)

    def _blind_drop(self, icao: str, e: dict, why: str) -> None:
        if e["ok0"] is not None:
            self._blind_reset(icao, e, why)
        self._blind.pop(icao, None)

    # ── runway side ──────────────────────────────────────────────────────────
    def _blind_side(self, fam: dict, now: float, icao: str | None = None) -> str:
        """The assumed runway of a direction: the side most used by the
        landings with a position of the last SIDE_SEC, else SIDE_DEFAULT."""
        names = [r["name"] for r in fam["rwys"]]
        if len(names) == 1:
            return names[0]
        cnt: dict = {}
        with self._lock:
            for r in self._approach_history:
                if now - r.get("ts", 0) > SIDE_SEC:
                    break
                if r.get("runway") in names and r.get("icao") != icao \
                        and not (r.get("gnss") or {}).get("np"):
                    cnt[r["runway"]] = cnt.get(r["runway"], 0) + 1
        if cnt:
            return max(sorted(cnt), key=lambda k: cnt[k])
        d = SIDE_DEFAULT.get(fam["key"])
        return d if d in names else names[0]

    def _blind_side_td(self, icao: str, e: dict, fam: dict):
        """(runway, info) from the time differences of the GPS-timed receivers
        while the aircraft was on final, or (None, info).  For each reply the
        aircraft is put on each parallel's 3° path at the reply's altitude and
        the expected time difference compared with the measured one."""
        if self.tdoa_fn is None or self.tdoa_expected_fn is None or len(fam["rwys"]) < 2 \
                or e["ok0"] is None:
            return None, None
        from collector.windshear import GS_FT_PER_NM
        try:
            rows = self.tdoa_fn(icao, e["ok0"] - 5.0, e["ok1"] + 5.0)
        except Exception as exc:                           # noqa: BLE001
            log.debug("Time differences not read for %s: %s", icao, exc)
            return None, None
        qc = self._qnh_corr_ft()
        res: dict = {r["name"]: [] for r in fam["rwys"]}
        sep = []
        for t, a, b, d, alt in rows:
            if alt is None:
                continue
            alt_msl = float(alt) - qc
            ex = {}
            for r in fam["rwys"]:
                thr = r.get("thr_elevation_ft", self.thr_elevation_ft)
                hat = alt_msl - thr
                if not HAT_MIN - 100 <= hat <= HAT_MAX + 100:
                    break
                dist = max(0.0, (hat - TCH_FT) / GS_FT_PER_NM)
                la, lo = _dest(r["thr_lat"], r["thr_lon"], (r["heading"] + 180.0) % 360.0, dist)
                x = self.tdoa_expected_fn(a, b, la, lo, alt_msl * 0.3048)
                if x is None:
                    break
                ex[r["name"]] = x
            if len(ex) != len(fam["rwys"]):
                continue
            for k, x in ex.items():
                res[k].append(abs(d - x))
            v = sorted(ex.values())
            sep.append(v[-1] - v[0])
        n = len(sep)
        if n < TD_MIN_N:
            return None, {"n": n}
        sc = sorted(((_med(v), k) for k, v in res.items()))
        info = {"n": n, "fit": int(round(sc[0][0])), "other": int(round(sc[1][0])),
                "sep": int(round(_med(sep)))}
        if sc[0][0] <= TD_MAX_NS and sc[1][0] - sc[0][0] >= TD_SEP_NS:
            return sc[0][1], info
        return None, info

    # ── direction in use ─────────────────────────────────────────────────────
    def _blind_in_use(self, fam: dict, now: float, icao: str) -> tuple:
        """(confirmed, how).  Confirmed when a landing with a position used the
        same direction within INUSE_SEC.  Without any landing to compare:
        when the METAR wind gives no tailwind over TAIL_KT on it."""
        names = {r["name"] for r in fam["rwys"]}
        same = other = 0
        with self._lock:
            for r in self._approach_history:
                if now - r.get("ts", 0) > INUSE_SEC:
                    break
                if r.get("icao") == icao or (r.get("gnss") or {}).get("np"):
                    continue
                if r.get("runway") in names:
                    same += 1
                else:
                    other += 1
        if same:
            return True, "landings"
        if other:
            return False, "other directions in use"
        m = self._metar if (self._metar and now - self._metar_set_ts <= 5400.0) else None
        if m and m.get("dir") is not None and m.get("spd") is not None:
            tail = -float(m["spd"]) * math.cos(math.radians(float(m["dir"]) - fam["hdg"]))
            if tail > TAIL_KT:
                return False, "tailwind %d kt" % round(tail)
            return True, "wind"
        return True, "nothing against"

    # ── the landing ──────────────────────────────────────────────────────────
    def _blind_land(self, icao: str, e: dict, now: float, how: str) -> None:
        """The position-free logic has a landing: a record (no position) or
        one row of the check (the aircraft has a position)."""
        fam = next((f for f in self._blind_families() if f["key"] == e["fam"]), None)
        e["done"] = now
        if fam is None:
            return
        rwy_a = e.get("rwy") or self._blind_side(fam, now, icao)
        rwy_t, td = self._blind_side_td(icao, e, fam)
        rwy = rwy_t or rwy_a
        gs = e["gs"] if e["gs"] and 60 <= e["gs"] <= 300 else 140.0
        ts = min(now, (e["dist_ts"] or now) + (e["dist"] or 0.0) / gs * 3600.0)
        conf, chow = self._blind_in_use(fam, now, icao)
        st = self._state.get(icao)
        norm = bool(st and (st.get("in_corridor") or st.get("landing_rwy") is not None
                            or st.get("ga_phase", "NONE") != "NONE"))
        with self._lock:
            recent = now - self._recent_commits.get(icao, 0.0) < MATCH_SEC
        np = {"rs": "td" if rwy_t else ("one" if len(fam["rwys"]) == 1 else "assumed"),
              "s": int(e["ok1"] - e["ok0"]), "n": e["n"], "hmin": int(round(e["hmin"])), "how": how}
        if td:
            np["td"] = td
        ev = {"ts": ts, "icao": icao, "callsign": e["cs"], "aircraft_type": e["typ"],
              "runway": rwy, "fam": e["fam"], "rwy_a": rwy_a, "rwy_t": rwy_t,
              "conf": conf, "chow": chow, "np": np, "nb": e["nb"]}
        real = not norm and not recent and e["nb"] >= EST_N
        if not real:
            # the check: wait for (or meet) the landing recorded from the position
            self._blind_pop(icao)
            if e["derr"]:
                d = sorted(e["derr"])
                ev["d_med"] = round(_med(d), 2)
                ev["d_p90"] = round(sorted(abs(x) for x in d)[int(0.9 * (len(d) - 1))], 2)
                ev["d_n"] = len(d)
            nrm = self._bl_norm.pop(icao, None)
            if nrm is not None and abs(nrm["ts"] - ts) <= MATCH_SEC:
                self._blind_match(ev, nrm)
            else:
                self._bl_would[icao] = ev
            return
        bw, gn, rg = self._blind_pop(icao)
        if not conf:
            self._blind_emit(dict(ev, kind="blind", result="unconfirmed", why=chow))
            log.info("Approach without position: %s (%s) RWY %s not recorded — %s",
                     e["cs"], icao, rwy, chow)
            return
        if bw:
            bw["runway"] = rwy
        entry = {"callsign": e["cs"], "registration": e["reg"], "aircraft_type": e["typ"],
                 "approach_runway": rwy}
        with self._lock:
            done = self._commit_approach(icao, entry, bw, None, now, rec_ts=ts, runway=rwy,
                                         reason="NO-POSITION", gnss=gn, rough=rg, nopos=np)
        if done:
            self._blind_emit(dict(ev, kind="blind", result="record"))

    def _blind_norm_commit(self, icao: str, ts: float, runway: str | None,
                           cs: str | None = None, typ: str | None = None) -> None:
        """A landing was recorded from the position: meet its position-free twin."""
        if not self.blind_enabled:
            return
        ev = self._bl_would.pop(icao, None)
        nrm = {"ts": ts, "rwy": runway, "why": self._blind_why(self._blind.get(icao)),
               "cs": cs, "typ": typ}
        if ev is not None and abs(ev["ts"] - ts) <= MATCH_SEC:
            self._blind_match(ev, nrm)
        else:
            self._bl_norm[icao] = nrm

    def _blind_match(self, ev: dict, nrm: dict) -> None:
        tf = self._blind_fam_of(nrm["rwy"])
        row = dict(ev, kind="check", result="match", true_rwy=nrm["rwy"],
                   fam_ok=bool(tf and tf["key"] == ev["fam"]),
                   dt=round(ev["ts"] - nrm["ts"], 1))
        row["ts"] = nrm["ts"]
        self._blind_emit(row)

    def _blind_emit(self, row: dict) -> None:
        day = time.strftime("%Y-%m-%d", time.gmtime(row.get("ts") or time.time()))
        c = self._bl_day.setdefault(day, {})
        k = row["kind"] + ":" + row["result"]
        c[k] = c.get(k, 0) + 1
        for d in sorted(self._bl_day)[:-3]:
            del self._bl_day[d]
        self._bl_log.appendleft(row)
        if self.on_blind_event is not None:
            try:
                self.on_blind_event(row)
            except Exception as exc:                       # noqa: BLE001
                log.debug("nopos_log callback failed: %s", exc)

    def _blind_prune(self, now: float) -> None:
        """Called from prune_stale(): aircraft gone silent, and the check's
        unmatched halves."""
        for icao in [k for k, e in self._blind.items() if now - e["sweep"] > 30.0]:
            e = self._blind[icao]
            if e["done"] is None and e["ok0"] is not None:
                est = e["ok1"] - e["ok0"] >= EST_SEC and e["n"] >= EST_N
                if est and (e["low"] is not None
                            or (e["hmin"] <= STALE_HAT and e["sweep"] - e["ok1"] <= GAP_EST_SEC)):
                    self._blind_land(icao, e, now, "low" if e["low"] is not None else "silent")
                else:
                    self._blind_reset(icao, e, "silent")
            elif icao in self._bl_norm and e["done"] is None:
                self._bl_norm[icao]["why"] = self._blind_why(e)
            self._blind.pop(icao, None)
            self._blind_pop(icao)
        for icao in [k for k, v in self._bl_would.items() if now - v["ts"] > MATCH_SEC]:
            ev = self._bl_would.pop(icao)
            self._blind_emit(dict(ev, kind="check", result="extra"))
        for icao in [k for k, v in self._bl_norm.items() if now - v["ts"] > MATCH_SEC]:
            nrm = self._bl_norm.pop(icao)
            self._blind_emit({"ts": nrm["ts"], "icao": icao, "callsign": nrm.get("cs"),
                              "aircraft_type": nrm.get("typ"), "kind": "check", "result": "missed",
                              "true_rwy": nrm["rwy"], "why": nrm["why"]})

    # ── for the pages ────────────────────────────────────────────────────────
    def blind_state(self) -> dict:
        """Aircraft followed without a position now, and the last events."""
        now = time.time()
        live = []
        for icao, e in list(self._blind.items()):
            if e["ok0"] is None or not e["nb"] or e["done"] is not None:
                continue
            live.append({"icao": icao, "callsign": e["cs"], "aircraft_type": e["typ"],
                         "runway": e.get("rwy"), "dist": None if e["dist"] is None else round(e["dist"], 1),
                         "hat": None if e["hat"] is None else int(round(e["hat"])),
                         "s": int(now - e["ok0"])})
        return {"on": bool(self.blind_enabled), "qnh": self._qnh_hpa is not None,
                "live": live, "log": list(self._bl_log)[:60], "days": dict(self._bl_day),
                "td": self.tdoa_fn is not None}
