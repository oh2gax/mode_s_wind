"""
collector/mlat_rec.py — the pair recorder (own multilateration, step 0a; from
2026-11-18).

Two or more receivers with GPS time (Radarcapes) stamp the same reply at their
own antennas.  The difference of the stamps (TDOA) is the raw material of
multilateration: 1 ns = 0.3 m of range difference.  Two receivers give one
TDOA per reply — not a position — but everything needed to measure how well
the clocks agree and to calibrate the sites before a third GPS-timed receiver
exists.  This module only RECORDS; nothing here goes into the weather.

Where the data come from: the merger (collector/multirx.py) keeps the raw
48-bit GPS stamp of every copy of a reply (its float time is good to 0.24 µs
only) and hands a reply heard by two or more GPS-timed receivers to put() when
it is passed on.  put() only appends to a bounded queue; a thread of its own
does the rest, so the weather never waits for the recorder.

What is stored (all under the data folder, none of it in the main database):

  data/mlat_raw/YYYYMMDD_HH.mlr[.gz]   every shared reply of that UTC hour
      a text line  MLR1 {"rx": {bit: id}, "hour": …}  and then per reply
        <d  time (Unix s, the merger's)      B  message bytes (7 / 14)
        B  receivers                          the message
        per receiver: B bit, 6 bytes stamp (big-endian; a Radarcape's GPS
        time: 18 bit second of the UTC day, 30 bit ns; another receiver: its
        counter), B signal
      A closed hour is gzip-compressed.  The folder is capped (MLAT_RAW_MAX_GB,
      default 10): the oldest hours are removed first; nothing is written
      while less than 2 GB of the disk is free.

  data/mlat.db
      mlat_sum   one row per aircraft, receiver pair and 30 s: number of
                 pairs, median TDOA, the signal levels, and for an aircraft
                 with an own ADS-B position its place and the residual
                 (measured − expected TDOA: median and the 16th / 84th
                 percentile, ns).  Kept MLAT_SUM_DAYS (default 90).
      mlat_min   one row per receiver pair and minute: pairs, the residual's
                 median and percentiles, and the counters.
      mlat_meta  the receivers' bits and the averaged site positions.

The residual is a first, rough one: the aircraft's position is its last own
ADS-B position moved on with its ground speed and track to the time of the
reply (at most 3 s), its height the barometric altitude, the sites the
Radarcapes' averaged GPS positions (the GPS antenna, not the 1090 MHz one)
unless MLAT_SITES gives them.  Everything needed to do it better later is in
the raw files.

A receiver without GPS time (an SDR with a free-running counter, e.g. 12 MHz)
is recorded too once its counter is lined up with the main receiver (from the
evening of 2026-11-18): its raw counter value goes into the raw files with
the reply, nothing else — no time difference is computed from it here.  The
files' first line says which bit has which clock ("clock": {bit: "gps" |
"12mhz" | …}).  Whether such a receiver can be lined up well enough to serve
as a rough third station is a question for the stored data.

Also from that evening: each minute's row keeps the GPS-timed receivers' clock
state, their Radarcapes' GPS flags and GPS module temperature and where their
position came from (mlat_min.extra "rx" — none of this is in the raw files);
the expected time difference uses the aircraft's GNSS − barometric height
difference when it has sent one; and public(detail=True) sums up the last 10
minutes pair by pair for the MLAT tab (histogram of the residual, by
direction from the middle of the two sites, by signal level, by reply type,
by aircraft, the newest pairs).  An aircraft without an own ADS-B position is
listed there too, with its address and marked as such (the page is for users
with the MLAT right only).

Not recorded: addresses the system blocks (BLOCKED_ICAO_PREFIXES), replies
whose address cannot be checked (a parity-overlaid reply of an aircraft not
seen before) — those are in the raw files only — pairs further apart than the
distance between the sites allows, and replies that came twice within 5 ms at
one receiver (replies to two interrogators; the merger counts them).

Settings (config_local.py; none is needed):
    MLAT_RECORD = True            # False: no recorder
    MLAT_DIR = None               # the raw folder (default data/mlat_raw)
    MLAT_RAW_MAX_GB = 10
    MLAT_SUM_DAYS = 90
    MLAT_SITES = {"MODES-RX-01": (lat, lon, height_m), …}   # the 1090 MHz antennas, when known
                                  # (height above the WGS-84 ellipsoid; left out: the GPS mean's height)
    MLAT_POS_LATENCY = 0.09       # s, the age of a broadcast position when it is sent

From 2026-11-19 (after the first data check): the clock-agreement figures
(minute rows, the windows, the charts of the MLAT tab) use only aircraft that
declare a good position (NACp ≥ 8 and NIC ≥ 7) — at night most replies come
from aircraft without GNSS, whose positions drift by hundreds of ns; the
pairs of the others are counted (`pos_low` in the minute's extra) and their
residuals still go into mlat_sum.  The expected value moves the position on by
0.09 s; an aircraft whose own position is more than 250 ns from the timing over
100 pairs is listed as "does not fit the timing"; the write-ahead log is
written into mlat.db every ten minutes.
"""

from __future__ import annotations

import gzip
import json
import logging
import math
import os
import shutil
import sqlite3
import struct
import threading
import time
from collections import Counter, deque

log = logging.getLogger("modes.mlat")

C_AIR = 299_792_458.0 / 1.0003      # m/s near the ground
BUCKET_SEC = 30
QUEUE_MAX = 200_000
POS_MAX_AGE = 3.0                   # s between the reply and the own ADS-B position
# From 2026-11-19 (the first data check, claude/aws_check_2026-11-19.md):
POS_LATENCY = 0.09                  # s: a broadcast position is this old when it is sent (fitted 0.087 and 0.092 s);
                                    # the aircraft is moved on by it (MLAT_POS_LATENCY)
GOOD_NACP, GOOD_NIC = 8, 7          # the clock-agreement figures use only aircraft that declare at least this
                                    # position quality: an aircraft without GNSS keeps sending a (drifting) position
MISFIT_NS = 250                     # an own position this far from the timing …
MISFIT_MIN = 100                    # … over at least this many pairs in 5 min "does not fit the timing"
CHECKPOINT_SEC = 600                # the database's write-ahead log is written into the file this often,
                                    # so that a plain copy of mlat.db is complete to within ten minutes
FAR_MARGIN_NS = 20_000              # allowed beyond the distance between the sites
FAR_DEFAULT_NS = 500_000            # sites not known yet
MIN_FREE_BYTES = 2 * 1024 ** 3
DAY_NS = 86_400 * 1_000_000_000
A_WGS, E2_WGS = 6378137.0, 6.69437999014e-3

# ── Mode S parity ───────────────────────────────────────────────────────────
_TAB = []
for _i in range(256):
    _c = _i << 16
    for _ in range(8):
        _c = ((_c << 1) ^ 0xFFF409) if _c & 0x800000 else (_c << 1)
    _TAB.append(_c & 0xFFFFFF)


def parity_rest(data: bytes) -> int:
    """The message's parity field XOR the parity computed from its bits: 0 for
    a good DF17 / DF18, the interrogator code for DF11, the address for the
    parity-overlaid replies (DF0 / 4 / 5 / 16 / 20 / 21)."""
    c = 0
    for b in data[:-3]:
        c = ((c << 8) ^ _TAB[((c >> 16) ^ b) & 0xFF]) & 0xFFFFFF
    return c ^ int.from_bytes(data[-3:], "big")


def address(data: bytes):
    """(DF, ICAO address or None, checked): checked = the address is certain
    from the message alone (DF11 / 17 / 18 with good parity)."""
    df = data[0] >> 3
    if df >= 24:
        return 24, None, False
    r = parity_rest(data)
    if df in (17, 18):
        return df, (data[1:4].hex().upper() if r == 0 else None), True
    if df == 11:
        return df, (data[1:4].hex().upper() if r < 0x80 else None), True
    if df in (0, 4, 5, 16, 20, 21):
        return df, f"{r:06X}", False
    return df, None, False


def ecef(lat: float, lon: float, h: float):
    la, lo = math.radians(lat), math.radians(lon)
    s, c = math.sin(la), math.cos(la)
    n = A_WGS / math.sqrt(1.0 - E2_WGS * s * s)
    return ((n + h) * c * math.cos(lo), (n + h) * c * math.sin(lo), (n * (1.0 - E2_WGS) + h) * s)


def _pct(v: list, q: float):
    return v[min(len(v) - 1, int(q * len(v)))]


def _stats(vals: list):
    """(median, 16th, 84th percentile) of the residuals, None without any."""
    if not vals:
        return None, None, None
    v = sorted(vals)
    return _pct(v, 0.5), _pct(v, 0.16), _pct(v, 0.84)


_SNAP = ("adsb_lat", "adsb_lon", "altitude", "groundspeed", "track", "nac_p", "nic")


def _good(nacp, nic) -> bool:
    """The aircraft declares a position good enough to compare clocks with."""
    return (isinstance(nacp, (int, float)) and nacp >= GOOD_NACP
            and isinstance(nic, (int, float)) and nic >= GOOD_NIC)


def _snap(ls: dict) -> dict:
    return {k: ls.get(k) for k in _SNAP}


def _wmed(pairs: list):
    """Weighted median of [(value, weight), …], None without any."""
    pairs = sorted(p for p in pairs if p[1] > 0)
    if not pairs:
        return None
    half, acc = sum(w for _, w in pairs) / 2.0, 0.0
    for v, w in pairs:
        acc += w
        if acc >= half:
            return v
    return pairs[-1][0]


def stamp_ns(ticks: int) -> int:
    """ns of the UTC day of a Radarcape GPS stamp."""
    return (ticks >> 30) * 1_000_000_000 + (ticks & 0x3FFFFFFF)


class Recorder:
    def __init__(self, cfg, rxs: list, live_state: dict, counter_rxs: list = ()) -> None:
        self.cfg = cfg
        self.rxs = {r.bit: r for r in rxs}         # the GPS-timed receivers
        self.crx = {r.bit: r for r in counter_rxs} # counter-clock receivers: raw stamps recorded only
        self.crx_n = Counter()                     # bit → shared replies with its stamp (since the start)
        self.live = live_state
        self.blocked = tuple(p.upper() for p in (getattr(cfg, "BLOCKED_ICAO_PREFIXES", ()) or ()))
        data_dir = os.path.dirname(os.path.abspath(cfg.DB_PATH))
        self.raw_dir = str(getattr(cfg, "MLAT_DIR", None) or os.path.join(data_dir, "mlat_raw"))
        self.db_path = os.path.join(data_dir, "mlat.db")
        self.raw_cap = int(float(getattr(cfg, "MLAT_RAW_MAX_GB", 10)) * 1024 ** 3)
        self.sum_days = float(getattr(cfg, "MLAT_SUM_DAYS", 90))
        self.cfg_sites = dict(getattr(cfg, "MLAT_SITES", None) or {})
        self.q: deque = deque()
        self.overflow = 0
        self.started = time.time()
        self.c = Counter()                         # since the start
        self.cmin = Counter()                      # this minute
        self.sites: dict = {}                      # bit → {"src", "xyz", "n"}
        self.site_sum: dict = {}                   # bit → [n, lat, lon, alt] (running mean of the GPS position)
        self.far: dict = {}                        # (a, b) → ns
        self.buckets: dict = {}                    # (icao, a, b) → bucket
        self.bucket_t0 = None
        self.min_t0 = None
        self.min_res: dict = {}                    # (a, b) → [residual, …] this minute (good position quality only)
        self.min_low: Counter = Counter()          # (a, b) → pairs with a position of lower quality this minute
        try:
            self.pos_lat = float(getattr(cfg, "MLAT_POS_LATENCY", POS_LATENCY))
        except (TypeError, ValueError):
            self.pos_lat = POS_LATENCY
        self.min_n: Counter = Counter()            # (a, b) → pairs this minute
        self.minutes: deque = deque(maxlen=8640)   # (t0, a, b, n, n_res, med, lo, hi): 24 h of up to 6 pairs
        self.raw_f = None
        self.raw_hour = None
        self.raw_why = None                        # why nothing is written (None: writing)
        self.raw_info = {"files": 0, "bytes": 0, "cur_at": 0, "oldest": None, "newest": None}
        self.raw_buf = bytearray()
        self.last_group = None
        self.recent: deque = deque(maxlen=150_000)   # the last minutes pair by pair, for the page
        self._detail_cache = (0.0, None)
        self.err = None
        self._lock = threading.Lock()
        self._db = None
        self.fix = None                            # position fixes (collector/mlat_fix.py, from 2026-11-19)

    # ── from the merger (collector thread) ──────────────────────────────
    def put(self, t: float, hx: str, st: list) -> None:
        if len(self.q) >= QUEUE_MAX:
            self.overflow += 1
            return
        self.q.append((t, hx, tuple(st)))

    # ── the recorder's own thread ───────────────────────────────────────
    def run(self) -> None:
        try:
            os.makedirs(self.raw_dir, exist_ok=True)
            self._open_db()
            self._load()
        except Exception as exc:                   # noqa: BLE001
            self.err = f"not started: {exc}"
            log.error("MLAT recorder not started: %s", exc)
            return
        self._sites()
        self._raw_scan()
        log.info("MLAT recorder started: %s%s; raw files in %s (cap %.0f GB), summaries in %s",
                 " + ".join(self.rxs[b].id for b in sorted(self.rxs)),
                 (" (raw stamps also of " + ", ".join(self.crx[b].id for b in sorted(self.crx)) + ")") if self.crx else "",
                 self.raw_dir, self.raw_cap / 1024 ** 3, self.db_path)
        last_site = last_scan = last_ckpt = time.time()
        while True:
            time.sleep(1.0)
            try:
                now = time.time()
                self._drain()
                self._flush_raw(now)
                self._close_buckets(now)
                self._close_minute(now)
                if now - last_site >= 60:
                    last_site = now
                    self._sites()
                if now - last_scan >= 600:
                    last_scan = now
                    self._raw_scan()
                    self._prune(now)
                if now - last_ckpt >= CHECKPOINT_SEC:
                    last_ckpt = now
                    self._checkpoint()
                self.err = None
            except Exception as exc:               # noqa: BLE001
                if str(exc) != self.err:
                    log.warning("MLAT recorder: %s", exc)
                self.err = str(exc)

    # ── the database ────────────────────────────────────────────────────
    def _open_db(self) -> None:
        db = self._db = sqlite3.connect(self.db_path, timeout=10, check_same_thread=False)
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA synchronous=NORMAL")
        db.executescript("""
            CREATE TABLE IF NOT EXISTS mlat_sum (
                ts INTEGER, icao TEXT, a INTEGER, b INTEGER, n INTEGER, tdoa INTEGER, t_mid REAL,
                sig_a REAL, sig_b REAL, n_res INTEGER, res_med REAL, res_lo REAL, res_hi REAL,
                lat REAL, lon REAL, alt REAL, gs REAL, trk REAL, nacp INTEGER, nic INTEGER, dfs TEXT);
            CREATE INDEX IF NOT EXISTS mlat_sum_ts ON mlat_sum (ts);
            CREATE TABLE IF NOT EXISTS mlat_min (
                ts INTEGER, a INTEGER, b INTEGER, n INTEGER, n_res INTEGER,
                res_med REAL, res_lo REAL, res_hi REAL, extra TEXT, PRIMARY KEY (ts, a, b));
            CREATE TABLE IF NOT EXISTS mlat_meta (k TEXT PRIMARY KEY, v TEXT);
        """)
        db.commit()

    def _meta(self, k: str, v=None):
        if v is None:
            row = self._db.execute("SELECT v FROM mlat_meta WHERE k = ?", (k,)).fetchone()
            try:
                return json.loads(row[0]) if row else None
            except ValueError:
                return None
        self._db.execute("INSERT OR REPLACE INTO mlat_meta (k, v) VALUES (?, ?)", (k, json.dumps(v)))
        return None

    def _load(self) -> None:
        cut = int(time.time()) - 86400
        for r in self._db.execute("SELECT ts, a, b, n, n_res, res_med, res_lo, res_hi FROM mlat_min "
                                  "WHERE ts >= ? ORDER BY ts", (cut,)):
            self.minutes.append(tuple(r))
        ss = self._meta("site_sum") or {}
        for rx in self.rxs.values():
            v = ss.get(rx.id)
            if isinstance(v, list) and len(v) == 4:
                self.site_sum[rx.bit] = v
        self._meta("rx", {str(b): r.id for b, r in {**self.rxs, **self.crx}.items()})
        self._meta("clock", self._clocks())
        self._db.commit()

    def _prune(self, now: float) -> None:
        cut = int(now - self.sum_days * 86400)
        self._db.execute("DELETE FROM mlat_sum WHERE ts < ?", (cut,))
        self._db.execute("DELETE FROM mlat_min WHERE ts < ?", (cut,))
        self._db.commit()

    def _rx_state(self) -> dict:
        """Each GPS-timed receiver now: clock state, its Radarcape's GPS flags
        and GPS module temperature, and where its position comes from — stored
        with every minute (from the evening of 2026-11-18): none of it is in
        the raw files."""
        out = {}
        for bit, rx in self.rxs.items():
            try:
                if rx.main:
                    from collector import radarcape_status
                    rcs = radarcape_status.get()
                else:
                    rcs = rx.rcs
                d = (rcs.data or {}) if rcs is not None else {}
            except Exception:                      # noqa: BLE001
                d = {}
            st = self.sites.get(bit) or {}
            out[rx.id] = {"clock": rx.clock_state, "gps": d.get("gps"), "temp": d.get("temp"),
                          "site": st.get("src"), "site_n": st.get("n")}
        return out

    def _clocks(self) -> dict:
        return {**{str(b): "gps" for b in self.rxs}, **{str(b): r.clock for b, r in self.crx.items()}}

    # ── the sites ───────────────────────────────────────────────────────
    def _gps_pos(self, rx):
        """The Radarcape's own GPS position (lat, lon, height) while its fix
        is good, else None."""
        if rx.main:
            from collector import radarcape_status
            rcs = radarcape_status.get()
        else:
            rcs = rx.rcs
        if rcs is None or rcs.position_problem() is not None:
            return None
        p = (rcs.data or {}).get("position") or {}
        alt = p.get("alt")
        return (float(p["lat"]), float(p["lon"]), float(alt) if isinstance(alt, (int, float)) else None)

    def _sites(self) -> None:
        """Once a minute: each receiver's place.  MLAT_SITES first (the 1090
        MHz antenna), else the running mean of the Radarcape's GPS position
        (one GPS fix wanders by metres; 1 m = 3 ns).  The GPS mean is kept up
        in both cases; an MLAT_SITES entry without a height takes the GPS
        mean's height (from 2026-11-19 — before, it was taken as 0 m, which is
        worse than no entry), and waits for it when there is none yet."""
        changed = False
        for bit, rx in self.rxs.items():
            try:
                p = self._gps_pos(rx)
            except Exception:                      # noqa: BLE001
                p = None
            s = self.site_sum.get(bit)
            if p is not None and p[2] is not None:
                if s is None:
                    s = self.site_sum[bit] = [0, 0.0, 0.0, 0.0]
                n = min(s[0], 10_080)              # a week of minutes, then a slow follower
                s[1] = (s[1] * n + p[0]) / (n + 1)
                s[2] = (s[2] * n + p[1]) / (n + 1)
                s[3] = (s[3] * n + p[2]) / (n + 1)
                s[0] = n + 1
                changed = True
            cs = self.cfg_sites.get(rx.id)
            if cs and len(cs) >= 2:
                try:
                    la, lo = float(cs[0]), float(cs[1])
                    h = float(cs[2]) if len(cs) > 2 and cs[2] is not None else None
                except (TypeError, ValueError):
                    la = None
                if la is not None:
                    src = "config"
                    if h is None:
                        if not (s and s[0] >= 1):
                            continue               # no height yet: no expected value this minute
                        h, src = s[3], "config, GPS height"
                    self.sites[bit] = {"src": src, "xyz": ecef(la, lo, h), "n": None, "ll": (la, lo)}
                    continue
            if s and s[0] >= 1:
                self.sites[bit] = {"src": "gps", "xyz": ecef(s[1], s[2], s[3]), "n": s[0], "ll": (s[1], s[2])}
        if self.fix is not None:
            for bit, s in self.sites.items():
                self.fix.site[bit] = self.fix.fr.enu_xyz(*s["xyz"])
        bits = sorted(self.rxs)
        for i, a in enumerate(bits):
            for b in bits[i + 1:]:
                sa, sb = self.sites.get(a), self.sites.get(b)
                self.far[(a, b)] = (int(math.dist(sa["xyz"], sb["xyz"]) / C_AIR * 1e9) + FAR_MARGIN_NS
                                    if sa and sb else FAR_DEFAULT_NS)
        if changed:
            self._meta("site_sum", {self.rxs[b].id: v for b, v in self.site_sum.items()})
            self._db.commit()

    # ── the replies ─────────────────────────────────────────────────────
    def _checkpoint(self) -> None:
        """Write the write-ahead log into mlat.db (from 2026-11-19): a copy of
        the file alone used to end at the last automatic checkpoint, hours
        back.  Nothing else reads the database, so it never waits."""
        try:
            self._db.commit()
            self._db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()
        except Exception as exc:                   # noqa: BLE001
            log.debug("MLAT checkpoint: %s", exc)

    def _drain(self) -> None:
        q = self.q
        while q:
            try:
                t, hx, st = q.popleft()
            except IndexError:
                break
            self._one(t, hx, st)

    def _expected(self, ls: dict, t: float, a: int, b: int):
        """(expected TDOA in ns, receiver b − receiver a; lat; lon) from the
        aircraft's own ADS-B position, None without a fresh one or without both
        sites.  The height is the barometric altitude plus the aircraft's own
        GNSS − barometric difference when it has sent one (from the evening of
        2026-11-18; before: the barometric altitude alone).  From 2026-11-19
        the position is also moved on by its own age when sent (POS_LATENCY)."""
        sa, sb = self.sites.get(a), self.sites.get(b)
        if sa is None or sb is None:
            return None
        lat, lon, pts, alt = ls.get("adsb_lat"), ls.get("adsb_lon"), ls.get("last_adsb_pos_ts"), ls.get("altitude")
        if lat is None or lon is None or pts is None or alt is None:
            return None
        dt = t - pts
        if abs(dt) > POS_MAX_AGE:
            return None
        gs, trk = ls.get("groundspeed"), ls.get("track")
        dt += self.pos_lat                         # the position was already this old when it was sent
        if dt and gs is not None and trk is not None:
            d = float(gs) * 0.514444 * dt
            la = math.radians(lat)
            s2 = math.sin(la) ** 2
            w = math.sqrt(1.0 - E2_WGS * s2)
            m_r, n_r = A_WGS * (1.0 - E2_WGS) / w ** 3, A_WGS / w
            tr = math.radians(float(trk))
            lat = lat + math.degrees(d * math.cos(tr) / m_r)
            lon = lon + math.degrees(d * math.sin(tr) / (n_r * math.cos(la)))
        gmb = ls.get("geo_minus_baro")
        h_ft = float(alt) + (float(gmb) if isinstance(gmb, (int, float)) and abs(gmb) < 3000 else 0.0)
        p = ecef(lat, lon, h_ft * 0.3048)
        return (math.dist(p, sb["xyz"]) - math.dist(p, sa["xyz"])) / C_AIR * 1e9, lat, lon

    def _one(self, t: float, hx: str, st: tuple) -> None:
        try:
            data = bytes.fromhex(hx)
        except ValueError:
            return
        if len(data) not in (7, 14):
            return
        df, icao, checked = address(data)
        c = self.cmin
        c["groups"] += 1
        if icao is None:
            c["no_address"] += 1
            return
        if self.blocked and icao.startswith(self.blocked):
            c["blocked"] += 1
            return
        self._raw_add(t, data, st)
        ls = self.live.get(icao) or self.live.get(icao.lower())
        if ls is None:
            # a parity-overlaid reply of an aircraft not seen before cannot be
            # checked (any bit error gives another "address"): raw file only
            c["unknown" if not checked else "new"] += 1
            if not checked:
                return
            ls = {}
        self.last_group = t
        for bit, _, _ in st:
            if bit in self.crx:
                self.crx_n[bit] += 1
        if self.fix is not None:
            # own position fixes from the replies heard by three or more receivers
            try:
                self.fix.feed(t, len(data), icao, st, ls)
            except Exception as exc:               # noqa: BLE001
                self.fix.c["error"] += 1
                log.debug("MLAT fix: %s", exc)
        st = sorted(x for x in st if x[0] in self.rxs)     # time differences: the GPS-timed receivers only
        for i, (a, ta, siga) in enumerate(st):
            for b, tb, sigb in st[i + 1:]:
                d = stamp_ns(tb) - stamp_ns(ta)
                if d > DAY_NS // 2:
                    d -= DAY_NS
                elif d < -DAY_NS // 2:
                    d += DAY_NS
                if abs(d) > self.far.get((a, b), FAR_DEFAULT_NS):
                    c["far"] += 1
                    continue
                ex = self._expected(ls, t, a, b)
                res = d - ex[0] if ex is not None else None
                # for the page: the last minutes pair by pair (direction from the
                # middle of the two sites; has_pos: the aircraft has an own
                # ADS-B position)
                sec = None
                if ex is not None:
                    la, lb = self.sites[a]["ll"], self.sites[b]["ll"]
                    mlat, mlon = (la[0] + lb[0]) / 2, (la[1] + lb[1]) / 2
                    brg = math.degrees(math.atan2((ex[2] - mlon) * math.cos(math.radians(mlat)), ex[1] - mlat)) % 360
                    sec = int(brg // 30)
                pts = ls.get("last_adsb_pos_ts")
                has_pos = pts is not None and abs(t - pts) < 60
                nacp, nic = ls.get("nac_p"), ls.get("nic")
                good = _good(nacp, nic)
                self.recent.append((t, icao, df, d, res, siga or 0, sigb or 0, a, b, sec,
                                    ls.get("altitude"), has_pos, good, nacp, nic))
                self.min_n[(a, b)] += 1
                if res is not None:
                    # the clock-agreement figures: aircraft with a position of declared good quality only
                    if good:
                        self.min_res.setdefault((a, b), []).append(res)
                    else:
                        self.min_low[(a, b)] += 1
                bk = self.buckets.get((icao, a, b))
                if bk is None:
                    bk = self.buckets[(icao, a, b)] = {"n": 0, "td": [], "ts": 0.0, "sa": 0.0, "sb": 0.0,
                                                       "res": [], "dfs": Counter(), "ls": None}
                bk["n"] += 1
                bk["td"].append(d)
                bk["ts"] += t
                bk["sa"] += siga or 0
                bk["sb"] += sigb or 0
                bk["dfs"][df] += 1
                if res is not None:
                    bk["res"].append(res)
                    bk["ls"] = _snap(ls)           # the aircraft at its last pair with a residual
                elif bk["ls"] is None:
                    bk["ls"] = ls

    def _close_buckets(self, now: float) -> None:
        t0 = int(now // BUCKET_SEC) * BUCKET_SEC
        if self.bucket_t0 is None:
            self.bucket_t0 = t0
            return
        if t0 == self.bucket_t0:
            return
        rows = []
        for (icao, a, b), bk in self.buckets.items():
            n = bk["n"]
            td = sorted(bk["td"])
            med, lo, hi = _stats(bk["res"])
            ls = bk["ls"] or {}
            has = bool(bk["res"])
            rows.append((self.bucket_t0, icao, a, b, n, td[len(td) // 2], bk["ts"] / n,
                         round(bk["sa"] / n, 1), round(bk["sb"] / n, 1), len(bk["res"]),
                         None if med is None else round(med, 1), None if lo is None else round(lo, 1),
                         None if hi is None else round(hi, 1),
                         ls.get("adsb_lat") if has else None, ls.get("adsb_lon") if has else None,
                         ls.get("altitude"), ls.get("groundspeed"), ls.get("track"),
                         ls.get("nac_p"), ls.get("nic"),
                         ",".join(f"{k}:{v}" for k, v in sorted(bk["dfs"].items()))))
        self.buckets = {}
        self.bucket_t0 = t0
        if rows:
            self._db.executemany("INSERT INTO mlat_sum VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
            self._db.commit()
            self.c["rows"] += len(rows)

    def _close_minute(self, now: float) -> None:
        t0 = int(now // 60) * 60
        if self.min_t0 is None:
            self.min_t0 = t0
            return
        if t0 == self.min_t0:
            return
        cm, self.cmin = self.cmin, Counter()
        cm["overflow"], self.overflow = self.overflow, 0
        ex = {k: v for k, v in cm.items() if v}
        low = sum(self.min_low.values())
        if low:
            ex["pos_low"] = low                    # pairs with a position below GOOD_NACP / GOOD_NIC (not in n_res)
        ex["rx"] = self._rx_state()
        extra = json.dumps(ex)
        with self._lock:
            self.c.update(cm)
            for (a, b), n in self.min_n.items():
                res = self.min_res.get((a, b)) or []
                med, lo, hi = _stats(res)
                row = (self.min_t0, a, b, n, len(res),
                       None if med is None else round(med, 1), None if lo is None else round(lo, 1),
                       None if hi is None else round(hi, 1))
                self.minutes.append(row)
                self._db.execute("INSERT OR REPLACE INTO mlat_min VALUES (?,?,?,?,?,?,?,?,?)", row + (extra,))
        self._db.commit()
        self.min_n, self.min_res, self.min_low, self.min_t0 = Counter(), {}, Counter(), t0

    # ── the raw files ───────────────────────────────────────────────────
    def _raw_add(self, t: float, data: bytes, st: tuple) -> None:
        buf = self.raw_buf
        buf += struct.pack("<dBB", t, len(data), len(st))
        buf += data
        for bit, ticks, sig in st:
            buf += struct.pack("<B6sB", bit, ticks.to_bytes(6, "big"), (sig or 0) & 0xFF)

    def _flush_raw(self, now: float) -> None:
        hour = int(now // 3600) * 3600
        if self.raw_hour is not None and hour != self.raw_hour:
            self._raw_close()
        if not self.raw_buf:
            return
        if self.raw_f is None:
            try:
                free = shutil.disk_usage(self.raw_dir).free
            except OSError:
                free = None
            if free is not None and free < MIN_FREE_BYTES:
                self.raw_why = "less than 2 GB of the disk is free"
                self.raw_buf = bytearray()
                return
            name = time.strftime("%Y%m%d_%H", time.gmtime(hour)) + ".mlr"
            path = os.path.join(self.raw_dir, name)
            new = not os.path.exists(path)
            self.raw_f = open(path, "ab")
            self.raw_hour = hour
            self.raw_why = None
            if new:
                head = {"rx": {str(b): r.id for b, r in {**self.rxs, **self.crx}.items()},
                        "clock": self._clocks(), "hour": hour}
                self.raw_f.write(b"MLR1 " + json.dumps(head).encode() + b"\n")
                self._raw_scan()
        self.raw_f.write(self.raw_buf)
        self.raw_f.flush()
        self.c["raw_bytes"] += len(self.raw_buf)
        self.raw_buf = bytearray()

    def _raw_close(self) -> None:
        f, self.raw_f, self.raw_hour = self.raw_f, None, None
        if f is None:
            return
        path = f.name
        f.close()
        try:                                       # compress the closed hour
            with open(path, "rb") as src, gzip.open(path + ".gz", "wb", compresslevel=5) as dst:
                shutil.copyfileobj(src, dst, 1 << 20)
            os.remove(path)
        except OSError as exc:
            log.warning("MLAT recorder: %s not compressed: %s", os.path.basename(path), exc)
        self._raw_scan()

    def _raw_scan(self) -> None:
        """The folder's size; over the cap the oldest hours go first.  Hours
        left open by a restart are compressed here."""
        try:
            names = sorted(n for n in os.listdir(self.raw_dir) if n.endswith((".mlr", ".mlr.gz")))
        except OSError:
            return
        cur = os.path.basename(self.raw_f.name) if self.raw_f is not None else None
        this_hour = time.strftime("%Y%m%d_%H", time.gmtime()) + ".mlr"
        files = []
        for n in names:
            p = os.path.join(self.raw_dir, n)
            if n.endswith(".mlr") and n != cur and n != this_hour:
                try:
                    with open(p, "rb") as src, gzip.open(p + ".gz", "wb", compresslevel=5) as dst:
                        shutil.copyfileobj(src, dst, 1 << 20)
                    os.remove(p)
                    p, n = p + ".gz", n + ".gz"
                except OSError:
                    pass
            try:
                files.append((n, os.path.getsize(p)))
            except OSError:
                pass
        files.sort()
        total = sum(s for _, s in files)
        while files and total > self.raw_cap and len(files) > 1:
            n, s = files.pop(0)
            try:
                os.remove(os.path.join(self.raw_dir, n))
                total -= s
                self.c["raw_removed"] += 1
            except OSError:
                break
        cur_at = next((s for n, s in files if n == cur), 0)
        self.raw_info = {"files": len(files), "bytes": total, "cur_at": cur_at,
                         "oldest": files[0][0][:11] if files else None,
                         "newest": files[-1][0][:11] if files else None}

    # ── for the page (web threads) ──────────────────────────────────────
    def _detail(self, now: float) -> dict:
        """The last 10 minutes pair by pair, summed up for the MLAT tab
        (cached 5 s): histogram of the residual, by direction, by signal
        level, by reply type, by aircraft (5 min) and the newest pairs."""
        if now - self._detail_cache[0] < 5 and self._detail_cache[1] is not None:
            return self._detail_cache[1]
        rec = [r for r in list(self.recent) if r[0] >= now - 600]
        # the figures: pairs of aircraft with a position of declared good quality (from 2026-11-19)
        wr = [r for r in rec if r[4] is not None and r[12]]
        n_low = sum(1 for r in rec if r[4] is not None and not r[12])

        def st(vals):
            med, lo, hi = _stats(vals)
            return (None, None) if med is None else (round(med, 1), round((hi - lo) / 2, 1))

        hist = [0] * 34                            # < −400, 32 bins of 25 ns, ≥ 400
        for r in wr:
            hist[min(33, max(0, int((r[4] + 400) // 25) + 1))] += 1
        sect = []
        for k in range(12):
            v = [r[4] for r in wr if r[9] == k]
            sect.append([len(v), st(v)[0] if len(v) >= 20 else None])
        sig = []
        if len(wr) >= 200:
            ws = sorted(min(r[5], r[6]) for r in wr)
            cuts = [ws[len(ws) // 4], ws[len(ws) // 2], ws[3 * len(ws) // 4]]
            for q in range(4):
                v = [r for r in wr if (q == 0 or min(r[5], r[6]) > cuts[q - 1]) and (q == 3 or min(r[5], r[6]) <= cuts[q])]
                if v:
                    m = sorted(min(r[5], r[6]) for r in v)[len(v) // 2]
                    s_ = st([r[4] for r in v])
                    sig.append([round(20 * math.log10(max(m, 1) / 255.0), 1), len(v), s_[0], s_[1], q])
        dfs = {}
        for r in rec:
            dfs.setdefault(r[2], []).append(r[4] if r[12] else None)
        by_df = []
        for df, v in sorted(dfs.items()):
            w = [x for x in v if x is not None]
            s_ = st(w)
            by_df.append([df, len(v), len(w), s_[0], s_[1]])
        ac = {}
        for r in rec:
            if r[0] >= now - 300:
                ac.setdefault(r[1], []).append(r)
        all_s = st([r[4] for r in wr])
        ref = all_s[0] if all_s[0] is not None and len(wr) >= 200 else 0.0
        rows, misfit = [], []
        for icao, v in ac.items():
            w = [x[4] for x in v if x[4] is not None]      # every pair with a position, whatever its quality
            s_ = st(w)
            last = v[-1]
            # the own position does not fit the timing (plan step 0c, a first form): the aircraft's median
            # is far from that of the aircraft with good positions.  Typical: no GNSS, the position drifts.
            off = len(w) >= MISFIT_MIN and s_[0] is not None and abs(s_[0] - ref) > MISFIT_NS
            rows.append([icao, len(v), len(w), s_[0], s_[1],
                         round(20 * math.log10(max(sum(x[5] for x in v) / len(v), 1) / 255.0), 1),
                         round(20 * math.log10(max(sum(x[6] for x in v) / len(v), 1) / 255.0), 1), last[10],
                         any(x[11] for x in v), bool(last[12]), bool(off), last[13], last[14]])
            if off:
                misfit.append([icao, len(w), round(s_[0] - ref), last[13], last[14], last[10], bool(last[12])])
        rows.sort(key=lambda x: -x[1])
        misfit.sort(key=lambda x: -abs(x[2]))
        latest = [[round(r[0], 3), r[1], r[2], r[3], None if r[4] is None else round(r[4]), r[5], r[6], r[10], r[11],
                   bool(r[12])] for r in rec[-60:]][::-1]
        out = {"window_sec": 600, "n": len(rec), "n_res": len(wr), "med": all_s[0], "spread": all_s[1],
               "hist": hist, "sectors": sect, "by_signal": sig, "by_df": by_df,
               "aircraft": rows[:80], "aircraft_n": len(rows), "no_position_n": sum(1 for x in rows if not x[8]),
               "latest": latest,
               # from 2026-11-19
               "n_low": n_low, "low_quality_n": sum(1 for x in rows if x[2] and not x[9]),
               "misfit": misfit[:20], "misfit_ns": MISFIT_NS, "misfit_min": MISFIT_MIN,
               "quality": {"nacp": GOOD_NACP, "nic": GOOD_NIC}, "pos_latency": self.pos_lat}
        self._detail_cache = (now, out)
        return out

    def public(self, detail: bool = False) -> dict:
        now = time.time()
        with self._lock:
            minutes = [m for m in self.minutes if m[0] >= now - 86400]
            c = dict(self.c)
        try:
            from collector import multirx
            amb = multirx.merger().public(1440).get("mlat_amb", 0)
        except Exception:                          # noqa: BLE001
            amb = None
        bits = sorted(self.rxs)
        pairs = []
        for i, a in enumerate(bits):
            for b in bits[i + 1:]:
                wins = {}
                mine = [m for m in minutes if m[1] == a and m[2] == b]
                for w in (10, 60, 1440):
                    cut = now - w * 60
                    mm = [m for m in mine if m[0] >= cut]
                    n = sum(m[3] for m in mm)
                    n_res = sum(m[4] for m in mm)
                    # from the minutes' own values (kept over a restart): the
                    # median of the minute medians and the typical range within
                    # a minute, each minute weighted by its pairs
                    med, lo, hi = (_wmed([(m[i], m[4]) for m in mm if m[i] is not None]) for i in (5, 6, 7))
                    wins[str(w)] = {"n": n, "n_res": n_res,
                                    "med": None if med is None else round(med, 1),
                                    "lo": None if lo is None else round(lo, 1),
                                    "hi": None if hi is None else round(hi, 1)}
                pairs.append({"a": a, "b": b, "windows": wins,
                              "series": [[m[0], m[3], m[4], m[5], m[6], m[7]] for m in mine]})
        last_min = [m for m in minutes if m[0] >= now - 120]
        try:
            du = shutil.disk_usage(self.raw_dir)
            free = du.free
        except OSError:
            free = None
        db_bytes = 0
        for ext in ("", "-wal"):
            try:
                db_bytes += os.path.getsize(self.db_path + ext)
            except OSError:
                pass
        raw = dict(self.raw_info)
        f = self.raw_f
        if f is not None:                          # the open hour has grown since the last look at the folder
            try:
                raw["bytes"] += max(0, os.path.getsize(f.name) - raw.get("cur_at", 0))
            except OSError:
                pass
        raw.pop("cur_at", None)
        rxs = self._rx_state()
        from collector import radarcape_status as _rs
        recv = []
        for b in bits:
            x = rxs.get(self.rxs[b].id) or {}
            red, amber = _rs.gps_problems(x["gps"]) if isinstance(x.get("gps"), list) else ([], [])
            recv.append({"bit": b, "id": self.rxs[b].id, "clock": self.rxs[b].clock_state,
                         "site": x.get("site"), "site_n": x.get("site_n"), "temp": x.get("temp"),
                         "gps_known": isinstance(x.get("gps"), list), "gps_red": red, "gps_amber": amber})
        return {
            "on": True, "since": self.started, "err": self.err, "now": now,
            "detail": self._detail(now) if detail else None,
            "receivers": recv,
            "counter_receivers": [{"bit": b, "id": r.id, "clock": r.clock_state, "kind": r.clock,
                                   "n": self.crx_n.get(b, 0)} for b, r in sorted(self.crx.items())],
            "pairs": pairs,
            "rate": (sum(m[3] for m in last_min) / (60.0 * max(1, len({m[0] for m in last_min})))
                     if last_min else None),
            "last_group": self.last_group, "queue": len(self.q),
            "counters": {k: c.get(k, 0) for k in ("groups", "blocked", "no_address", "unknown", "new", "far",
                                                  "overflow", "rows", "raw_bytes", "raw_removed")},
            "ambiguous_24h": amb,
            "raw": dict(raw, cap=self.raw_cap, why=self.raw_why,
                        writing=self.raw_f is not None, dir_free=free),
            "db_bytes": db_bytes, "bucket_sec": BUCKET_SEC,
        }


_REC: Recorder | None = None
_WHY = "the collector has not started it"


def init(cfg, live_state: dict):
    """Start the recorder when the receivers are merged and two or more of
    them have GPS time (Radarcapes).  Returns it, or None with the reason kept
    for the page."""
    global _REC, _WHY
    from collector import multirx
    if not bool(getattr(cfg, "MLAT_RECORD", True)):
        _WHY = "switched off (MLAT_RECORD = False)"
        return None
    if not multirx.merging():
        _WHY = "the receivers are not merged on this server"
        return None
    rxs = [r for r in [multirx.main_rx()] + list(multirx.extras()) if r is not None and r.hz is None]
    if len(rxs) < 2:
        _WHY = "fewer than two receivers with GPS time"
        return None
    # the receivers with a counter clock: their raw stamps are recorded with the
    # replies (once lined up with the main receiver), no time differences yet
    counters = [r for r in multirx.extras() if r.hz is not None]
    _REC = Recorder(cfg, rxs, live_state, counters)
    # own position fixes (from 2026-11-19): with three or more receivers
    if bool(getattr(cfg, "MLAT_FIX", True)) and len(rxs) + len(counters) >= 3:
        try:
            from collector import mlat_fix
            _REC.fix = mlat_fix.Fixer(cfg, _REC.rxs, _REC.crx, live_state)
        except Exception as exc:                   # noqa: BLE001
            log.warning("MLAT fixes not started: %s", exc)
    multirx._MLAT_PUT = _REC.put
    threading.Thread(target=_REC.run, name="mlat_rec", daemon=True).start()
    return _REC


def get() -> Recorder | None:
    return _REC


def tdoa_rows(icao: str, t0: float, t1: float) -> list:
    """[(t, a, b, tdoa ns (receiver b − a), pressure altitude ft)] of one
    aircraft between t0 and t1, from the pairs of the last minutes — for the
    runway side of a landing found without a position (collector/
    blind_approach.py, from 2026-11-19).  [] without a recorder."""
    if _REC is None:
        return []
    ic = (icao or "").upper()
    return [(r[0], r[7], r[8], r[3], r[10]) for r in list(_REC.recent)
            if t0 <= r[0] <= t1 and r[1] is not None and r[1].upper() == ic]


def tdoa_expected(a: int, b: int, lat: float, lon: float, h_m: float):
    """Expected time difference in ns (receiver b − a) of a reply sent at
    (lat, lon, height h_m), None without both sites."""
    if _REC is None:
        return None
    sa, sb = _REC.sites.get(a), _REC.sites.get(b)
    if sa is None or sb is None:
        return None
    p = ecef(lat, lon, h_m)
    return (math.dist(p, sb["xyz"]) - math.dist(p, sa["xyz"])) / C_AIR * 1e9


def fix_public(win: float = 600.0, since: float = 0.0) -> dict:
    """The own position fixes for the MLAT map (collector/mlat_fix.py)."""
    if _REC is None:
        return {"on": False, "why": _WHY}
    if _REC.fix is None:
        return {"on": False, "why": "needs three receivers (MLAT_FIX)"}
    return _REC.fix.public(win, since)


def public(detail: bool = False) -> dict:
    if _REC is None:
        return {"on": False, "why": _WHY}
    return _REC.public(detail)
