"""Own multilateration, step 1: position fixes (from 2026-11-19).

The pair recorder (collector/mlat_rec.py) hands every reply heard by two or
more receivers to this engine.  A reply heard by three or more receivers with
a known site gives a position:

  time base      the receivers with GPS time stamp in UTC; a constant per
                 receiver (cables, receiver delay) is learnt from aircraft
                 with good own positions.
  counter clock  a receiver without GPS time (12 MHz counter) is lined up
                 with a straight line (offset + drift) through the replies of
                 OTHER aircraft with good positions, −CLK_BACK … +DELAY s
                 around the reply — which is why a fix is made DELAY seconds
                 late.  Two or more other aircraft are the rule; from
                 2026-11-20 one is enough when it gives many references over
                 a long stretch (CLK1_*), with a wider timing error.  Short replies are stamped SHORT_NS apart from long
                 ones (the two receiver types stamp different ends).
  height         known: the reply's pressure altitude (or the aircraft's last
                 one) plus the GNSS − barometric difference the traffic at
                 that level reports; else QNH altitude + geoid height.
  solver         east / north by Gauss–Newton on the range differences, in a
                 local east-north-up frame; three receivers leave up to two
                 solutions.
  tracker        one hypothesis per solution, a constant-velocity filter
                 each; the wrong one is dropped when its motion does not fit
                 the speed and track the aircraft reports.  The aircraft's
                 own ADS-B position is never used for its fix — only to
                 measure the error afterwards.

Everything is kept in RAM (tracks of the last KEEP_SEC); nothing is written.
All of it runs in the recorder's thread; public() is called from the web
threads.
"""
from __future__ import annotations

import logging
import math
import threading
import time
from collections import Counter, deque
from random import random as _rnd

log = logging.getLogger("modes.mlat")

C_AIR = 299_792_458.0 / 1.0003
A_WGS = 6378137.0
E2_WGS = 6.69437999014e-3
FT = 0.3048
KT = 0.514444

DELAY        = 4.0      # s: a reply is solved this late (clock references on both sides)
CLK_BACK     = 26.0     # s of references before the reply
CLK_MIN_N    = 12       # references needed for the line …
CLK_MIN_AC   = 2        # … from this many aircraft …
CLK_MIN_SPAN = 6.0      # … spanning this many seconds
CLK_MAX_SIG  = 250.0    # ns: a worse line gives no fix
# A line from ONE other aircraft (from 2026-11-20).  In thin traffic the receiver without GPS time often
# shares a single aircraft with a good position with the others: in the 07 UTC hour of 20 Nov 43 % of the
# attempts had no line, and in 70 % of those there were plenty of references, but all of one aircraft.
# Measured on two busy hours against the line of all the OTHER aircraft (56 700 comparisons, 58
# aircraft): under these conditions a one-aircraft line lies within 24 ns in half, 38 ns in 68 %, 76 ns
# in 90 % and 179 ns in 99 % of the cases; the lines that fail them within 92 / 194 / 1 067 ns (50 / 68 /
# 90 %).  Replayed on four thin hours: 34 % more fixes, the gained ones as close to the aircraft's own
# positions as the others within 40 NM (median 40 m, 90 % 199 m within 20 NM).
CLK1_MIN_N    = 60      # references of that one aircraft …
CLK1_MIN_SPAN = 15.0    # … spanning this many seconds …
CLK1_MAX_SIG  = 100.0   # … and scattered no more than this (ns)
CLK1_ADD_NS   = 40.0    # added to the receiver's timing error in such a fix (1 sigma)
CLK_BIN_MAX  = 40       # references kept per second
SHORT_NS     = 56_000   # counter receivers: stamp of a 56-bit reply minus this
GOOD_NACP, GOOD_NIC = 8, 7
BIAS_SEC     = 600.0    # a GPS receiver's constant: median over this long …
BIAS_MIN_N   = 15       # … of the medians of the aircraft with this many replies (each aircraft counts once)
BIAS_EVERY   = 10.0     # s between recalculations
POS_MAX_AGE  = 3.0      # s: own position used as a reference
POS_LATENCY  = 0.09     # s: age of a broadcast position when sent
SIG_GPS_NS   = 25.0     # timing error of a GPS-timed receiver (measured 19 Nov 2026: about 23 ns)
SIG_CNT_NS   = 60.0     # … of a counter receiver with its line
MAX_RANGE_M  = 400e3    # solutions farther from the airport are dropped
SOLVES_PER_S = 3        # per aircraft
GATE_M       = 1500.0   # a fix belongs to a track within this + GATE_MPS × dt
GATE_MPS     = 150.0
GATE_SIGMA   = 4.0      # … or this many times the fix's expected error
# The stated error of a fix has a floor (from 2026-11-20).  expected_error() knows the timing errors only;
# near the receivers those give 20-30 m, while the fixes there are 40-45 m from the aircraft's own positions:
# within 10 NM only 23 % of the resolved fixes lay inside their stated error, beyond 20 NM 60-63 % (about two
# thirds is right for a 1-sigma radial error).  With 35 m added in quadrature it is 51 % within 10 NM, 67 % at
# 10-20 NM and 62 % overall (40 m fitted best; part of that is the error of the broadcast position itself).
# Only the value that is reported and stored: the gates and the choice between two solutions use the plain
# value, and a replay of 182 000 fixes gave the same fixes with and without it.
EXP_FLOOR_M  = 35.0
MAX_EXP_M    = 2500.0   # a fix expected to be worse than this is not made (poor geometry)
MERGE_M      = 400.0    # two hypotheses this close are one
HYP_DROP_SEC = 30.0     # a hypothesis without a fix for this long is dropped
RES_MIN_N    = 6        # fixes and seconds before a hypothesis is judged by its motion
RES_MIN_SEC  = 12.0
RES_OK_MPS   = 25.0     # motion fits the reported speed / track within this …
RES_SEP_MPS  = 30.0     # … and the other hypothesis is this much worse
VEL_FRESH    = 15.0     # s: reported speed / track used
SINGLE_OK_SEC = 60.0    # a single hypothesis this old counts as the position without a motion check
# The tracker of 2026-11-20 (afternoon).  On the morning of 20 Nov one aircraft was held on the wrong one of
# the two solutions for a minute and a half and shown as resolved; the trace showed three gaps, closed here:
# (1) a resolved track stayed resolved while its motion disagreed with the reported one by 30-70 m/s (only
#     above 3 x RES_OK_MPS was it dropped)                                   -> RES_DOUBT_MPS
# (2) while a track got fixes, the other solution was never looked for again -> REINIT_DOUBT
# (3) where the two solutions cross, the single fixes are poor (1 km and more) and the track's own velocity
#     swung by 100 m/s from fix to fix, so the next fix was looked for in the wrong place -> the filter (KF_*)
# and a track that had been silent for HYP_DROP_SEC was picked up again by the next fix and, being old,
# counted as resolved without a motion check                                -> STALE_DROP
# Replayed on 13 hours of 19-20 Nov (busy and thin; 115 000 resolved fixes of aircraft with a good own
# position): resolved fixes more than 3 km off 1.06 -> 0.15 %, more than 10 km 0.04 -> 0.01 %; track error in
# the map's default view 47 / 343 / 1 417 m (median / 90 / 99 %) -> 38 / 193 / 612 m; median by distance
# 35 / 32 / 92 / 463 m -> 37 / 27 / 57 / 203 m (0-10 / 10-20 / 20-40 / 40-80 NM).  The price: 5 % fewer fixes
# count as resolved (unresolved share 19.7 -> 25.6 %).
RES_DOUBT_MPS = 40.0    # a resolved track whose motion is this far from the reported one is unresolved again (0 = off)
REINIT_DOUBT  = True    # … and the other solutions are looked for again
RES_MIN_JUDGED = 6      # both hypotheses must have been compared with the reported motion this often before one is chosen
STALE_DROP   = True     # a hypothesis silent for HYP_DROP_SEC is dropped before the next fix, not revived by it
KF_ON        = True     # the track is a filter (position and velocity) that weighs each fix by its error ellipse
KF_ACC       = 2.0      # m/s²: how hard an aircraft may accelerate or turn between fixes (process noise)
KF_R_SCALE   = 1.5      # the fixes of one second share their clock errors: their stated error counts this many times
KF_VEL_SIG   = 20.0     # m/s per axis: the reported speed / track as a measurement of the track's velocity (0 = not
                        # used; 12 smooths more — 36 / 167 / 547 m — but holds a wrong track longer: 0.22 % beyond 3 km)
KF_VEL_AGE   = 6.0      # s: … when it is at most this old
# The 24-hour replay of the map (from 2026-11-20): one point of each aircraft's shown track every REPLAY_STEP
# seconds is handed to the recorder, which stores it in data/mlat.db (collector/mlat_rec.py, table mlat_trk)
REPLAY_STEP  = 2.0
REPLAY_BUF   = 30000    # points held if the recorder does not fetch them (about half an hour of busy traffic)
TRACK_STEP   = 2.0      # s between stored track points
KEEP_SEC     = 3600.0   # tracks kept
STAT_SEC     = 600.0    # window of the error statistics
GMB_BAND_FT  = 2000
GMB_KEEP_SEC = 1800.0
GEOID_M      = 18.0     # geoid above the ellipsoid in southern Finland (fallback height)
BANDS_NM     = (10, 20, 40, 80)


def ecef(lat, lon, h):
    la, lo = math.radians(lat), math.radians(lon)
    s, c = math.sin(la), math.cos(la)
    n = A_WGS / math.sqrt(1.0 - E2_WGS * s * s)
    return ((n + h) * c * math.cos(lo), (n + h) * c * math.sin(lo), (n * (1.0 - E2_WGS) + h) * s)


def _med(v):
    s = sorted(v)
    n = len(s)
    return None if not n else (s[n // 2] if n % 2 else 0.5 * (s[n // 2 - 1] + s[n // 2]))


def _pct(s, q):
    return None if not s else s[min(len(s) - 1, int(q * len(s)))]


class Frame:
    """Local east-north-up frame at (lat0, lon0, 0 m)."""

    def __init__(self, lat0: float, lon0: float) -> None:
        self.lat0, self.lon0 = lat0, lon0
        la, lo = math.radians(lat0), math.radians(lon0)
        sl, cl, so, co = math.sin(la), math.cos(la), math.sin(lo), math.cos(lo)
        self.o = ecef(lat0, lon0, 0.0)
        self.e = (-so, co, 0.0)
        self.n = (-sl * co, -sl * so, cl)
        self.u = (cl * co, cl * so, sl)
        w = math.sqrt(1.0 - E2_WGS * sl * sl)
        m_r, n_r = A_WGS * (1.0 - E2_WGS) / w ** 3, A_WGS / w
        self.r = math.sqrt(m_r * n_r)              # radius of the height surface

    def enu(self, lat, lon, h):
        x, y, z = ecef(lat, lon, h)
        dx, dy, dz = x - self.o[0], y - self.o[1], z - self.o[2]
        return (dx * self.e[0] + dy * self.e[1],
                dx * self.n[0] + dy * self.n[1] + dz * self.n[2],
                dx * self.u[0] + dy * self.u[1] + dz * self.u[2])

    def up(self, e, n, h):
        """Up coordinate of the point at height h above the ellipsoid."""
        return h - (e * e + n * n) / (2.0 * (self.r + h))

    def enu_xyz(self, x, y, z):
        dx, dy, dz = x - self.o[0], y - self.o[1], z - self.o[2]
        return (dx * self.e[0] + dy * self.e[1],
                dx * self.n[0] + dy * self.n[1] + dz * self.n[2],
                dx * self.u[0] + dy * self.u[1] + dz * self.u[2])

    def ll(self, e, n, h):
        z = self.up(e, n, h)
        x = self.o[0] + e * self.e[0] + n * self.n[0] + z * self.u[0]
        y = self.o[1] + e * self.e[1] + n * self.n[1] + z * self.u[1]
        zz = self.o[2] + n * self.n[2] + z * self.u[2]
        lon = math.atan2(y, x)
        p = math.hypot(x, y)
        lat = math.atan2(zz, p * (1.0 - E2_WGS))
        for _ in range(4):
            s = math.sin(lat)
            nn = A_WGS / math.sqrt(1.0 - E2_WGS * s * s)
            lat = math.atan2(zz + E2_WGS * nn * s, p)
        return math.degrees(lat), math.degrees(lon)


def solve(fr: Frame, rx: list, h: float, e: float, n: float, iters: int = 12):
    """Gauss–Newton for (e, n) at height h.  rx: [(x, y, z, range difference to
    rx[0] in m, weight)], rx[0] the reference.  → (e, n, rms residual m) or None."""
    x0, y0, z0 = rx[0][0], rx[0][1], rx[0][2]
    rr = fr.r + h
    for _ in range(iters):
        z = h - (e * e + n * n) / (2.0 * rr)
        dze, dzn = -e / rr, -n / rr
        ax, ay, az = e - x0, n - y0, z - z0
        d0 = math.sqrt(ax * ax + ay * ay + az * az) or 1.0
        g0e, g0n = (ax + az * dze) / d0, (ay + az * dzn) / d0
        a11 = a12 = a22 = b1 = b2 = 0.0
        ss = 0.0
        for x, y, zr, dr, w in rx[1:]:
            bx, by, bz = e - x, n - y, z - zr
            d = math.sqrt(bx * bx + by * by + bz * bz) or 1.0
            f = (d - d0) - dr
            je, jn = (bx + bz * dze) / d - g0e, (by + bz * dzn) / d - g0n
            a11 += w * je * je
            a12 += w * je * jn
            a22 += w * jn * jn
            b1 += w * je * f
            b2 += w * jn * f
            ss += f * f
        det = a11 * a22 - a12 * a12
        if abs(det) < 1e-18:
            return None
        de, dn = -(a22 * b1 - a12 * b2) / det, -(a11 * b2 - a12 * b1) / det
        st = math.hypot(de, dn)
        if st > 50e3:
            de, dn = de * 50e3 / st, dn * 50e3 / st
        e += de
        n += dn
        if st < 0.5:
            return e, n, math.sqrt(ss / max(1, len(rx) - 1))
    return None


def expected_error(fr: Frame, rx: list, h: float, e: float, n: float):
    """1-sigma horizontal error (m) of a fix at (e, n): rx = [(x, y, z, sigma m of
    the range difference to rx[0])], rx[0] the reference."""
    rr = fr.r + h
    z = h - (e * e + n * n) / (2.0 * rr)
    dze, dzn = -e / rr, -n / rr
    ax, ay, az = e - rx[0][0], n - rx[0][1], z - rx[0][2]
    d0 = math.sqrt(ax * ax + ay * ay + az * az) or 1.0
    g0e, g0n = (ax + az * dze) / d0, (ay + az * dzn) / d0
    a11 = a12 = a22 = 0.0
    for x, y, zr, sg in rx[1:]:
        bx, by, bz = e - x, n - y, z - zr
        d = math.sqrt(bx * bx + by * by + bz * bz) or 1.0
        je, jn = (bx + bz * dze) / d - g0e, (by + bz * dzn) / d - g0n
        w = 1.0 / (sg * sg)
        a11 += w * je * je
        a12 += w * je * jn
        a22 += w * jn * jn
    det = a11 * a22 - a12 * a12
    if det <= 1e-30:
        return None
    return math.sqrt((a11 + a22) / det)


def fix_cov(fr: Frame, rx: list, h: float, e: float, n: float):
    """Covariance (m², east-east, east-north, north-north) of a fix at (e, n); rx as in expected_error."""
    rr = fr.r + h
    z = h - (e * e + n * n) / (2.0 * rr)
    dze, dzn = -e / rr, -n / rr
    ax, ay, az = e - rx[0][0], n - rx[0][1], z - rx[0][2]
    d0 = math.sqrt(ax * ax + ay * ay + az * az) or 1.0
    g0e, g0n = (ax + az * dze) / d0, (ay + az * dzn) / d0
    a11 = a12 = a22 = 0.0
    for x, y, zr, sg in rx[1:]:
        bx, by, bz = e - x, n - y, z - zr
        d = math.sqrt(bx * bx + by * by + bz * bz) or 1.0
        je, jn = (bx + bz * dze) / d - g0e, (by + bz * dzn) / d - g0n
        w = 1.0 / (sg * sg)
        a11 += w * je * je
        a12 += w * je * jn
        a22 += w * jn * jn
    det = a11 * a22 - a12 * a12
    if det <= 1e-30:
        return None
    return a22 / det, -a12 / det, a11 / det


def _kf_predict(x: list, P: list, dt: float, acc: float) -> None:
    """Constant velocity over dt, in place.  x = [e, n, ve, vn], P = 4 x 4 (lists)."""
    x[0] += x[2] * dt
    x[1] += x[3] * dt
    for i in (0, 1):                               # P = F P F'
        j = i + 2
        for k in range(4):
            P[i][k] += dt * P[j][k]
        for k in range(4):
            P[k][i] += dt * P[k][j]
    q = acc * acc
    q4, q3, q2 = q * dt ** 4 / 4.0, q * dt ** 3 / 2.0, q * dt * dt
    for i in (0, 1):
        j = i + 2
        P[i][i] += q4
        P[i][j] += q3
        P[j][i] += q3
        P[j][j] += q2


def _kf_update(x: list, P: list, i0: int, z0: float, z1: float, r11: float, r12: float, r22: float):
    """A two-dimensional measurement of the state's elements i0, i0 + 1 with covariance r; in place.
    Returns the squared normalised innovation (how many sigmas the measurement lay off, squared)."""
    i1 = i0 + 1
    y0, y1 = z0 - x[i0], z1 - x[i1]
    s11, s12, s22 = P[i0][i0] + r11, P[i0][i1] + r12, P[i1][i1] + r22
    det = s11 * s22 - s12 * s12
    if det <= 0.0:
        return None
    v11, v12, v22 = s22 / det, -s12 / det, s11 / det
    nis = y0 * (v11 * y0 + v12 * y1) + y1 * (v12 * y0 + v22 * y1)
    K = [(P[k][i0] * v11 + P[k][i1] * v12, P[k][i0] * v12 + P[k][i1] * v22) for k in range(4)]
    for k in range(4):
        x[k] += K[k][0] * y0 + K[k][1] * y1
    r0, r1 = P[i0][:], P[i1][:]
    for k in range(4):
        for m in range(4):
            P[k][m] -= K[k][0] * r0[m] + K[k][1] * r1[m]
    for k in range(4):                             # keep it symmetric
        for m in range(k + 1, 4):
            P[k][m] = P[m][k] = 0.5 * (P[k][m] + P[m][k])
    return nis


_STARTS = [(0.0, 0.0)] + [(r * math.sin(math.radians(b)), r * math.cos(math.radians(b)))
                          for r in (20e3, 60e3, 120e3, 200e3, 300e3) for b in range(0, 360, 45)]


# ── statistics of the fixes (from 2026-11-19, the MLAT tab's Charts view) ───
STAT_BANDS  = (10, 20, 40, 80)          # NM from the airport → 5 bands
ALT_BANDS   = (5000, 15000, 30000)      # ft → 4 bands
GRID_LAT, GRID_LON = 0.05, 0.10         # the accuracy grid's cell (about 5.5 km)
MIN_KEEP    = 1500                      # minutes kept in RAM (25 h)
HOUR_KEEP   = 24 * 8                    # hours kept in RAM (8 d)
GRID_HOURS  = (1, 3, 6, 12, 24, 168)    # the periods the map's accuracy grid can be asked for (/api/mlat/grid)
NEAR_NM     = 10.0                      # "lowest fix near the airport"


def _band(v: float, edges: tuple) -> int:
    for i, e in enumerate(edges):
        if v < e:
            return i
    return len(edges)


class _Acc:
    """One period (a minute or an hour) of fix statistics."""

    def __init__(self, t0: int, cap: int, grid: bool) -> None:
        self.t0, self.cap = t0, cap
        self.c = Counter()
        nb = len(STAT_BANDS) + 1
        self.raw = [[] for _ in range(nb)]         # single-fix error m, resolved fixes with an own position
        self.trk = [[] for _ in range(nb)]         # … of the smoothed track
        self.exp = [[] for _ in range(nb)]         # expected error of the same fixes
        self.nseen = [0] * nb
        self.ac, self.nopos = set(), set()
        na = len(ALT_BANDS) + 1
        self.heard = [set() for _ in range(na)]
        self.fixed = [set() for _ in range(na)]
        self.clock: list = []                      # (sigma ns, drift ns/s, replies, aircraft)
        self.rs: list = []                         # seconds from a hypothesis' first fix to its confirmation
        self.gb: dict = {}                         # GPS receiver id → [(constant ns against the main one, aircraft)]
        self.low = None
        self.grid: dict | None = {} if grid else None

    def _res(self, lst: list, n: int, v) -> None:
        if len(lst) < self.cap:
            lst.append(v)
        else:
            k = int(_rnd() * n)
            if k < self.cap:
                lst[k] = v

    def fix(self, icao, pos, amb, alt, dist_nm, exp, err_raw, err_trk, lat, lon) -> None:
        self.c["fx"] += 1
        self.ac.add(icao)
        if not pos:
            self.nopos.add(icao)
        if amb:
            self.c["am"] += 1
            return
        self.fixed[_band(alt, ALT_BANDS)].add(icao)
        if self.grid is not None:
            key = "%d,%d" % (math.floor(lat / GRID_LAT), math.floor(lon / GRID_LON))
            g = self.grid.get(key)
            if g is None:
                g = self.grid[key] = [0, []]
            g[0] += 1
            if err_raw is not None and len(g[1]) < 40:
                g[1].append(int(err_raw))
        if err_raw is None or dist_nm is None:
            return
        b = _band(dist_nm, STAT_BANDS)
        self.nseen[b] += 1
        n = self.nseen[b]
        self._res(self.raw[b], n, err_raw)
        if len(self.trk[b]) < self.cap:
            self.trk[b].append(err_trk)
            self.exp[b].append(exp if exp is not None else 0.0)
        if dist_nm < NEAR_NM and (self.low is None or alt < self.low):
            self.low = alt

    def close(self) -> dict:
        def st(v):
            if not v:
                return None
            v = sorted(v)
            return int(v[len(v) // 2])
        def p90(v):
            if not v:
                return None
            v = sorted(v)
            return int(v[min(len(v) - 1, int(0.9 * len(v)))])
        c = self.c
        out = {"t": self.t0, "h3": c["h3"], "tr": c["tr"], "fx": c["fx"], "am": c["am"], "nc": c["nc"],
               "b": [[self.nseen[i], st(self.raw[i]), p90(self.raw[i]), st(self.exp[i]), st(self.trk[i])]
                     for i in range(len(self.raw))],
               "ac": len(self.ac), "np": len(self.nopos),
               "cov": [[len(self.heard[i]), len(self.fixed[i] & self.heard[i]) if self.heard[i] else len(self.fixed[i])]
                       for i in range(len(self.heard))],
               "low": self.low}
        near = self.raw[0] + self.raw[1]
        out["e20"] = [self.nseen[0] + self.nseen[1], st(near), p90(near)]
        out["e40"] = [self.nseen[2], st(self.raw[2]), p90(self.raw[2])]
        if self.clock:
            out["ck"] = [round(_med([x[0] for x in self.clock]), 1), round(_med([x[1] for x in self.clock]), 2),
                         int(_med([x[2] for x in self.clock])), int(_med([x[3] for x in self.clock]))]
        if self.rs:
            out["rs"] = [len(self.rs), int(_med(self.rs))]
        if self.gb:                                # [median, aircraft, lowest, highest] of the period's values
            out["gb"] = {k: [round(_med([x[0] for x in v]), 1), int(_med([x[1] for x in v])),
                             round(min(x[0] for x in v), 1), round(max(x[0] for x in v), 1)]
                         for k, v in self.gb.items() if v}
        if self.grid is not None:
            out["grid"] = {k: [g[0], st(g[1]), len(g[1])] for k, g in self.grid.items()}
        return out


def combine(recs: list, t0: int | None = None) -> dict:
    """Several closed periods as one (sums; medians as the count-weighted median of the periods' medians)."""
    def wmed(pairs):
        pairs = sorted((v, n) for v, n in pairs if v is not None and n)
        tot = sum(n for _, n in pairs)
        if not tot:
            return None
        acc = 0
        for v, n in pairs:
            acc += n
            if acc * 2 >= tot:
                return v
        return pairs[-1][0]
    if not recs:
        return {}
    out = {"t": t0 if t0 is not None else recs[0]["t"]}
    for k in ("h3", "tr", "fx", "am", "nc"):
        out[k] = sum(r.get(k, 0) for r in recs)
    nb = len(recs[0]["b"])
    out["b"] = [[sum(r["b"][i][0] for r in recs)] + [wmed([(r["b"][i][j], r["b"][i][0]) for r in recs]) for j in (1, 2, 3, 4)]
                for i in range(nb)]
    for k in ("e20", "e40"):
        out[k] = [sum(r[k][0] for r in recs), wmed([(r[k][1], r[k][0]) for r in recs]), wmed([(r[k][2], r[k][0]) for r in recs])]
    out["ac"] = max(r.get("ac", 0) for r in recs)
    out["np"] = max(r.get("np", 0) for r in recs)
    # aircraft heard / with a resolved fix, summed over the periods (aircraft × periods): for the share
    out["cov"] = [[sum(r["cov"][i][0] for r in recs), sum(r["cov"][i][1] for r in recs)] for i in range(len(recs[0]["cov"]))]
    out["n"] = len(recs)
    lows = [r["low"] for r in recs if r.get("low") is not None]
    out["low"] = min(lows) if lows else None
    cks = [r["ck"] for r in recs if r.get("ck")]
    if cks:
        out["ck"] = [round(_med([c[0] for c in cks]), 1), round(_med([c[1] for c in cks]), 2),
                     int(_med([c[2] for c in cks])), int(_med([c[3] for c in cks]))]
    rss = [r["rs"] for r in recs if r.get("rs")]
    if rss:
        out["rs"] = [sum(x[0] for x in rss), wmed([(x[1], x[0]) for x in rss])]
    gbs: dict = {}
    for r in recs:
        for k, v in (r.get("gb") or {}).items():
            gbs.setdefault(k, []).append(v)
    if gbs:
        out["gb"] = {k: [round(_med([x[0] for x in v]), 1), int(_med([x[1] for x in v])),
                         round(min(x[2] for x in v), 1), round(max(x[3] for x in v), 1)] for k, v in gbs.items()}
    return out


def merge_grids(recs: list) -> dict:
    cells: dict = {}
    for r in recs:
        for k, g in (r.get("grid") or {}).items():
            c = cells.setdefault(k, [0, []])
            c[0] += g[0]
            if g[1] is not None and g[2]:
                c[1].append((g[1], g[2]))
    out = {}
    for k, (n, meds) in cells.items():
        meds.sort()
        tot = sum(w for _, w in meds)
        med = None
        acc = 0
        for v, w in meds:
            acc += w
            if acc * 2 >= tot:
                med = v
                break
        out[k] = [n, med, tot]
    return out


class Fixer:
    def __init__(self, cfg, gps_bits: dict, counter_bits: dict, live_state: dict) -> None:
        """gps_bits / counter_bits: bit → receiver (.id, .hz).

        MLAT_FIX_RX (from 2026-11-20 evening): the ids of the receivers the fixes are computed with.
        A receiver that is connected but not in the list is left out of everything here — its
        stamps are still recorded by the pair recorder, so a new receiver can be tried on the
        recording before it joins the live calculation.  Without the setting every receiver is
        used, as before.  (A receiver with GPS time gets its place from its own GPS when
        MLAT_SITES has none, so without this list it would join the moment it is connected.)"""
        self.cfg = cfg
        self.live = live_state
        self.rec_only: dict = {}                   # bit → id of the receivers left out by MLAT_FIX_RX
        self.use_why: str | None = None
        use = getattr(cfg, "MLAT_FIX_RX", None)
        if use:
            use = {str(x).strip() for x in ([use] if isinstance(use, str) else use)}
            every = dict(list(gps_bits.items()) + list(counter_bits.items()))
            self.rec_only = {b: r.id for b, r in every.items() if r.id not in use}
            unknown = sorted(use - {r.id for r in every.values()})
            if unknown:
                log.warning("MLAT_FIX_RX names receivers that are not connected: %s", ", ".join(unknown))
            gps_bits = {b: r for b, r in gps_bits.items() if r.id in use}
            counter_bits = {b: r for b, r in counter_bits.items() if r.id in use}
            if self.rec_only:
                log.info("MLAT fixes: %s recorded only (not in MLAT_FIX_RX)", ", ".join(sorted(self.rec_only.values())))
            if len(gps_bits) + len(counter_bits) < 3:
                self.use_why = "MLAT_FIX_RX leaves fewer than three connected receivers" + (
                    " (not connected: " + ", ".join(unknown) + ")" if unknown else "")
                log.warning("MLAT fixes: %s — no fixes", self.use_why)
        self.gps = dict(gps_bits)
        self.cnt = dict(counter_bits)
        self.names = {b: r.id for b, r in list(self.gps.items()) + list(self.cnt.items())}
        self.hz = {b: float(r.hz) for b, r in self.cnt.items()}
        self.fr = Frame(float(cfg.WINDSHEAR_AIRPORT_LAT), float(cfg.WINDSHEAR_AIRPORT_LON))
        self.cfg_sites = dict(getattr(cfg, "MLAT_SITES", None) or {})
        sh = getattr(cfg, "MLAT_SHORT_NS", None) or {}
        self.short = {b: int(sh.get(r.id, SHORT_NS)) for b, r in self.cnt.items()}
        self.site: dict = {}                       # bit → (x, y, z) in the frame
        self.why_site: dict = {}
        self.qnh_fn = None                         # callable() → QNH hPa | None (run.py)
        self.rp: list = []                         # track points for the replay store (take_replay)
        self.blocked_reg = tuple(getattr(cfg, "BLOCKED_REG_PREFIXES", ()) or ())
        self.main = min(self.gps) if self.gps else None
        self.bias: dict = {b: 0.0 for b in self.gps}       # ns, GPS receiver against the main one
        self._bias_ac: dict = {b: {} for b in self.gps}    # bit → {icao: deque[(t, residual ns)]}
        self._bias_t: dict = {b: 0.0 for b in self.gps}
        self.bias_n: dict = {b: 0 for b in self.gps}       # aircraft behind the constant
        self.refs: dict = {b: {} for b in self.cnt}        # bit → {second: [(t, o, icao)]}
        self.base: dict = {}                               # bit → integer ns base of the offsets
        self.clk: dict = {}                                # bit → last line {"t", "n", "ac", "sig", "drift"}
        self._fit_cache: dict = {}
        self.pending: deque = deque()
        self.now = 0.0
        self.gmb: dict = {}                        # band → [value ft, t]
        self.ac: dict = {}                         # icao → aircraft state
        self.c = Counter()
        self.stat: deque = deque()                 # (t, dist NM, raw error m, track error m)
        self.cpu = 0.0
        # statistics: the open minute and hour, the closed ones (also loaded from / stored to
        # mlat.db by the recorder), and a sample of where the fixes lie from the own positions
        self.acc_m: _Acc | None = None
        self.acc_h: _Acc | None = None
        self.minutes: deque = deque(maxlen=MIN_KEEP)
        self.hours: deque = deque(maxlen=HOUR_KEEP)
        self._out: list = []                       # ("min" | "hour", record) waiting to be stored
        self.scatter: deque = deque(maxlen=4000)   # (t, along m, across m, dist NM)
        self.t_start = time.monotonic()
        self._lock = threading.Lock()
        for b, r in self.cnt.items():
            self._cfg_site(b, r.id)

    # ── sites ────────────────────────────────────────────────────────────
    def _cfg_site(self, bit: int, rid: str) -> None:
        cs = self.cfg_sites.get(rid)
        try:
            la, lo, h = float(cs[0]), float(cs[1]), float(cs[2])
        except Exception:                          # noqa: BLE001
            self.why_site[bit] = "no MLAT_SITES entry with a height for " + rid
            return
        self.site[bit] = self.fr.enu(la, lo, h)
        self.why_site.pop(bit, None)

    def set_gps_site(self, bit: int, lat: float, lon: float, h: float) -> None:
        """From the recorder, once a minute (configured place or GPS mean)."""
        self.site[bit] = self.fr.enu(lat, lon, h)

    # ── helpers ──────────────────────────────────────────────────────────
    @staticmethod
    def _gps_abs(t: float, ticks: int) -> int:
        """Absolute ns of a GPS stamp (second of the UTC day << 30 | ns)."""
        ns = (ticks >> 30) * 1_000_000_000 + (ticks & 0x3FFFFFFF)
        day = int((t - ns / 1e9 + 43200.0) // 86400.0)
        return day * 86_400_000_000_000 + ns

    def _truth(self, ls: dict, t: float):
        """(e, n, z, lat, lon) of the aircraft from its own ADS-B position at t, or None."""
        lat, lon, pts, alt = ls.get("adsb_lat"), ls.get("adsb_lon"), ls.get("last_adsb_pos_ts"), ls.get("altitude")
        if lat is None or lon is None or pts is None or alt is None:
            return None
        dt = t - pts
        if abs(dt) > POS_MAX_AGE:
            return None
        gs, trk = ls.get("groundspeed"), ls.get("track")
        dt += POS_LATENCY
        if gs is not None and trk is not None:
            d = float(gs) * KT * dt
            tr = math.radians(float(trk))
            lat = lat + math.degrees(d * math.cos(tr) / 6.38e6)
            lon = lon + math.degrees(d * math.sin(tr) / (6.39e6 * math.cos(math.radians(lat))))
        gmb = ls.get("geo_minus_baro")
        if isinstance(gmb, (int, float)) and abs(gmb) < 3000:
            h = (float(alt) + float(gmb)) * FT
        else:
            h = self._height(float(alt), t)
            if h is None:
                return None
        e, n, z = self.fr.enu(lat, lon, h)
        return e, n, z, lat, lon

    def _height(self, alt_ft: float, t: float):
        """Height above the ellipsoid (m) of a pressure altitude."""
        b = int(alt_ft // GMB_BAND_FT)
        best = None
        for k in (b, b - 1, b + 1, b - 2, b + 2, b - 3, b + 3):
            g = self.gmb.get(k)
            if g and t - g[1] <= GMB_KEEP_SEC:
                best = g[0]
                break
        if best is not None:
            return (alt_ft + best) * FT
        q = None
        if self.qnh_fn is not None:
            try:
                q = self.qnh_fn()
            except Exception:                      # noqa: BLE001
                q = None
        if q is None:
            return None
        return (alt_ft - (1013.25 - float(q)) * 27.3) * FT + GEOID_M

    @staticmethod
    def _good(ls: dict) -> bool:
        a, b = ls.get("nac_p"), ls.get("nic")
        return a is not None and b is not None and a >= GOOD_NACP and b >= GOOD_NIC

    # ── input (recorder thread) ──────────────────────────────────────────
    def feed(self, t: float, nbytes: int, icao: str, st: list, ls: dict) -> None:
        """One reply: st = [(bit, ticks, signal)] of every receiver that heard it."""
        t0c = time.perf_counter()
        self.now = max(self.now, t)
        arr = {}
        for bit, ticks, _ in st:
            if bit in self.gps:
                arr[bit] = self._gps_abs(t, ticks)
            elif bit in self.cnt:
                ns = int(ticks * 1_000_000_000 // int(self.hz[bit]))
                if nbytes == 7:
                    ns -= self.short[bit]
                arr[bit] = ns
        gbits = [b for b in arr if b in self.gps and b in self.site]
        cbits = [b for b in arr if b in self.cnt and b in self.site]
        if gbits:
            tr = None
            if self._good(ls):
                tr = self._truth(ls, t)
            if tr is not None:
                self._reference(t, icao, arr, gbits, cbits, tr, ls)
            self._roll(t)
            al = ls.get("altitude")
            if al is not None:
                ab = _band(al, ALT_BANDS)
                self.acc_m.heard[ab].add(icao)
                self.acc_h.heard[ab].add(icao)
            if len(gbits) + len(cbits) >= 3:
                self.c["heard3"] += 1
                self.acc_m.c["h3"] += 1
                self.acc_h.c["h3"] += 1
                self.pending.append((t, icao, arr, gbits, cbits, ls.get("altitude"), ls))
        self._process()
        self.cpu += time.perf_counter() - t0c

    def _roll(self, t: float) -> None:
        """Close the minute / the hour when the time has moved on."""
        m0 = int(t // 60) * 60
        if self.acc_m is None:
            self.acc_m = _Acc(m0, 300, False)
            self.acc_h = _Acc(int(t // 3600) * 3600, 3000, True)
            return
        if m0 > self.acc_m.t0:
            rec = self.acc_m.close()
            with self._lock:
                self.minutes.append(rec)
                self._out.append(("min", rec))
            self.acc_m = _Acc(m0, 300, False)
            h0 = int(t // 3600) * 3600
            if h0 > self.acc_h.t0:
                rec = self.acc_h.close()
                with self._lock:
                    self.hours.append(rec)
                    self._out.append(("hour", rec))
                self.acc_h = _Acc(h0, 3000, True)

    def take_replay(self) -> list:
        """The track points gathered for the replay store since the last call: (t, icao, lat, lon, alt ft,
        stated error m, unresolved, distance from the own position m, own lat, own lon, our speed kt, our track °,
        selected altitude ft, callsign, type, has a position of its own)."""
        with self._lock:
            out, self.rp = self.rp, []
        return out

    def take(self) -> list:
        """The closed minutes / hours not yet stored (the recorder writes them to mlat.db)."""
        with self._lock:
            out, self._out = self._out, []
        return out

    def _reference(self, t, icao, arr, gbits, cbits, tr, ls) -> None:
        e, n, z = tr[0], tr[1], tr[2]
        rng = {}
        for b in gbits + cbits:
            s = self.site[b]
            rng[b] = math.sqrt((e - s[0]) ** 2 + (n - s[1]) ** 2 + (z - s[2]) ** 2)
        m = self.main
        # the constant of each GPS receiver against the main one
        if m in arr and m in rng:
            for b in gbits:
                if b != m:
                    r = (arr[b] - arr[m]) - (rng[b] - rng[m]) / C_AIR * 1e9
                    if abs(r) < 2000:
                        dq = self._bias_ac[b].get(icao)
                        if dq is None:
                            dq = self._bias_ac[b][icao] = deque()
                        if not dq or t - dq[-1][0] >= 0.5:
                            dq.append((t, r))
                        if t - self._bias_t[b] >= BIAS_EVERY:
                            self._bias_t[b] = t
                            self._bias_update(b, t)
        # the counter receivers' offset against GPS time
        g = m if m in rng else gbits[0]
        for b in cbits:
            base = self.base.get(b)
            raw = arr[b] - arr[g]
            if base is None:
                base = self.base[b] = raw
            o = (raw - base) + self.bias.get(g, 0.0) + (rng[g] - rng[b]) / C_AIR * 1e9
            sec = int(t)
            bins = self.refs[b]
            lst = bins.get(sec)
            if lst is None:
                lst = bins[sec] = []
                for k in [k for k in bins if k < sec - 90]:
                    del bins[k]
            if len(lst) < CLK_BIN_MAX:
                lst.append((t, o, icao))
        # the height difference GNSS − barometric of the traffic, by level
        gmb, alt = ls.get("geo_minus_baro"), ls.get("altitude")
        if isinstance(gmb, (int, float)) and abs(gmb) < 3000 and alt is not None:
            k = int(float(alt) // GMB_BAND_FT)
            g0 = self.gmb.get(k)
            if g0 is None or t - g0[1] > GMB_KEEP_SEC:
                self.gmb[k] = [float(gmb), t]
            else:
                g0[0] += 0.05 * (float(gmb) - g0[0])
                g0[1] = t

    def _bias_update(self, bit: int, t: float) -> None:
        """The constant of a GPS receiver against the main one: every aircraft
        with a good position counts once (the median of its residuals of the
        last BIAS_SEC), the constant is the median of the aircraft — one
        aircraft whose position is a little off cannot pull it.  (Leaving the
        aircraft far from it out of the references was tried on the recording
        of 19 Nov 2026 and made the fixes worse — not done.)"""
        meds = {}
        allr = []
        acs = self._bias_ac[bit]
        for ic in list(acs):
            dq = acs[ic]
            while dq and t - dq[0][0] > BIAS_SEC:
                dq.popleft()
            if not dq:
                del acs[ic]
                continue
            allr.extend(x[1] for x in dq)
            if len(dq) >= BIAS_MIN_N:
                meds[ic] = _med([x[1] for x in dq])
        if meds:
            c = _med(list(meds.values()))
        elif len(allr) >= 30:
            c = _med(allr)
        else:
            return
        self.bias[bit] = c
        self.bias_n[bit] = len(meds)
        # for the Charts view: the constant over time shows how steady the receivers' GPS time is
        # (from 2026-11-20; only values that rest on at least three aircraft)
        if len(meds) >= 3 and self.acc_m is not None:
            rid = self.names.get(bit, str(bit))
            for acc, cap in ((self.acc_m, 12), (self.acc_h, 400)):
                lst = acc.gb.setdefault(rid, [])
                if len(lst) < cap:
                    lst.append((c, len(meds)))

    # ── the counter clock ────────────────────────────────────────────────
    def _line(self, bit: int, t: float, icao: str):
        """Offset (ns, relative to base) of counter receiver bit at t and its
        sigma, from the other aircraft's references; None without enough."""
        key = (bit, icao, int(t))
        hit = self._fit_cache.get(key)
        if hit is not None:
            return None if hit is False else (hit[0] + hit[1] * (t - hit[2]), hit[3])
        bins = self.refs[bit]
        pts = []
        for sec in range(int(t - CLK_BACK), int(t + DELAY) + 1):
            for p in bins.get(sec, ()):
                if p[2] != icao:
                    pts.append(p)
        res = False
        nac = len({p[2] for p in pts})
        span = max(p[0] for p in pts) - min(p[0] for p in pts) if pts else 0.0
        # several other aircraft, or one with many references over a long stretch (from 2026-11-20)
        if len(pts) >= CLK_MIN_N and span >= CLK_MIN_SPAN and (
                nac >= CLK_MIN_AC or (nac == 1 and len(pts) >= CLK1_MIN_N and span >= CLK1_MIN_SPAN)):
            a = b = sig = None
            use = pts
            for _ in range(3):
                nn = len(use)
                mt = sum(p[0] for p in use) / nn
                mo = sum(p[1] for p in use) / nn
                sxx = sum((p[0] - mt) ** 2 for p in use)
                if sxx <= 0:
                    break
                b = sum((p[0] - mt) * (p[1] - mo) for p in use) / sxx
                a = mo
                rs = [abs(p[1] - (a + b * (p[0] - mt))) for p in use]
                sig = 1.4826 * _med(rs)
                lim = max(150.0, 3.0 * sig)
                nxt = [p for p, r in zip(use, rs) if r <= lim]
                if len(nxt) == len(use) or len(nxt) < CLK_MIN_N:
                    break
                use = nxt
            if a is not None and sig is not None:
                uac = len({p[2] for p in use})
                if uac >= CLK_MIN_AC:
                    if sig <= CLK_MAX_SIG:
                        res = (a, b, mt, sig)
                # what is left is of one aircraft (also when the others' references were thrown out as
                # outliers): the stricter conditions, and a wider timing error for the fix
                elif len(use) >= CLK1_MIN_N and sig <= CLK1_MAX_SIG \
                        and max(p[0] for p in use) - min(p[0] for p in use) >= CLK1_MIN_SPAN:
                    res = (a, b, mt, math.hypot(max(sig, SIG_CNT_NS), CLK1_ADD_NS))
                self.clk[bit] = {"t": t, "n": len(use), "ac": uac,
                                 "sig": round(sig, 1), "drift": round(b, 2)}
                if res is False:
                    self.clk[bit]["weak"] = True       # fitted, but not good enough for a fix
                if self.acc_m is not None and len(self.acc_m.clock) < 200:
                    ck = (sig, b, len(use), uac)
                    self.acc_m.clock.append(ck)
                    if len(self.acc_h.clock) < 3000:
                        self.acc_h.clock.append(ck)
        if len(self._fit_cache) > 4000:
            self._fit_cache.clear()
        self._fit_cache[key] = res
        return None if res is False else (res[0] + res[1] * (t - res[2]), res[3])

    # ── solving (recorder thread) ────────────────────────────────────────
    def _process(self) -> None:
        lim = self.now - DELAY
        while self.pending and self.pending[0][0] <= lim:
            t, icao, arr, gbits, cbits, alt, ls = self.pending.popleft()
            try:
                self._one(t, icao, arr, gbits, cbits, alt, ls)
            except Exception as exc:               # noqa: BLE001
                self.c["error"] += 1
                log.debug("MLAT fix failed for %s: %s", icao, exc)
        if self.c["heard3"] % 500 == 0:
            self._prune()

    def _one(self, t, icao, arr, gbits, cbits, alt, ls) -> None:
        if alt is None:
            self.c["no_alt"] += 1
            return
        a = self.ac.get(icao)
        if a is None:
            reg = ls.get("registration") or ""
            if self.blocked_reg and any(reg.upper().startswith(p.upper()) for p in self.blocked_reg if p):
                self.c["blocked"] += 1
                return
            a = self.ac[icao] = {"hyps": [], "sec": 0, "nsec": 0, "trk": deque(), "adsb": deque(),
                                 "last": None, "n": 0, "t0": t, "res": False, "init_t": 0.0,
                                 "errs": deque(maxlen=120), "amb": 0}
        sec = int(t)
        if a["sec"] != sec:
            a["sec"], a["nsec"] = sec, 0
        if a["nsec"] >= SOLVES_PER_S:
            self.c["skipped"] += 1
            return
        a["nsec"] += 1
        h = self._height(float(alt), t)
        if h is None:
            self.c["no_height"] += 1
            return
        ref = self.main if self.main in gbits else gbits[0]
        t_ref = arr[ref] - self.bias.get(ref, 0.0)
        s0 = self.site[ref]
        rx = [(s0[0], s0[1], s0[2], 0.0, 1.0)]
        sg = [(s0[0], s0[1], s0[2], 0.0)]
        s_gps = SIG_GPS_NS * math.sqrt(2.0) * C_AIR * 1e-9
        for b in gbits:
            if b == ref:
                continue
            dr = ((arr[b] - self.bias.get(b, 0.0)) - t_ref) * C_AIR * 1e-9
            s = self.site[b]
            rx.append((s[0], s[1], s[2], dr, 1.0 / (s_gps * s_gps)))
            sg.append((s[0], s[1], s[2], s_gps))
        for b in cbits:
            ln = self._line(b, t, icao)
            if ln is None:
                self.c["no_clock"] += 1
                self.acc_m.c["nc"] += 1
                self.acc_h.c["nc"] += 1
                continue
            o, sig = ln
            # arrival in GPS time = counter ns − (base + offset); against the reference receiver
            dr = ((arr[b] - self.base[b] - arr[ref]) - o + self.bias.get(ref, 0.0)) * C_AIR * 1e-9
            s = self.site[b]
            s_c = math.hypot(max(sig, SIG_CNT_NS), SIG_GPS_NS) * C_AIR * 1e-9
            rx.append((s[0], s[1], s[2], dr, 1.0 / (s_c * s_c)))
            sg.append((s[0], s[1], s[2], s_c))
        if len(rx) < 3:
            return
        self.c["tried"] += 1
        self.acc_m.c["tr"] += 1
        self.acc_h.c["tr"] += 1
        hyps = a["hyps"]
        if STALE_DROP and hyps and any(t - hy["tu"] > HYP_DROP_SEC for hy in hyps):
            # a hypothesis that has had no fix for this long is not picked up again: after a gap in the
            # reception the aircraft starts afresh, and is unresolved until its motion has been checked
            a["hyps"] = hyps = [hy for hy in hyps if t - hy["tu"] <= HYP_DROP_SEC]
            if not hyps:
                a["res"] = False
                a["doubt"] = False
        got = poor = False
        vrep = None                                # the aircraft's reported motion, when fresh
        if KF_ON and KF_VEL_SIG > 0.0:
            gs_, tk_, vt_ = ls.get("groundspeed"), ls.get("track"), ls.get("vel_ts")
            if gs_ is not None and tk_ is not None and vt_ is not None and abs(t - vt_) <= KF_VEL_AGE and 40 <= gs_ <= 700:
                a_ = math.radians(float(tk_))
                vrep = (float(gs_) * KT * math.sin(a_), float(gs_) * KT * math.cos(a_))
        for hy in hyps:
            dt = t - hy["t"]
            pe, pn = hy["e"] + hy["ve"] * dt, hy["n"] + hy["vn"] * dt
            s = solve(self.fr, rx, h, pe, pn)
            if s is None:
                continue
            ex = expected_error(self.fr, sg, h, s[0], s[1])
            if ex is None or ex > MAX_EXP_M:
                poor = True
                continue
            young = hy["k"] < 3
            gate = max(GATE_M, GATE_SIGMA * ex) * (2.0 if young else 1.0) + GATE_MPS * max(dt, 0.0) * (2.5 if young else 1.0)
            de, dn = s[0] - pe, s[1] - pn
            if math.hypot(de, dn) > gate or (len(rx) > 3 and s[2] > 600.0):
                continue
            if dt > 0.05 and KF_ON and hy.get("P") is not None:
                cv = fix_cov(self.fr, sg, h, s[0], s[1])
                if cv is not None:
                    x, P = [hy["e"], hy["n"], hy["ve"], hy["vn"]], hy["P"]
                    _kf_predict(x, P, dt, KF_ACC)
                    f2 = KF_R_SCALE * KF_R_SCALE
                    fl = 0.5 * EXP_FLOOR_M * EXP_FLOOR_M
                    _kf_update(x, P, 0, s[0], s[1], f2 * cv[0] + fl, f2 * cv[1], f2 * cv[2] + fl)
                    if vrep is not None:
                        vs = KF_VEL_SIG * KF_VEL_SIG
                        _kf_update(x, P, 2, vrep[0], vrep[1], vs, 0.0, vs)
                    hy["e"], hy["n"], hy["ve"], hy["vn"] = x
                    hy["t"] = t
            elif dt > 0.05:
                al, be = (0.4, 0.05) if hy["k"] >= 6 else (0.7, 0.3)
                hy["e"], hy["n"] = pe + al * de, pn + al * dn
                d_ = max(dt, 0.4)
                hy["ve"] += be * de / d_
                hy["vn"] += be * dn / d_
                hy["t"] = t
            hy["k"] += 1
            hy["raw"] = (s[0], s[1])
            hy["tu"] = t
            hi = hy["hist"]
            if not hi or t - hi[-1][0] >= 0.5:
                hi.append((t, s[0], s[1]))
            got = True
        if len(hyps) > 1:
            # hypotheses that have run into the same solution are one: the older stays
            hyps.sort(key=lambda hy: hy["t0"])
            keep = []
            for hy in hyps:
                if not any(math.hypot(hy["e"] - k["e"], hy["n"] - k["n"]) < MERGE_M for k in keep):
                    keep.append(hy)
            if len(keep) != len(hyps):
                a["hyps"] = hyps = keep
        if poor and not got:
            self.c["poor"] += 1
        if not got and t - a["init_t"] >= (2.0 if not hyps else 6.0):
            a["init_t"] = t
            self._init(a, rx, sg, h, t)
        elif REINIT_DOUBT and a.get("doubt") and len(hyps) == 1 and t - a["init_t"] >= 6.0:
            a["init_t"] = t                        # the track is in doubt: let the other solution compete
            self._init(a, rx, sg, h, t)
        self._judge(a, t, ls)
        if len(rx) > 3 and len(a["hyps"]) == 1:
            a["res"] = True                        # four receivers: the fix checks itself
        hy = a["hyps"][0] if a["hyps"] else None
        if hy is None or hy.get("tu") != t:
            return
        self._emit(icao, a, hy, t, h, float(alt), sg, ls, len(rx))

    def _init(self, a: dict, rx: list, sg: list, h: float, t: float) -> None:
        found = []
        for e0, n0 in _STARTS:
            s = solve(self.fr, rx, h, e0, n0)
            if s is None or math.hypot(s[0], s[1]) > MAX_RANGE_M:
                continue
            if len(rx) > 3 and s[2] > 600.0:
                continue
            if any(math.hypot(s[0] - f[0], s[1] - f[1]) < 300.0 for f in found):
                continue
            ex = expected_error(self.fr, sg, h, s[0], s[1])
            if ex is None or ex > MAX_EXP_M:
                continue
            found.append(s)
        for s in found:
            cv = fix_cov(self.fr, sg, h, s[0], s[1]) if KF_ON else None
            if any(math.hypot(s[0] - hy["e"], s[1] - hy["n"]) < 3000.0 for hy in a["hyps"]):
                continue
            if len(a["hyps"]) >= 3:
                break
            self._hid = getattr(self, "_hid", 0) + 1
            a["hyps"].append({"id": self._hid, "e": s[0], "n": s[1], "ve": 0.0, "vn": 0.0, "t": t, "t0": t, "k": 1,
                              "raw": (s[0], s[1]), "tu": t, "dv": None,
                              "hist": deque([(t, s[0], s[1])], maxlen=50)})
            if cv is not None:
                f2 = KF_R_SCALE * KF_R_SCALE
                fl = 0.5 * EXP_FLOOR_M * EXP_FLOOR_M
                a["hyps"][-1]["P"] = [[f2 * cv[0] + fl, f2 * cv[1], 0.0, 0.0], [f2 * cv[1], f2 * cv[2] + fl, 0.0, 0.0],
                                      [0.0, 0.0, 250.0 ** 2, 0.0], [0.0, 0.0, 0.0, 250.0 ** 2]]
        if found:
            self.c["init"] += 1

    def _judge(self, a: dict, t: float, ls: dict) -> None:
        """Drop silent hypotheses; choose between two by the reported motion."""
        hyps = [hy for hy in a["hyps"] if t - hy["tu"] <= HYP_DROP_SEC]
        v = None
        gs, trk, vts = ls.get("groundspeed"), ls.get("track"), ls.get("vel_ts")
        if gs is not None and trk is not None and vts is not None and abs(t - vts) <= VEL_FRESH and 40 <= gs <= 700:
            tr = math.radians(float(trk))
            v = (float(gs) * KT * math.sin(tr), float(gs) * KT * math.cos(tr))
        for hy in hyps:
            hi = hy["hist"]
            if v is not None and hy["tu"] == t and len(hi) >= RES_MIN_N and hi[-1][0] - hi[0][0] >= RES_MIN_SEC:
                # the hypothesis' own motion: the last third of its fixes against the first third
                k = max(2, len(hi) // 3)
                h0, h1 = list(hi)[:k], list(hi)[-k:]
                dtm = sum(p[0] for p in h1) / k - sum(p[0] for p in h0) / k
                if dtm > 3.0:
                    ve = (sum(p[1] for p in h1) - sum(p[1] for p in h0)) / k / dtm
                    vn = (sum(p[2] for p in h1) - sum(p[2] for p in h0)) / k / dtm
                    d = math.hypot(ve - v[0], vn - v[1])
                    hy["dv"] = d if hy["dv"] is None else hy["dv"] + 0.3 * (d - hy["dv"])
                    hy["nj"] = hy.get("nj", 0) + 1
        judged = [hy for hy in hyps if hy["dv"] is not None]
        if len(hyps) >= 2 and len(judged) == len(hyps):
            judged.sort(key=lambda hy: hy["dv"])
            if judged[0]["dv"] <= RES_OK_MPS and judged[1]["dv"] >= judged[0]["dv"] + RES_SEP_MPS \
                    and min(hy.get("nj", 0) for hy in judged[:2]) >= RES_MIN_JUDGED:
                hyps = [judged[0]]
                a["res"] = True
                self.c["resolved"] += 1
        elif len(hyps) == 1 and hyps[0]["dv"] is not None:
            if hyps[0]["dv"] <= RES_OK_MPS:
                a["res"] = True
                a["doubt"] = False
            elif RES_DOUBT_MPS > 0.0 and RES_DOUBT_MPS < hyps[0]["dv"] <= 3 * RES_OK_MPS:
                a["res"] = False                   # it no longer moves like the aircraft: not the position for sure
                a["doubt"] = True
            elif hyps[0]["dv"] > 3 * RES_OK_MPS and t - hyps[0]["t0"] > 25.0:
                hyps = []                          # moves unlike the aircraft: the mirror solution
                a["res"] = False
                a["init_t"] = 0.0
                self.c["mirror"] += 1
        if len(hyps) >= 2:
            # the first one is shown: best motion fit, else the most fixes
            hyps.sort(key=lambda hy: (hy["dv"] if hy["dv"] is not None else 1e9, -hy["k"]))
            a["res"] = False
        if not hyps:
            a["res"] = False
        if len(hyps) != 1:
            a["doubt"] = False
        # the stored track: the points of dropped hypotheses go, those of a confirmed one count
        alive = {hy["id"] for hy in hyps}
        gone = {hy["id"] for hy in a["hyps"]} - alive
        if gone or (a["res"] and len(hyps) == 1 and not a.get("res_was")):
            with self._lock:
                if gone:
                    a["trk"] = deque(p for p in a["trk"] if p[7] not in gone)
                if a["res"] and len(hyps) == 1:
                    for p in a["trk"]:
                        if p[7] == hyps[0]["id"]:
                            p[6] = 0
        if a["res"] and len(hyps) == 1 and not a.get("res_was") and self.acc_m is not None:
            dt_res = t - hyps[0]["t0"]
            self.acc_m.rs.append(dt_res)
            self.acc_h.rs.append(dt_res)
        a["res_was"] = bool(a["res"] and len(hyps) == 1)
        a["hyps"] = hyps

    def _emit(self, icao, a, hy, t, h, alt, sg, ls, nrx) -> None:
        e, n = hy["e"], hy["n"]
        exp = expected_error(self.fr, sg, h, e, n)
        if exp is not None and EXP_FLOOR_M > 0.0:
            exp = math.hypot(exp, EXP_FLOOR_M)
        self.c["fix"] += 1
        a["n"] += 1
        # unresolved: two candidates, or one that is neither confirmed by its motion nor old enough
        amb = len(a["hyps"]) > 1 or bool(a.get("doubt")) or not (a["res"] or t - hy["t0"] >= SINGLE_OK_SEC)
        if amb:
            self.c["ambiguous"] += 1
        err_raw = err_trk = dist = None
        tr = self._truth(ls, t) if self._good(ls) else None
        if tr is not None:
            err_raw = math.hypot(hy["raw"][0] - tr[0], hy["raw"][1] - tr[1])
            err_trk = math.hypot(e - tr[0], n - tr[1])
            a["errs"].append(err_trk)
            dist = math.hypot(tr[0], tr[1]) / 1852.0
            self.stat.append((t, dist, err_raw, err_trk, amb))
            while self.stat and t - self.stat[0][0] > STAT_SEC:
                self.stat.popleft()
        lat, lon = self.fr.ll(e, n, h)
        # the track's own speed and direction (for the map's speed vector and label): from the
        # first and last third of the hypothesis' fixes of the last seconds, else the filter's
        vel = None
        hi = hy["hist"]
        if len(hi) >= 6 and hi[-1][0] - hi[0][0] >= 8.0:
            k = max(2, len(hi) // 3)
            h0, h1 = list(hi)[:k], list(hi)[-k:]
            dtm = (sum(p[0] for p in h1) - sum(p[0] for p in h0)) / k
            if dtm > 3.0:
                vel = ((sum(p[1] for p in h1) - sum(p[1] for p in h0)) / k / dtm,
                       (sum(p[2] for p in h1) - sum(p[2] for p in h0)) / k / dtm)
        if vel is None and hy["k"] >= 8:
            vel = (hy["ve"], hy["vn"])
        rgs = ls.get("groundspeed") if (ls.get("vel_ts") is not None and abs(t - ls["vel_ts"]) <= VEL_FRESH) else None
        pt = [round(t, 1), round(lat, 5), round(lon, 5), int(alt),
              None if exp is None else int(min(exp, 99999)), None if err_trk is None else int(err_trk), 1 if amb else 0,
              hy["id"],
              None if vel is None else int(round(math.hypot(vel[0], vel[1]) / KT)),     # our own ground speed, kt
              None if rgs is None else int(round(rgs))]                                 # the speed the aircraft reports
        has_pos = tr is not None or (ls.get("last_adsb_pos_ts") is not None and t - ls["last_adsb_pos_ts"] < 60)
        for acc in (self.acc_m, self.acc_h):
            acc.fix(icao, has_pos, amb, float(alt), dist, exp, err_raw, err_trk, lat, lon)
        with self._lock:
            a["last"] = pt
            a["vel"] = None if vel is None else (int(round(math.hypot(vel[0], vel[1]) / KT)),
                                                 int(round(math.degrees(math.atan2(vel[0], vel[1])) % 360)))
            # the altitude selected in the cockpit, when the aircraft sends it (for the map's label, from 2026-11-20)
            sa_, sat_ = ls.get("sel_alt"), ls.get("sel_alt_ts")
            a["sal"] = int(sa_) if (sa_ is not None and sat_ is not None and abs(t - sat_) <= 120.0) else None
            if t - a.get("rp_t", 0.0) >= REPLAY_STEP and len(self.rp) < REPLAY_BUF:
                a["rp_t"] = t
                v_ = a["vel"]
                self.rp.append((pt[0], icao, pt[1], pt[2], pt[3], pt[4], pt[6], pt[5],
                                None if tr is None else round(tr[3], 5), None if tr is None else round(tr[4], 5),
                                None if v_ is None else v_[0], None if v_ is None else v_[1], a["sal"],
                                ls.get("callsign") or a.get("cs"), ls.get("aircraft_type") or a.get("typ"), 1 if has_pos else 0))
            a["vr"] = ls.get("vert_rate")
            a["nrx"] = nrx
            a["cs"] = ls.get("callsign") or a.get("cs")
            a["typ"] = ls.get("aircraft_type") or a.get("typ")
            a["has_pos"] = tr is not None or (ls.get("last_adsb_pos_ts") is not None
                                              and t - ls["last_adsb_pos_ts"] < 60)
            if not a["trk"] or t - a["trk"][-1][0] >= TRACK_STEP:
                a["trk"].append(pt)
                trk_r = ls.get("track")
                if tr is not None and not amb and trk_r is not None:
                    # where the single fix lies from the own position: along and across the flight direction
                    de, dn = hy["raw"][0] - tr[0], hy["raw"][1] - tr[1]
                    br = math.radians(float(trk_r))
                    self.scatter.append((round(t), int(de * math.sin(br) + dn * math.cos(br)),
                                         int(de * math.cos(br) - dn * math.sin(br)), round(dist, 1)))
                if tr is not None:
                    a["adsb"].append((round(t, 1), round(tr[3], 5), round(tr[4], 5)))
                while a["trk"] and t - a["trk"][0][0] > KEEP_SEC:
                    a["trk"].popleft()
                while a["adsb"] and t - a["adsb"][0][0] > KEEP_SEC:
                    a["adsb"].popleft()

    def _prune(self) -> None:
        t = self.now
        with self._lock:
            for k in [k for k, a in self.ac.items()
                      if (a["last"] is None and t - a["t0"] > 300) or (a["last"] is not None and t - a["last"][0] > KEEP_SEC)]:
                del self.ac[k]

    # ── for the page (web threads) ───────────────────────────────────────
    def stats(self, rng: str = "1h") -> dict:
        """The statistics of the Charts view: rng "1h" (by the minute), "24h" (10-minute steps) or
        "7d" (hours) — the series, the whole range as one, the accuracy grid and the scatter sample."""
        now = self.now or time.time()
        with self._lock:
            mins, hours = list(self.minutes), list(self.hours)
            sc = list(self.scatter)
        if rng == "7d":
            ser = [{k: v for k, v in h.items() if k != "grid"} for h in hours if h["t"] >= now - 7 * 86400]
            step, gr = 3600, [h for h in hours if h["t"] >= now - 7 * 86400]
        elif rng == "24h":
            by: dict = {}
            for m in mins:
                if m["t"] >= now - 86400:
                    by.setdefault(m["t"] // 600 * 600, []).append(m)
            ser = [combine(v, k) for k, v in sorted(by.items())]
            step, gr = 600, [h for h in hours if h["t"] >= now - 86400]
        else:
            rng = "1h"
            ser = [m for m in mins if m["t"] >= now - 3600]
            step, gr = 60, [h for h in hours if h["t"] >= now - 3600]
        grids = list(gr)
        if self.acc_h is not None:
            try:
                grids.append(self.acc_h.close())   # the open hour so far
            except Exception:                      # noqa: BLE001  (changed while read: next time)
                pass
        return {"on": True, "range": rng, "step": step, "now": round(now, 1), "series": ser,
                "total": combine(ser) if ser else {}, "bands": list(STAT_BANDS), "alt_bands": list(ALT_BANDS),
                "grid": merge_grids(grids), "cell": [GRID_LAT, GRID_LON],
                "scatter": [s[1:] for s in sc if s[0] >= now - 3600][-2500:]}

    def grid(self, hours: int = 1) -> dict:
        """The accuracy grid alone, for the map (from 2026-11-20 evening): the cells of the last `hours` hours
        (one of GRID_HOURS), each cell [fixes, median error m, fixes with an error].  The grid is kept by the
        clock hour, so the period is the last `hours` whole hours and the running hour: between `hours` and
        `hours` + 1 hours, never just the few minutes since the hour changed."""
        hours = int(hours) if hours in GRID_HOURS else 1
        now = self.now or time.time()
        with self._lock:
            grids = [h for h in self.hours if h["t"] > now - (hours + 1) * 3600]
        if self.acc_h is not None:
            try:
                grids.append(self.acc_h.close())   # the open hour so far
            except Exception:                      # noqa: BLE001  (changed while read: next time)
                pass
        return {"on": True, "hours": hours, "now": round(now, 1), "n_hours": len(grids),
                "grid": merge_grids(grids), "cell": [GRID_LAT, GRID_LON]}

    def public(self, win: float = 600.0, since: float = 0.0) -> dict:
        now = self.now or time.time()
        win = max(30.0, min(float(win), KEEP_SEC))
        t_from = max(now - win, float(since or 0.0))
        acs = []
        with self._lock:
            for icao, a in self.ac.items():
                last = a["last"]
                if last is None or now - last[0] > win:
                    continue
                er = sorted(a["errs"])
                # for the Traffic list (from 2026-11-20): the track's motion against the reported one (m/s),
                # the number of candidate positions, how long the present track has run, and whether it is in doubt
                hy0 = None
                try:
                    hs = a["hyps"]
                    hy0 = hs[0] if hs else None
                    nh = len(hs)
                except Exception:                  # noqa: BLE001 — the solver thread may be replacing the list
                    nh = 0
                acs.append({"icao": icao, "cs": a.get("cs"), "typ": a.get("typ"), "last": last[:7],
                            "n": a["n"], "nrx": a.get("nrx"), "pos": bool(a.get("has_pos")),
                            "res": bool(a["res"]), "err": None if not er else int(er[len(er) // 2]),
                            "vel": a.get("vel"), "vr": a.get("vr"), "sal": a.get("sal"),
                            "mm": None if hy0 is None or hy0.get("dv") is None else round(hy0["dv"], 1),
                            "nh": nh, "tage": None if hy0 is None else int(max(0.0, now - hy0["t0"])),
                            "doubt": bool(a.get("doubt")),
                            "trk": [p[:7] + p[8:10] for p in a["trk"] if p[0] > t_from],
                            "adsb": [p for p in a["adsb"] if p[0] > t_from]})
            st = list(self.stat)
        bands = []
        lo = 0
        for hi in BANDS_NM + (9999,):
            v = sorted(s[2] for s in st if lo <= s[1] < hi and not s[4])
            w = sorted(s[3] for s in st if lo <= s[1] < hi and not s[4])
            bands.append({"lo": lo, "hi": None if hi == 9999 else hi, "n": len(v),
                          "med": None if not v else int(_pct(v, 0.5)), "p68": None if not v else int(_pct(v, 0.68)),
                          "p90": None if not v else int(_pct(v, 0.9)), "trk": None if not w else int(_pct(w, 0.5))})
            lo = hi
        up = max(1.0, time.monotonic() - self.t_start)
        c = self.c
        qnh = None                                 # for the altitudes below the transition altitude (the map's labels)
        if self.qnh_fn is not None:
            try:
                qnh = self.qnh_fn()
            except Exception:                      # noqa: BLE001
                qnh = None
        return {
            "on": True, "now": round(now, 1), "delay": DELAY, "keep": KEEP_SEC,
            "qnh": None if qnh is None else round(float(qnh), 1), "ta_ft": 5000,
            "receivers": [{"id": self.names[b], "bit": b, "gps": b in self.gps, "site": b in self.site,
                           "why": self.why_site.get(b),
                           "bias": None if b not in self.gps else round(self.bias.get(b, 0.0), 1),
                           "bias_ac": self.bias_n.get(b),
                           "clock": None if b not in self.cnt else (
                               dict(self.clk[b], age=round(now - self.clk[b]["t"], 1)) if b in self.clk else None)}
                          for b in sorted(self.names)]
                         # the receivers MLAT_FIX_RX leaves out: listed, so that it is seen that they are connected
                         + [{"id": rid, "bit": b, "rec_only": True} for b, rid in sorted(self.rec_only.items())],
            "use_why": self.use_why,
            "counters": {k: c[k] for k in ("heard3", "tried", "fix", "ambiguous", "no_clock", "no_height", "no_alt",
                                           "skipped", "poor", "init", "resolved", "mirror", "error")},
            "cpu": round(100.0 * self.cpu / up, 2),
            "height": {"levels": len([1 for g in self.gmb.values() if now - g[1] <= GMB_KEEP_SEC])},
            "bands": bands, "stat_n": len(st), "stat_amb": sum(1 for s in st if s[4]), "stat_sec": STAT_SEC,
            "aircraft": acs,
        }
