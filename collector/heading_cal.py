"""
collector/heading_cal.py — per-airframe heading calibration (from 2026-10-10)

Why
---
The wind is ground vector − air vector, and the air vector points along the
aircraft's true heading = BDS 6,0 magnetic heading + magnetic declination
(WMM2025 at the aircraft position, collector/declination.py).  The declination
is right, but the magnetic heading each aircraft reports carries its own small
offset: most airliners convert their inertial true heading to magnetic with a
magnetic-variation table stored in the avionics, and that table is often years
old.  Declination at Helsinki has grown from 7.0° (2005) to 10.5° (2026), so a
2015 table makes the reported heading ~2° too large after today's declination
is added back.  One degree at 450 kt is ~8 kt of wind error across the heading.

The study in tmp_files/Articles/ModeS_Upper_Air_Profiles_10_2026.pdf (Sect. 3.6)
found, for 403 airframes heard 24 Sep – 10 Oct 2026:
  • offsets of +1.5° on average (SD 1.0°), repeatable between two periods
    (r = 0.91) and grouped by aircraft type (E190 3.5°, CRJ900 / A220 2.1–2.3°,
    A320neo / A350 1.1–1.2°, B777-300ER ≈ 0°);
  • correcting them reduced the area-mean wind difference to the Jokioinen
    soundings from 11.5 to 9.1 kt RMS and halved the spread of single winds.

How
---
Learning (continuous, in RAM):
  For each aircraft at most one sample every HEADING_CAL_SAMPLE_SEC (30 s):
  true airspeed ≥ 100 kt, roll ≤ 5°, within HEADING_CAL_RADIUS_KM of the
  receiver, altitude known.  The reference is the mean (corrected) wind of the
  OTHER aircraft in the same altitude layer (collector/atmos.py layers) during
  the last 60 min, from at least 4 other airframes.  A heading offset δ (reported
  − true) gives a wind error −V·δ·n̂ (n̂ = unit vector to the right of the heading),
  so per airframe
        δ = − Σ V (r·n̂) / Σ V²          (r = own raw wind − reference)
  Residuals above 40 kt are ignored.  The sums fade with a half-life of
  HEADING_CAL_HALFLIFE_DAYS (30 d), so a magnetic-variation database update in
  an aircraft is followed within weeks; if three consecutive flights disagree
  with the long-term value by more than 1.5°, the airframe restarts from those
  flights (change detection).

Applying (HEADING_CAL_MODE = "apply"):
  true heading = magnetic heading + declination − δ, where δ is
    'A' the airframe's own value, once it has data from ≥ HEADING_CAL_MIN_FLIGHTS
        (2) flights and ≥ 20 samples (≈0.5° accuracy);
    'T' otherwise the median of its aircraft type (≥ 3 calibrated airframes);
    'F' otherwise the median of all calibrated airframes (≥ 10);
    'D' otherwise HEADING_CAL_DEFAULT_DEG (1.5°).
  'X' an airframe whose own offset exceeds HEADING_CAL_EXCLUDE_DEG (5°) is
      probably reporting a different heading reference: its winds are not used
      (best wind empty; the raw wind is still stored).
  The raw (uncorrected) wind stays in observations.wind_spd / wind_dir; the
  corrected wind goes to best_wind_spd / best_wind_dir, which every consumer
  (Live Map, area profiles, Sounding, Wind Map, Windshear, hourly archive) uses.
  The applied offset and its source are stored per observation (hdg_off,
  hdg_src).  "learn" learns without correcting; "off" disables everything.

Storage:
  heading_cal table, one row per airframe (~1–2 thousand rows), written once an
  hour (only rows that changed) and at shutdown; loaded at startup.  When the
  table is empty at startup, the offsets are learnt once from the stored
  observations of the last HEADING_CAL_BOOTSTRAP_DAYS (30) days in a background
  thread (a few read queries, no extra writes besides the table itself).
"""

from __future__ import annotations

import logging
import math
import threading
import time
from collections import deque
from typing import Optional

from collector.atmos import layer_of, _haversine_km
from collector.wind_calc import compute_wind

log = logging.getLogger("modes.heading_cal")

MIN_FLIGHT_SAMPLES = 5        # samples needed for a flight to count
CHANGE_DEG         = 1.5      # flight offset this far from the long-term value …
CHANGE_FLIGHTS     = 3        # … on this many consecutive flights → restart
STATS_EVERY_SEC    = 600.0    # type / fleet medians recomputed this often
TYPE_MIN_AF        = 3        # calibrated airframes needed for a type median
FLEET_MIN_AF       = 10       # calibrated airframes needed for the fleet median
PRUNE_HALFLIVES    = 8.0      # airframes unseen this many half-lives are dropped


def _median(v: list) -> Optional[float]:
    if not v:
        return None
    v = sorted(v)
    n = len(v)
    return v[n // 2] if n % 2 else 0.5 * (v[n // 2 - 1] + v[n // 2])


class HeadingCal:
    """Per-airframe heading offset learning and correction (thread-safe)."""

    def __init__(self, cfg) -> None:
        g = lambda k, d: getattr(cfg, k, d)
        mode = str(g("HEADING_CAL_MODE", "apply")).strip().lower()
        self.mode          = mode if mode in ("apply", "learn", "off") else "apply"
        self.default_deg   = float(g("HEADING_CAL_DEFAULT_DEG", 1.5))
        self.min_flights   = int(g("HEADING_CAL_MIN_FLIGHTS", 2))
        self.min_obs       = int(g("HEADING_CAL_MIN_SAMPLES", 20))
        self.exclude_deg   = float(g("HEADING_CAL_EXCLUDE_DEG", 5.0))
        self.halflife_sec  = float(g("HEADING_CAL_HALFLIFE_DAYS", 30.0)) * 86_400.0
        self.radius_km     = float(g("HEADING_CAL_RADIUS_KM", g("SOUNDING_RADIUS_KM", 150.0)))
        self.sample_sec    = float(g("HEADING_CAL_SAMPLE_SEC", 30.0))
        self.bootstrap_days = float(g("HEADING_CAL_BOOTSTRAP_DAYS", 30.0))
        self.flight_gap    = float(g("FLIGHT_GAP_SEC", 1800.0))
        self.ref_lat       = float(cfg.RECEIVER_LAT)
        self.ref_lon       = float(cfg.RECEIVER_LON)
        self.ref_window    = 3600.0
        self.min_ref_af    = 4
        self.max_resid     = 40.0
        self.min_tas       = 100.0
        self.max_roll      = 5.0

        self._lock = threading.Lock()
        self._af: dict[str, dict] = {}                 # icao → record
        self._ref: dict[int, deque] = {}               # layer → (ts, icao, u, v)
        self._last_sample: dict[str, float] = {}
        self._type_med: dict[str, float] = {}
        self._fleet_med: Optional[float] = None
        self._stats_ts = 0.0
        self.n_samples = 0                             # learning samples since start

    # ── Helpers ────────────────────────────────────────────────────────────
    @property
    def enabled(self) -> bool:
        return self.mode != "off"

    def _decay(self, rec: dict, now: float) -> None:
        dt = now - rec["t"]
        if dt > 0 and self.halflife_sec > 0:
            f = 0.5 ** (dt / self.halflife_sec)
            rec["s"] *= f
            rec["w"] *= f
            rec["n"] *= f
        rec["t"] = max(rec["t"], now)

    @staticmethod
    def _delta(rec: dict) -> Optional[float]:
        if rec["w"] <= 0:
            return None
        return math.degrees(-rec["s"] / rec["w"])

    def _flights(self, rec: dict) -> int:
        return rec["flights"] + (1 if rec["fn"] >= MIN_FLIGHT_SAMPLES else 0)

    def _calibrated(self, rec: dict) -> bool:
        return self._flights(rec) >= self.min_flights and rec["n"] >= self.min_obs

    @staticmethod
    def _new_rec(typ: Optional[str], now: float) -> dict:
        return {"typ": typ, "s": 0.0, "w": 0.0, "n": 0.0, "t": now, "flights": 0,
                "last_ts": 0.0, "fs": 0.0, "fw": 0.0, "fn": 0,
                "recent": deque(maxlen=CHANGE_FLIGHTS), "disagree": 0, "dirty": True}

    def _offset_locked(self, icao: str, typ: Optional[str]) -> tuple[Optional[float], str]:
        rec = self._af.get(icao)
        if rec is not None and self._calibrated(rec):
            d = self._delta(rec)
            if d is not None:
                return d, ("X" if abs(d) > self.exclude_deg else "A")
        t = typ or (rec["typ"] if rec else None)
        if t and t in self._type_med:
            return self._type_med[t], "T"
        if self._fleet_med is not None:
            return self._fleet_med, "F"
        return self.default_deg, "D"

    def _stats_locked(self, now: float) -> None:
        by_type: dict[str, list] = {}
        allv = []
        for rec in self._af.values():
            if not self._calibrated(rec):
                continue
            d = self._delta(rec)
            if d is None or abs(d) > self.exclude_deg:
                continue
            allv.append(d)
            if rec["typ"]:
                by_type.setdefault(rec["typ"], []).append(d)
        self._type_med = {t: _median(v) for t, v in by_type.items() if len(v) >= TYPE_MIN_AF}
        self._fleet_med = _median(allv) if len(allv) >= FLEET_MIN_AF else None
        self._stats_ts = now

    def _close_flight_locked(self, icao: str, rec: dict) -> None:
        if rec["fn"] >= MIN_FLIGHT_SAMPLES and rec["fw"] > 0:
            fd = math.degrees(-rec["fs"] / rec["fw"])
            long_d = self._delta(rec)
            if rec["flights"] >= 4 and long_d is not None and abs(fd - long_d) > CHANGE_DEG:
                rec["disagree"] += 1
            else:
                rec["disagree"] = 0
            rec["recent"].append((rec["fs"], rec["fw"], rec["fn"]))
            rec["flights"] += 1
            if rec["disagree"] >= CHANGE_FLIGHTS and len(rec["recent"]) >= CHANGE_FLIGHTS:
                old = long_d
                rec["s"] = sum(x[0] for x in rec["recent"])
                rec["w"] = sum(x[1] for x in rec["recent"])
                rec["n"] = float(sum(x[2] for x in rec["recent"]))
                rec["flights"] = len(rec["recent"])
                rec["disagree"] = 0
                log.info("Heading offset of %s changed: %+.1f° → %+.1f° (restarted from "
                         "its last %d flights)", icao, old, self._delta(rec), rec["flights"])
        rec["fs"] = rec["fw"] = 0.0
        rec["fn"] = 0

    # ── Main entry: called by the collector for every computed wind ────────
    def process(self, icao: str, ts: float, wind: dict, lat, lon, alt,
                typ: Optional[str]) -> dict:
        """Learn from one computed wind and return the fields to merge into it:
        hdg_off / hdg_src, and in "apply" mode cal_spd / cal_dir (the corrected
        wind; None when the airframe is excluded).  Empty dict when off or when
        the wind lacks the inputs."""
        if self.mode == "off" or not wind:
            return {}
        mh, decl = wind.get("bds60_mag_heading"), wind.get("mag_decl")
        trk, gs, tas = wind.get("bds50_true_track"), wind.get("bds50_groundspeed"), wind.get("tas_kt")
        if mh is None or decl is None or trk is None or gs is None or tas is None:
            return {}
        psi = math.radians((mh + decl) % 360.0)
        with self._lock:
            if ts - self._stats_ts > STATS_EVERY_SEC:
                self._stats_locked(ts)
            delta, src = self._offset_locked(icao, typ)

            # ── learning sample ──
            roll = wind.get("bds50_roll")
            lay = layer_of(alt)
            if (tas >= self.min_tas and (roll is None or abs(roll) <= self.max_roll)
                    and lay is not None and lat is not None and lon is not None
                    and ts - self._last_sample.get(icao, 0.0) >= self.sample_sec
                    and _haversine_km(self.ref_lat, self.ref_lon, lat, lon) <= self.radius_km):
                self._last_sample[icao] = ts
                r = math.radians(wind["wind_dir"])
                u, v = -wind["wind_spd"] * math.sin(r), -wind["wind_spd"] * math.cos(r)
                nx, ny = math.cos(psi), -math.sin(psi)          # right of heading
                dq = self._ref.setdefault(lay, deque())
                while dq and ts - dq[0][0] > self.ref_window:
                    dq.popleft()
                su = sv = 0.0
                cnt = 0
                others = set()
                for _t, ic, uu, vv in dq:
                    if ic != icao:
                        su += uu
                        sv += vv
                        cnt += 1
                        others.add(ic)
                if len(others) >= self.min_ref_af:
                    rx, ry = u - su / cnt, v - sv / cnt
                    if math.hypot(rx, ry) <= self.max_resid:
                        rec = self._af.get(icao)
                        if rec is None:
                            rec = self._af[icao] = self._new_rec(typ, ts)
                        if typ and rec["typ"] != typ:
                            rec["typ"] = typ
                        if rec["last_ts"] and ts - rec["last_ts"] > self.flight_gap:
                            self._close_flight_locked(icao, rec)
                        self._decay(rec, ts)
                        rn = rx * nx + ry * ny
                        rec["s"] += tas * rn
                        rec["w"] += tas * tas
                        rec["n"] += 1.0
                        rec["fs"] += tas * rn
                        rec["fw"] += tas * tas
                        rec["fn"] += 1
                        rec["last_ts"] = ts
                        rec["dirty"] = True
                        self.n_samples += 1
                # own corrected wind into the reference (excluded airframes not)
                if src != "X":
                    d = math.radians(delta)
                    dq.append((ts, icao, u + tas * d * nx, v + tas * d * ny))

        out = {"hdg_off": round(delta, 2), "hdg_src": src}
        if self.mode == "apply":
            if src == "X":
                out["cal_spd"] = out["cal_dir"] = None
            else:
                spd, wdir = compute_wind(float(trk), float(gs),
                                         (mh + decl - delta) % 360.0, float(tas))
                out["cal_spd"], out["cal_dir"] = round(spd, 1), round(wdir, 1)
        else:
            out["hdg_src"] = src.lower()          # learn mode: not applied
        return out

    def offset_for(self, icao: str, typ: Optional[str] = None) -> tuple[Optional[float], str]:
        """(offset °, source) that would be applied to this airframe now."""
        with self._lock:
            return self._offset_locked(icao, typ)

    # ── Persistence ────────────────────────────────────────────────────────
    def load(self, db) -> int:
        rows = db.execute("SELECT icao, typ, s, w, n, t, flights, last_ts FROM heading_cal").fetchall()
        with self._lock:
            for r in rows:
                rec = self._new_rec(r[1], r[5] or time.time())
                rec.update(s=r[2] or 0.0, w=r[3] or 0.0, n=r[4] or 0.0,
                           flights=int(r[6] or 0), last_ts=r[7] or 0.0, dirty=False)
                self._af[r[0]] = rec
            self._stats_locked(time.time())
        return len(rows)

    def save(self, db) -> int:
        """Write the airframes that changed since the last save (one commit)."""
        now = time.time()
        with self._lock:
            rows, drop = [], []
            for icao, rec in self._af.items():
                if self.halflife_sec > 0 and now - max(rec["last_ts"], rec["t"]) > PRUNE_HALFLIVES * self.halflife_sec:
                    drop.append(icao)
                    continue
                if not rec["dirty"]:
                    continue
                d = self._delta(rec)
                rows.append((icao, rec["typ"], rec["s"], rec["w"], rec["n"], rec["t"],
                             rec["flights"], rec["last_ts"],
                             None if d is None else round(d, 3), now))
                rec["dirty"] = False
            for icao in drop:
                del self._af[icao]
            self._last_sample = {k: v for k, v in self._last_sample.items() if now - v < 3600}
        if rows:
            # Only completed flights are counted in the stored value (the
            # flight in progress counts again once it continues after a
            # restart); its samples are already part of s / w / n.
            db.executemany(
                "INSERT OR REPLACE INTO heading_cal "
                "(icao, typ, s, w, n, t, flights, last_ts, delta, updated) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)", rows)
        if drop:
            db.executemany("DELETE FROM heading_cal WHERE icao = ?", [(i,) for i in drop])
        if rows or drop:
            db.commit()
        return len(rows)

    # ── One-off learning from the stored observations ─────────────────────
    def bootstrap(self, db, typ_fn=None, iterations: int = 4) -> int:
        """Learn the offsets from the observations of the last
        HEADING_CAL_BOOTSTRAP_DAYS (when the heading_cal table is empty).
        Same estimator as the live learning, with clock-hour layer references
        and four iterations.  The rows are kept in compact arrays (~80 bytes
        per observation used).  Returns the number of airframes learnt."""
        if self.mode == "off" or self.bootstrap_days <= 0:
            return 0
        from array import array
        now = time.time()
        t0 = now - self.bootstrap_days * 86_400.0
        cur = db.execute(
            """SELECT ts, icao, flight_id, lat, lon, altitude, wind_spd, wind_dir,
                      bds50_true_airspeed, bds60_mag_heading, mag_decl, bds50_roll
               FROM observations
               WHERE ts >= ? AND wind_spd IS NOT NULL AND bds50_true_airspeed >= ?
                 AND bds60_mag_heading IS NOT NULL AND mag_decl IS NOT NULL
                 AND lat IS NOT NULL AND altitude IS NOT NULL
               ORDER BY ts""",
            (t0, self.min_tas))
        icx: dict[str, int] = {}
        names: list[str] = []
        K = array("i"); F = array("q"); TS = array("d")
        U = array("d"); V = array("d"); TAS = array("d")
        NX = array("d"); NY = array("d"); WT = array("d")
        groups: list[list[int]] = []          # row indices per (clock hour, layer)
        cur_hour, by_lay = None, {}
        for ts, icao, fid, lat, lon, alt, ws, wd, tas, mh, decl, roll in cur:
            if roll is not None and abs(roll) > self.max_roll:
                continue
            lay = layer_of(alt)
            if lay is None or _haversine_km(self.ref_lat, self.ref_lon, lat, lon) > self.radius_km:
                continue
            hour = int(ts // 3600)
            if hour != cur_hour:
                groups.extend(by_lay.values())
                cur_hour, by_lay = hour, {}
            k = icx.get(icao)
            if k is None:
                k = icx[icao] = len(names)
                names.append(icao)
            by_lay.setdefault(lay, []).append(len(K))
            r = math.radians(wd)
            psi = math.radians((mh + decl) % 360.0)
            K.append(k); F.append(int(fid or 0)); TS.append(ts)
            U.append(-ws * math.sin(r)); V.append(-ws * math.cos(r)); TAS.append(float(tas))
            NX.append(math.cos(psi)); NY.append(-math.sin(psi))
            WT.append(0.5 ** ((now - ts) / self.halflife_sec) if self.halflife_sec > 0 else 1.0)
        groups.extend(by_lay.values())
        if not len(K):
            return 0
        n_af = len(names)
        # flights per airframe (all rows) for the provisional calibration flag
        fl_all = [set() for _ in range(n_af)]
        for j in range(len(K)):
            fl_all[K[j]].add(F[j])
        flights = [set() for _ in range(n_af)]
        delta = [self.default_deg] * n_af
        calib = [False] * n_af
        S = W = N = [0.0] * n_af
        for it in range(iterations):
            last_it = it == iterations - 1
            S = [0.0] * n_af
            W = [0.0] * n_af
            N = [0.0] * n_af
            cnt = [dict() for _ in range(n_af)] if last_it else None
            cal_vals = [delta[a] for a in range(n_af) if calib[a] and abs(delta[a]) <= self.exclude_deg]
            fleet = _median(cal_vals) if len(cal_vals) >= FLEET_MIN_AF else self.default_deg
            corr = [math.radians(delta[a] if calib[a] else fleet) for a in range(n_af)]
            excl = [calib[a] and abs(delta[a]) > self.exclude_deg for a in range(n_af)]
            for gi, idx in enumerate(groups):
                su = sv = 0.0
                per: dict[int, list] = {}
                for j in idx:
                    k = K[j]
                    if excl[k]:
                        continue
                    d = corr[k] * TAS[j]
                    uc, vc = U[j] + d * NX[j], V[j] + d * NY[j]
                    su += uc
                    sv += vc
                    p = per.get(k)
                    if p is None:
                        per[k] = [uc, vc, 1]
                    else:
                        p[0] += uc
                        p[1] += vc
                        p[2] += 1
                if len(per) < self.min_ref_af:
                    continue
                ntot = sum(p[2] for p in per.values())
                for j in idx:
                    k = K[j]
                    p = per.get(k)
                    if p is None:                      # excluded airframe
                        p = (0.0, 0.0, 0)
                        n_af_oth = len(per)
                    else:
                        n_af_oth = len(per) - 1
                    n_oth = ntot - p[2]
                    if n_af_oth < self.min_ref_af or n_oth <= 0:
                        continue
                    rx = U[j] - (su - p[0]) / n_oth
                    ry = V[j] - (sv - p[1]) / n_oth
                    if rx * rx + ry * ry > self.max_resid * self.max_resid:
                        continue
                    rn = rx * NX[j] + ry * NY[j]
                    wt, tas = WT[j], TAS[j]
                    S[k] += wt * tas * rn
                    W[k] += wt * tas * tas
                    N[k] += wt
                    if cnt is not None:
                        cnt[k][F[j]] = cnt[k].get(F[j], 0) + 1
                if gi % 200 == 0:
                    time.sleep(0)            # let the collector thread run
            for a in range(n_af):
                if W[a] > 0:
                    delta[a] = math.degrees(-S[a] / W[a])
            if last_it:
                for a in range(n_af):
                    flights[a] = {f for f, c in cnt[a].items() if c >= MIN_FLIGHT_SAMPLES}
            else:
                calib = [W[a] > 0 and len(fl_all[a]) >= self.min_flights and N[a] >= self.min_obs
                         for a in range(n_af)]
        last = [0.0] * n_af
        for j in range(len(K)):
            if TS[j] > last[K[j]]:
                last[K[j]] = TS[j]
        n_done = 0
        with self._lock:
            for a in range(n_af):
                if W[a] <= 0:
                    continue
                icao = names[a]
                rec = self._af.get(icao)
                if rec is None:
                    rec = self._af[icao] = self._new_rec(typ_fn(icao) if typ_fn else None, now)
                else:
                    self._decay(rec, now)
                rec["s"] += S[a]
                rec["w"] += W[a]
                rec["n"] += N[a]
                rec["flights"] += len(flights[a])
                rec["last_ts"] = max(rec["last_ts"], last[a])
                if not rec["typ"] and typ_fn:
                    rec["typ"] = typ_fn(icao)
                rec["dirty"] = True
                n_done += 1
            self._stats_locked(now)
        return n_done

    # ── Status for the API ─────────────────────────────────────────────────
    def summary(self, include_airframes: bool = True) -> dict:
        now = time.time()
        with self._lock:
            afs = []
            n_cal = n_excl = 0
            for icao, rec in self._af.items():
                d = self._delta(rec)
                cal = self._calibrated(rec)
                src = None
                if cal and d is not None:
                    src = "X" if abs(d) > self.exclude_deg else "A"
                    n_cal += src == "A"
                    n_excl += src == "X"
                if include_airframes:
                    afs.append({"icao": icao, "type": rec["typ"],
                                "offset_deg": None if d is None else round(d, 2),
                                "flights": self._flights(rec), "samples": round(rec["n"], 1),
                                "last_seen": rec["last_ts"] or None, "status": src or "learning"})
            types = {}
            for rec in self._af.values():
                if self._calibrated(rec) and rec["typ"]:
                    d = self._delta(rec)
                    if d is not None and abs(d) <= self.exclude_deg:
                        types.setdefault(rec["typ"], []).append(d)
            out = {
                "mode": self.mode, "airframes": len(self._af), "calibrated": n_cal,
                "excluded": n_excl, "fleet_median_deg": None if self._fleet_med is None else round(self._fleet_med, 2),
                "default_deg": self.default_deg, "exclude_deg": self.exclude_deg,
                "min_flights": self.min_flights, "halflife_days": self.halflife_sec / 86_400.0,
                "samples_since_start": self.n_samples,
                "types": sorted(({"type": t, "airframes": len(v), "median_deg": round(_median(v), 2)}
                                 for t, v in types.items()), key=lambda x: -x["airframes"]),
                "generated": now,
            }
            if include_airframes:
                out["airframe_list"] = sorted(afs, key=lambda x: -(x["last_seen"] or 0))
        return out


# ── Module-level instance ────────────────────────────────────────────────────
_instance: Optional[HeadingCal] = None


def init(cfg) -> HeadingCal:
    global _instance
    _instance = HeadingCal(cfg)
    return _instance


def get() -> Optional[HeadingCal]:
    return _instance
