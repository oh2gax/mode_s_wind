"""
collector/radio_horizon.py — how far beyond the radio horizon a receiver hears
low aircraft (from 20 Nov 2026; the Statistics page's Radio horizon panel).

A 1090 MHz signal travels almost in a straight line, so an aircraft at the
height h is normally heard at most to about

    d = 1.23 (sqrt(h_aircraft) + sqrt(h_antenna))  NM   (heights in feet),

the radio horizon in the standard atmosphere.  When the air's refractivity
falls quickly with height — warm, dry air over cool, moist air: an inversion —
the signal bends along the ground and low aircraft are heard further
("ducting", the same thing that gives radio amateurs their tropo openings).
The share  q = range / d  of the low aircraft a receiver hears is therefore a
plain, model-free sign of the propagation conditions.

What is counted (per receiver and UTC hour): the airborne ADS-B positions the
range rings accept (collector/msg_stats.py _range: confirmed by the aircraft's
previous position) of aircraft between HZ_MIN_FT and HZ_MAX_FT whose position
quality is good — the type code says a containment radius under 0.2 NM
(HZ_TC_MAX), which keeps positions spoilt by GNSS interference out.  For each
aircraft the CONFIRM (3) largest q of the hour are kept; its third largest is
its confirmed q, so one wrong position cannot make a record.

The hour's value is the second largest confirmed q — the reach confirmed by
two aircraft — and its level

    Normal     below EXT_Q (1.0)
    Extended   from EXT_Q: two aircraft heard beyond the standard horizon
    Ducting    from DUCT_Q (1.2): two aircraft more than a fifth beyond it

(provisional limits of 20 Nov 2026; to be looked at again when some weeks of
hours exist).  With fewer than two aircraft at a distance there is no level.

On an ordinary day the value is far below 1: in the recording of 19 Nov 2026
(05–11 UTC, all receivers together) the hourly reach was 0.34–0.47 and no
aircraft was heard beyond 0.6 of its horizon — terrain, trees and buildings
hide low aircraft far away, and most traffic at a distance is high.  So the
page also shows the receiver's usual reach (the median of the stored hours of
the last 7 days), against which an unusual hour stands out before it reaches
the limits.

The antenna height in the formula: RADIO_HORIZON_ANT_FT (one number, or a
value per receiver id), else the height of the receiver's MLAT_SITES entry
less the geoid (the antenna above sea level), else the Radarcape's own GPS
height, else 30 ft.  The barometric altitude is used as the aircraft's height;
with a QNH far from 1013 hPa it is off by up to about 300 ft, a few per cent
in q at the lowest heights counted — the reason for HZ_MIN_FT.

Stored: one small row an hour in horizon_hours (kept KEEP_DAYS); the open
hour's state only at a clean stop, so a restart continues the hour.  No
aircraft addresses in the closed rows.
"""

from __future__ import annotations

import json
import logging
import math
import time

log = logging.getLogger("radio_horizon")

HZ_MIN_FT, HZ_MAX_FT = 1500, 20000
HZ_TC_MAX = 12            # ADS-B type codes 9–12: containment radius under 0.2 NM
HZ_TRACK_Q = 0.1          # aircraft are followed from this share of the horizon
LOW_Q = 0.2               # … and counted as "at a distance" from this
USUAL_MIN_H = 12          # hours with a value behind "the usual reach"
EXT_Q, DUCT_Q = 1.0, 1.2
CONFIRM = 3               # positions of one aircraft behind its value
KEEP_DAYS = 400
GEOID_M = 18.0
DEFAULT_ANT_FT = 30.0
LEVELS = ("Normal", "Extended", "Ducting")

_CFG = {"ant": None, "sites": {}, "main_id": None}


def configure(cfg, main_id: str | None = None) -> None:
    """Settings (run.py, before the first message)."""
    _CFG["ant"] = getattr(cfg, "RADIO_HORIZON_ANT_FT", None)
    _CFG["sites"] = dict(getattr(cfg, "MLAT_SITES", None) or {})
    if main_id:
        _CFG["main_id"] = main_id


def horizon_nm(alt_ft: float, ant_ft: float) -> float:
    return 1.23 * (math.sqrt(max(alt_ft, 0.0)) + math.sqrt(max(ant_ft, 0.0)))


def level_of(q) -> int | None:
    if q is None:
        return None
    return 2 if q >= DUCT_Q else 1 if q >= EXT_Q else 0


def ensure_table(db) -> None:
    db.execute("""CREATE TABLE IF NOT EXISTS horizon_hours (
                      rx     TEXT    NOT NULL,      -- '' = the main receiver
                      ts     INTEGER NOT NULL,      -- start of the UTC hour
                      n      INTEGER,               -- positions counted
                      ac     INTEGER,               -- aircraft followed
                      n_low  INTEGER,               -- aircraft confirmed from 0.2 of the horizon
                      n_ext  INTEGER,               -- … beyond it
                      n_duct INTEGER,               -- … more than a fifth beyond it
                      q      REAL,                  -- the reach confirmed by two aircraft
                      far    TEXT,                  -- [q, NM, ft, bearing, NM beyond] of the farthest
                      ant_ft REAL,
                      open   TEXT,                  -- the open hour's state (clean stop only)
                      PRIMARY KEY (rx, ts))""")


class Horizon:
    """One receiver's accounting.  add() is called with the statistics
    object's lock held; the rest from the housekeeping / web threads."""

    def __init__(self, key: str = "") -> None:
        self.key = key or ""
        self.gps_alt_m = None          # the Radarcape's GPS height, when it has one
        self.t0: int | None = None
        self.n = 0
        self.ac: dict = {}             # icao → [[q, NM, ft, bearing]] (largest first, at most CONFIRM)
        self._closed: list = []
        self._ant = None               # (ft, source) of the open hour

    # ── the antenna height ────────────────────────────────────────────────
    def antenna(self) -> tuple:
        rid = self.key or _CFG.get("main_id") or ""
        a = _CFG.get("ant")
        try:
            if isinstance(a, dict):
                if rid in a:
                    return float(a[rid]), "setting"
            elif a is not None:
                return float(a), "setting"
        except (TypeError, ValueError):
            pass
        s = (_CFG.get("sites") or {}).get(rid)
        try:
            if s is not None and len(s) >= 3 and s[2] is not None:
                return max(0.0, (float(s[2]) - GEOID_M) / 0.3048), "site"
        except (TypeError, ValueError):
            pass
        if isinstance(self.gps_alt_m, (int, float)):
            return max(0.0, float(self.gps_alt_m) / 0.3048), "gps"
        return DEFAULT_ANT_FT, "default"

    # ── input ─────────────────────────────────────────────────────────────
    def add(self, icao: str, ts: float, d_nm: float, alt, brg: float, tc) -> None:
        if alt is None or tc is None or not HZ_MIN_FT <= alt < HZ_MAX_FT or not 9 <= tc <= HZ_TC_MAX:
            return
        h0 = int(ts // 3600) * 3600
        if self.t0 is None:
            self.t0 = h0
        elif h0 > self.t0:
            self._close()
            self.t0 = h0
        elif h0 < self.t0:
            return
        if self._ant is None:
            self._ant = self.antenna()
        self.n += 1
        dh = horizon_nm(alt, self._ant[0])
        q = d_nm / dh
        if q < HZ_TRACK_Q:
            return
        top = self.ac.get(icao)
        if top is None:
            top = self.ac[icao] = []
        if len(top) < CONFIRM:
            top.append([round(q, 3), round(d_nm, 1), int(alt), int(brg) % 360])
        elif q > top[-1][0]:
            top[-1] = [round(q, 3), round(d_nm, 1), int(alt), int(brg) % 360]
        else:
            return
        top.sort(key=lambda x: -x[0])

    def _close(self) -> None:
        if self.t0 is not None and self.n:
            self._closed.append(self.summary())
        self.n, self.ac, self._ant = 0, {}, None

    def tick(self, now: float) -> None:
        """Close an hour that has ended without a new position (lock held)."""
        if self.t0 is not None and now >= self.t0 + 3600 + 90:
            self._close()
            self.t0 = None

    def summary(self) -> dict:
        """The open hour so far (lock held)."""
        ant = self._ant or self.antenna()
        conf = sorted((top[CONFIRM - 1] for top in self.ac.values() if len(top) >= CONFIRM),
                      key=lambda x: -x[0])
        q = conf[1][0] if len(conf) >= 2 else None
        far = None
        if conf:
            f = conf[0]
            far = [f[0], f[1], f[2], f[3], round(f[1] - horizon_nm(f[2], ant[0]), 1)]
        return {"ts": self.t0, "n": self.n, "ac": len(self.ac),
                "n_low": sum(1 for c in conf if c[0] >= LOW_Q),
                "n_ext": sum(1 for c in conf if c[0] >= EXT_Q),
                "n_duct": sum(1 for c in conf if c[0] >= DUCT_Q),
                "q": q, "level": level_of(q), "far": far,
                "ant_ft": round(ant[0], 0), "ant_src": ant[1]}

    def take(self) -> list:
        out, self._closed = self._closed, []
        return out

    def give_back(self, rows: list) -> None:
        self._closed[:0] = rows[-48:]

    def state(self) -> dict | None:
        if self.t0 is None or not self.n:
            return None
        return {"n": self.n, "ac": self.ac, "ant": list(self._ant) if self._ant else None}

    def load(self, t0: int, st: dict) -> None:
        self.t0, self.n = int(t0), int(st.get("n") or 0)
        self.ac = {k: [list(x) for x in v][:CONFIRM] for k, v in (st.get("ac") or {}).items()}
        a = st.get("ant")
        self._ant = (float(a[0]), str(a[1])) if a else None


# ── the database (housekeeping thread / stop / start) ───────────────────────

def _write(db, key: str, s: dict, open_state=None) -> None:
    db.execute("INSERT OR REPLACE INTO horizon_hours (rx, ts, n, ac, n_low, n_ext, n_duct, q, far, ant_ft, open) "
               "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
               (key, int(s["ts"]), s["n"], s["ac"], s["n_low"], s["n_ext"], s["n_duct"], s["q"],
                json.dumps(s["far"]) if s["far"] else None, s["ant_ft"],
                json.dumps(open_state, separators=(",", ":")) if open_state else None))


def persist(db, hz: Horizon, lock) -> int:
    """Write the closed hours (one row each); a few times a day also prune."""
    with lock:
        hz.tick(time.time())
        rows = hz.take()
    if not rows:
        return 0
    try:
        ensure_table(db)
        for s in rows:
            _write(db, hz.key, s)
        db.execute("DELETE FROM horizon_hours WHERE ts < ?", (int(time.time() - KEEP_DAYS * 86400),))
        db.commit()
    except Exception:
        with lock:
            hz.give_back(rows)
        raise
    return len(rows)


def save_open(db, hz: Horizon, lock) -> None:
    """At a clean stop: the open hour with its state, so that the hour continues after the start."""
    with lock:
        st = hz.state()
        s = hz.summary() if st else None
    if not st:
        return
    ensure_table(db)
    _write(db, hz.key, s, st)
    db.commit()


def restore(db, hz: Horizon, lock) -> bool:
    """At the start: continue the open hour if it was saved at the stop."""
    try:
        ensure_table(db)
        h0 = int(time.time() // 3600) * 3600
        row = db.execute("SELECT open FROM horizon_hours WHERE rx = ? AND ts = ? AND open IS NOT NULL",
                         (hz.key, h0)).fetchone()
        db.execute("UPDATE horizon_hours SET open = NULL WHERE rx = ? AND open IS NOT NULL", (hz.key,))
        db.commit()
        if not row:
            return False
        with lock:
            hz.load(h0, json.loads(row[0]))
        return True
    except Exception as exc:                       # noqa: BLE001
        log.warning("Radio horizon: the open hour was not restored (%s)", exc)
        return False


# ── for the page ────────────────────────────────────────────────────────────

_CACHE: dict = {}


def history(db, key: str, hours: int = 168) -> list:
    """[[ts, q, level, n_low, n_ext, n_duct, far]] of the stored hours, oldest first (cached a minute)."""
    now = time.time()
    hit = _CACHE.get((key, hours))
    if hit and now - hit[0] < 60:
        return hit[1]
    out = []
    try:
        ensure_table(db)
        for ts, q, n_low, n_ext, n_duct, far in db.execute(
                "SELECT ts, q, n_low, n_ext, n_duct, far FROM horizon_hours WHERE rx = ? AND ts >= ? ORDER BY ts",
                (key or "", int(now - hours * 3600))):
            out.append([ts, q, level_of(q), n_low, n_ext, n_duct, json.loads(far) if far else None])
    except Exception as exc:                       # noqa: BLE001
        log.debug("Radio horizon history: %s", exc)
    _CACHE[(key, hours)] = (now, out)
    return out


def inversions(db, hours: int = 168) -> dict:
    """{hour: surface inversion K} from the boundary-layer hours (collector/boundary.py), cached a minute."""
    now = time.time()
    hit = _CACHE.get(("inv", hours))
    if hit and now - hit[0] < 60:
        return hit[1]
    out = {}
    try:
        for ts, data in db.execute("SELECT ts, data FROM bl_hours WHERE ts >= ? ORDER BY ts",
                                   (int(now - hours * 3600),)):
            try:
                inv = (json.loads(data) or {}).get("inv")
            except (TypeError, ValueError):
                continue
            if isinstance(inv, dict) and isinstance(inv.get("dT"), (int, float)):
                out[int(ts)] = [inv["dT"], inv.get("top")]
    except Exception as exc:                       # noqa: BLE001
        log.debug("Radio horizon: no inversion hours (%s)", exc)
    _CACHE[("inv", hours)] = (now, out)
    return out


def public(db, hz: Horizon, lock, hours: int = 168, detail: bool = True) -> dict:
    """What the Statistics page shows for one receiver."""
    with lock:
        cur = hz.summary() if hz.t0 is not None else None
    if cur:                                        # the antenna height stays on the server
        cur.pop("ant_ft", None)
        cur.pop("ant_src", None)
    out = {"now": cur, "limits": {"low": LOW_Q, "ext": EXT_Q, "duct": DUCT_Q, "confirm": CONFIRM,
                                  "min_ft": HZ_MIN_FT, "max_ft": HZ_MAX_FT},
           "levels": list(LEVELS)}
    hist = history(db, hz.key, hours) if db is not None else []
    last = hist[-1] if hist else None
    out["last"] = last
    qs = sorted(h[1] for h in hist if h[1] is not None)
    out["usual"] = round(qs[len(qs) // 2], 3) if len(qs) >= USUAL_MIN_H else None
    if detail:
        inv = inversions(db, hours) if db is not None else {}
        out["hours"] = [h[:6] + [h[6], (inv.get(h[0]) or [None])[0]] for h in hist]
        if cur and cur.get("ts") is not None:
            out["now"]["inv"] = (inv.get(cur["ts"]) or [None])[0]
    return out
