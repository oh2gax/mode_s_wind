"""
msg_stats.py — Mode S / ADS-B message statistics for the Statistics page
(from 2026-10-25).

Counts, in RAM only (no database writes), what the collector receives from the
Radarcape Beast feed and the JSON poller:

  • feed      — messages (short 56-bit / long 112-bit), decode errors, blocked
                addresses, last message time, connection count
  • DF        — downlink formats 0 / 4 / 5 / 11 / 16 / 17 / 18 / 20 / 21 / 24
  • ADS-B     — DF17 type codes, velocity subtypes, ADS-B version (TC 31),
                velocity messages carrying the GNSS − baro height difference
  • Comm-B    — DF20/21 registers as inferred by pyModeS (BDS 1,0 … 6,0),
                ambiguous inferences (more than one candidate), replies whose
                address could not be verified
  • cadence   — time between successive replies of the same aircraft for BDS
                5,0 / 6,0 / 4,0 / 2,0, the surveillance replies DF4/5 and the
                ADS-B position / velocity squitters, by flight phase (final
                approach, terminal area, en route); near-duplicate replies
                (< 0.5 s; ADS-B squitters < 0.15 s) are counted apart, gaps over
                60 s are not intervals
  • interrogators — DF11 all-call replies: the CRC remainder of a DF11 reply is
                its interrogator identifier (II code 1–15, or SI code 1–63;
                0 = an acquisition squitter or a reply to II 0, which cannot be
                told apart), so the replies show which ground interrogators are
                active; the UM field of DF4/5/20/21
                (IIS / IDS: interrogator holding a reservation, its type)
  • meteo     — per new BDS 5,0 / 6,0 reply: a wind computed, a partner too
                old, or no wind (no partner in time / rejected by the checks);
                MRAR (BDS 4,4) and MHR (BDS 4,5) reports
  • JSON      — MLAT and ADS-B positions in the Radarcape aircraft list, WAM
                ground stations (blocked addresses such as T40…) it lists
  • signal    — the Beast signal-level byte of every frame (collector/beast_sig.py)
                as dBFS = 20·log10(byte / 255), a 2-dB histogram per message
                class (all, ADS-B DF17/18, replies DF4/5/20/21, all-call DF11,
                ACAS DF0/16), and the frames ≥ −3 dBFS (near the top of the
                receiver's range)
  • range     — ADS-B airborne positions decoded from our own reception
                (DF17 TC 9–18 / 20–22): the farthest position per 10° bearing
                sector and altitude band (< FL100, FL100–FL245, ≥ FL250) from
                the antenna (ANTENNA_LAT / ANTENNA_LON, default RECEIVER_LAT /
                RECEIVER_LON), and the positions, aircraft and signal per range
                band.  A position counts only when it fits the aircraft's
                previous one (a single bad decode cannot set a record).

Kept over restarts (from 2026-10-25 evening): each closed clock hour is
written as one compressed row to msg_stats_hours (about 2–8 kB, kept
MSG_STATS_DAYS = 7 days; written by the housekeeping thread within a minute
of the hour's end), and at a clean stop the hour in progress, the minute
records, the 24 h series, the 10-s rate series, the interrogators' first /
last times and the recent health changes go to msg_stats_state (one row).
At the start restore() reads them back; the time the server was down is a
gap (not counted in the rates, a break in the charts).  After a crash or a
power cut only the hour in progress is lost.

Windows: one record per minute (counters, interval histograms, aircraft sets)
for the last hour, the same merged per clock hour for the last 24 h (the
24 h window), a compact per-minute vector of the main series for 24 h, and the
message count per 10 s for the last hour (rate sparkline).  The 7 d window
(from 2026-10-26, WEEK_MIN) adds the stored hours of msg_stats_hours older than
the 24 h: read and merged once per clock hour (about 1 s on a Pi 4) while the
page asks for it and dropped after an hour without a request; its chart series
is the stored minutes binned per 10 min.  Nothing more is written.  About 2–4 MB of
RAM for the hour plus up to ~10–15 MB for the 24 hourly records in daytime
traffic.  The counting costs a few microseconds per message (dictionary
increments; one CRC per DF11 reply; one distance per ADS-B position).

Thread safety: the collector thread and the JSON poller write, the web thread
reads a snapshot (one lock; held only for increments and the snapshot copy).
"""

from __future__ import annotations

import json
import logging
import math
import threading
import time
import zlib
from collections import Counter, deque

log = logging.getLogger("modes.msg_stats")

# Interval histogram edges (s): bin i holds edges[i-1] <= dt < edges[i]
CAD_EDGES = (0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0, 15.0, 20.0, 30.0, 60.0)
CAD_DUP_SEC = 0.5          # closer replies of the same register: near-duplicates
CAD_DUP_ES_SEC = 0.15      # … for the ADS-B squitters, sent by themselves every 0.4–0.6 s
CAD_GAP_SEC = 60.0         # longer: a gap, not an interval
CAD_KINDS = ("5,0", "6,0", "4,0", "2,0", "surv", "es_pos", "es_vel")
PHASES = ("final", "terminal", "enroute")
FINAL_ALT_FT, FINAL_NM = 5_000.0, 25.0
TERM_ALT_FT, TERM_NM = 10_000.0, 60.0
EHS_SILENT_SEC = 30.0      # an EHS aircraft with no BDS 5,0 for this long is "silent"
MINUTES_DETAIL = 60        # full minute records kept (1 h)
MINUTES_TREND = 1440       # compact minute vectors kept (24 h)
HOURS_DETAIL = 24          # hourly merged records (the 24 h window)
WINDOW_MAX_MIN = 1440
WEEK_MIN = 10080           # the 7 d window (from 2026-10-26): read from msg_stats_hours
WEEK_STEP_SEC = 600        # the 7 d chart: per 10 min
WEEK_CACHE_IDLE_SEC = 3600 # the merged 7 d rows are dropped when not asked for this long

# signal level: 2-dB bins from −50 to 0 dBFS (byte 1 = −48.1 dBFS, 255 = 0)
SIG_BINS = 25
SIG_LO_DB, SIG_STEP_DB = -50.0, 2.0
SIG_STRONG_BYTE = 180      # ≥ −3.0 dBFS
SIG_CATS = ("all", "adsb", "reply", "df11", "acas", "other")
_SIG_BIN = [0] + [min(SIG_BINS - 1, max(0, int((20 * math.log10(b / 255.0) - SIG_LO_DB) // SIG_STEP_DB)))
                  for b in range(1, 256)]
_DF_SIGCAT = {17: "adsb", 18: "adsb", 4: "reply", 5: "reply", 20: "reply", 21: "reply",
              11: "df11", 0: "acas", 16: "acas"}

# range
RNG_SECTORS = 36           # 10° bearing sectors
RNG_EDGES_NM = (0, 25, 50, 100, 150, 200, 250, 300)   # bands; the last is 300 NM →
RNG_MAX_NM = 400.0         # farther: implausible for 1090 MHz, not counted
RNG_ALT = ("low", "mid", "high")                     # < FL100, FL100–FL245, ≥ FL250

# compact 24 h series (per minute)
TREND_KEYS = ("msgs", "df4", "df5", "df11", "df17", "df20", "df21", "bds50", "bds60",
              "bds40", "bds20", "bds44", "ac", "ehs", "iid_n", "wind", "cad50_final",
              "cad50_term", "cad50_enr")

_EFHK = (60.3172, 24.9633)

# CRC-24 (Mode S, polynomial 0xFFF409), own table so it does not depend on the
# pyModeS version
_CRC_TABLE: list[int] = []
for _i in range(256):
    _c = _i << 16
    for _ in range(8):
        _c = ((_c << 1) ^ 0xFFF409) if _c & 0x800000 else (_c << 1)
    _CRC_TABLE.append(_c & 0xFFFFFF)


def crc_remainder(msg_hex: str) -> int | None:
    """Mode S CRC remainder of a 56- or 112-bit message (hex)."""
    try:
        n = int(msg_hex, 16)
    except ValueError:
        return None
    bits = len(msg_hex) * 4
    if bits not in (56, 112):
        return None
    crc, shift = 0, bits - 8
    for _ in range((bits - 24) // 8):
        crc = ((crc << 8) & 0xFFFFFF) ^ _CRC_TABLE[((crc >> 16) ^ (n >> shift)) & 0xFF]
        shift -= 8
    return crc ^ (n & 0xFFFFFF)


def df11_iid(msg_hex: str) -> tuple[str, int] | None:
    """Interrogator of a DF11 all-call reply: ("II", 1–15), ("SI", 1–63),
    ("SQ", 0) for an acquisition squitter or a reply to II 0 (the same bits),
    None when the remainder is not a valid interrogator code (a corrupted
    reply)."""
    r = crc_remainder(msg_hex)
    if r is None or r & ~0x7F:
        return None
    if r == 0:
        return ("SQ", 0)
    if r < 16:
        return ("II", r)
    return ("SI", r - 16)


def _dist_nm(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 3440.065 * 2 * math.asin(min(1.0, math.sqrt(a)))


def _new_minute(t0: float) -> dict:
    # c counters, h interval histograms, ac aircraft sets, s signal histograms,
    # r farthest position per sector {alt band: [[nm, alt, icao] | None] * 36}
    return {"t0": t0, "c": Counter(), "h": {}, "ac": {}, "ivar": {}, "s": {}, "r": {}}


def _merge(dst: dict, m: dict) -> None:
    """Add minute / hour record m into dst."""
    dst["c"].update(m["c"])
    for key in ("h", "s"):
        d = dst[key]
        for k, h in m[key].items():
            t = d.get(k)
            if t is None:
                d[k] = list(h)
            else:
                for i, v in enumerate(h):
                    t[i] += v
    for k, st in m["ac"].items():
        t = dst["ac"].get(k)
        if t is None:
            dst["ac"][k] = set(st)
        else:
            t.update(st)
    for band, sec in m["r"].items():
        t = dst["r"].get(band)
        if t is None:
            dst["r"][band] = [list(x) if x else None for x in sec]
            continue
        for i, x in enumerate(sec):
            if x and (t[i] is None or x[0] > t[i][0]):
                t[i] = list(x)


# ── encoding for the database (keys are strings or tuples) ─────────────────

def _kenc(k):
    return list(k) if isinstance(k, tuple) else k


def _kdec(k):
    return tuple(k) if isinstance(k, list) else k


def _rec_enc(m: dict) -> dict:
    return {"t0": m["t0"],
            "c": [[_kenc(k), v] for k, v in m["c"].items()],
            "h": [[_kenc(k), v] for k, v in m["h"].items()],
            "s": [[_kenc(k), v] for k, v in m["s"].items()],
            "ac": [[_kenc(k), sorted(v)] for k, v in m["ac"].items()],
            "r": m["r"]}


def _rec_dec(d: dict) -> dict:
    m = _new_minute(float(d["t0"]))
    m["c"] = Counter({_kdec(k): v for k, v in d.get("c", [])})
    m["h"] = {_kdec(k): list(v) for k, v in d.get("h", [])}
    m["s"] = {_kdec(k): list(v) for k, v in d.get("s", [])}
    m["ac"] = {_kdec(k): set(v) for k, v in d.get("ac", [])}
    m["r"] = {b: [list(x) if x else None for x in sec] for b, sec in (d.get("r") or {}).items()}
    return m


def _pack(obj) -> bytes:
    return zlib.compress(json.dumps(obj, separators=(",", ":")).encode(), 6)


def _unpack(blob) -> dict:
    return json.loads(zlib.decompress(blob).decode())


def ensure_tables(db) -> None:
    db.execute("""CREATE TABLE IF NOT EXISTS msg_stats_hours (
                      ts   INTEGER PRIMARY KEY,   -- clock hour (UTC, Unix s)
                      data BLOB    NOT NULL)""")   # zlib(JSON {v, rec, trend})
    db.execute("""CREATE TABLE IF NOT EXISTS msg_stats_state (
                      k     TEXT PRIMARY KEY,     -- 'state'
                      saved REAL NOT NULL,        -- time of the save
                      data  BLOB NOT NULL)""")    # zlib(JSON), written at a clean stop
    db.commit()


def _dest(lat, lon, brg_deg, nm):
    """The point nm nautical miles from (lat, lon) on the initial bearing brg_deg."""
    d = nm / 3440.065
    p1, l1, b = math.radians(lat), math.radians(lon), math.radians(brg_deg)
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), (math.degrees(l2) + 540.0) % 360.0 - 180.0


def _bearing(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def _sig_quantile(hist: list, q: float) -> float | None:
    n = sum(hist)
    if n == 0:
        return None
    target, acc = q * n, 0.0
    for i, k in enumerate(hist):
        if acc + k >= target and k > 0:
            return round(SIG_LO_DB + SIG_STEP_DB * (i + (target - acc) / k), 1)
        acc += k
    return 0.0


def _hist_quantile(hist: list, q: float, lo: float = CAD_DUP_SEC) -> float | None:
    n = sum(hist)
    if n == 0:
        return None
    target, acc = q * n, 0.0
    for i, k in enumerate(hist):
        hi = CAD_EDGES[i + 1] if i + 1 < len(CAD_EDGES) else CAD_GAP_SEC
        if acc + k >= target and k > 0:
            return round(lo + (hi - lo) * (target - acc) / k, 2)
        acc += k
        lo = hi
    return round(lo, 2)


class MsgStats:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.airport = _EFHK
        self.started = time.time()
        self.since = self.started                    # the oldest data held (earlier after a restore)
        self.keep_days = 7.0                         # MSG_STATS_DAYS
        self._gaps: list = []                        # [(stop, start)] server down times (restores)
        self._pending: list = []                     # closed hours to be written to msg_stats_hours
        self.connects = 0
        self.connected_ts: float | None = None
        self.last_msg_ts: float | None = None
        self.total_msgs = 0
        self._min: dict = _new_minute(self._minute_of(time.time()))
        self._minutes: deque = deque(maxlen=MINUTES_DETAIL)
        self._hour: dict | None = None               # the current clock hour (closed minutes)
        self._hours: deque = deque(maxlen=HOURS_DETAIL)
        self._hours_cache: tuple | None = None       # (key, merged closed hours)
        self._week_lock = threading.Lock()           # one reader of msg_stats_hours at a time
        self._week_cache: dict | None = None         # the 7 d part older than the 24 h (see _week)
        self.site = _EFHK                            # antenna position for the range
        self.site_src = "centre"                     # radarcape (its GPS) / config (ANTENNA_*) / centre
        self.site_cfg = None                         # ANTENNA_LAT / ANTENNA_LON (fallback), or None
        self.site_centre = _EFHK                     # RECEIVER_LAT / RECEIVER_LON (last resort)
        self.site_rc_why = None                      # why the Radarcape position is not used (plain words)
        self.site_alt = None                         # antenna altitude (m), from the Radarcape
        self.sig_state = "off"                       # on / off / unavailable (set by the collector)
        self._cur_sig: int | None = None             # signal byte of the frame being decoded
        self._rpos: dict = {}                        # icao → (ts, lat, lon) of the last ADS-B position
        self._trend: deque = deque(maxlen=MINUTES_TREND)
        self._ten: deque = deque(maxlen=360)          # [t0, msgs] per 10 s
        self._ten_cur = [self._ten_of(time.time()), 0]
        self._last: dict = {}        # (icao, kind) → time of the last reply
        self._seen: dict = {}        # icao → time of the last message (any)
        self._b50: dict = {}         # icao → time of the last BDS 5,0 reply
        self._iid_seen: dict = {}    # ("II", n) → [first, last]
        self._json: dict = {"ts": None, "entries": 0, "mlat": 0, "adsb": 0, "other": 0,
                            "polls": 0, "errors": 0, "stations": {}}

    # ── time slots ──────────────────────────────────────────────────────────
    @staticmethod
    def _minute_of(t: float) -> float:
        return float(int(t // 60) * 60)

    @staticmethod
    def _ten_of(t: float) -> float:
        return float(int(t // 10) * 10)

    def _roll(self, now: float) -> None:
        """Close the minute / 10-s slots that have ended (lock held)."""
        t10 = self._ten_of(now)
        if t10 != self._ten_cur[0]:
            self._ten.append(tuple(self._ten_cur))
            # empty 10-s slots in between (feed stalled)
            t = self._ten_cur[0] + 10
            while t < t10 and len(self._ten) < 400:
                self._ten.append((t, 0))
                t += 10
            self._ten_cur = [t10, 0]
        tm = self._minute_of(now)
        if tm != self._min["t0"]:
            m = self._min
            self._minutes.append(m)
            self._trend.append(self._compact(m))
            self._min = _new_minute(tm)
            # hourly record for the 24 h window
            th = float(int(m["t0"] // 3600) * 3600)
            if self._hour is not None and self._hour["t0"] != th:
                self._hours.append(self._hour)
                self._pending.append(self._hour)
                self._hour = None
            if self._hour is None:
                self._hour = _new_minute(th)
            _merge(self._hour, m)
            # forget per-aircraft state of aircraft not heard for 10 min
            if len(self._seen) > 50:
                cut = now - 600
                for icao in [i for i, t in self._seen.items() if t < cut]:
                    self._seen.pop(icao, None)
                    self._b50.pop(icao, None)
                for k in [k for k, t in self._last.items() if t < cut]:
                    del self._last[k]
                for k in [k for k, v in self._rpos.items() if v[0] < cut]:
                    del self._rpos[k]

    def _compact(self, m: dict) -> list:
        c = m["c"]
        def med(kind, ph):
            h = m["h"].get((kind, ph))
            return _hist_quantile(h, 0.5) if h else None
        ac = m["ac"]
        return [m["t0"], c["msgs"], c[("df", 4)], c[("df", 5)], c[("df", 11)], c[("df", 17)],
                c[("df", 20)], c[("df", 21)], c[("bds", "5,0")], c[("bds", "6,0")],
                c[("bds", "4,0")], c[("bds", "2,0")], c[("bds", "4,4")],
                len(ac.get("all", ())), len(ac.get("ehs", ())),
                len({k for k in c if isinstance(k, tuple) and k[0] == "iid" and k[1] != "SQ"}),
                c[("met", "wind")], med("5,0", "final"), med("5,0", "terminal"), med("5,0", "enroute")]

    # ── feed events (collector thread) ──────────────────────────────────────
    def choose_site(self, rc_pos=None, why=None) -> None:
        """Centre of the range rings (from 2026-10-26): the Radarcape's own GPS
        position while it is good (`rc_pos`), else ANTENNA_LAT / ANTENNA_LON,
        else RECEIVER_LAT / RECEIVER_LON (the map centre)."""
        self.site_rc_why = None if rc_pos else why
        if rc_pos:
            self.site, self.site_src = (float(rc_pos[0]), float(rc_pos[1])), "radarcape"
        elif self.site_cfg:
            self.site, self.site_src = self.site_cfg, "config"
        else:
            self.site, self.site_src = self.site_centre, "centre"

    def connected(self) -> None:
        with self._lock:
            self.connects += 1
            self.connected_ts = time.time()

    def raw(self, ts: float, msg_hex: str, sig: int | None = None) -> None:
        """Every frame from the feed, before decoding (sig: the Beast signal
        byte 0–255, None when not available)."""
        now = time.time()
        self._cur_sig = sig
        with self._lock:
            self._roll(now)
            self.total_msgs += 1
            self.last_msg_ts = now
            self._ten_cur[1] += 1
            c = self._min["c"]
            c["msgs"] += 1
            c["short" if len(msg_hex) <= 14 else "long"] += 1
            if sig is not None:
                if sig <= 0:
                    c["sig0"] += 1
                    return
                try:
                    cat = _DF_SIGCAT.get(int(msg_hex[:2], 16) >> 3, "other")
                except ValueError:
                    cat = "other"
                b = _SIG_BIN[sig if sig < 256 else 255]
                s = self._min["s"]
                for k in (("sig", "all"), ("sig", cat)):
                    h = s.get(k)
                    if h is None:
                        h = s[k] = [0] * SIG_BINS
                    h[b] += 1
                if sig >= SIG_STRONG_BYTE:
                    c[("sig_strong", "all")] += 1
                    c[("sig_strong", cat)] += 1

    def count(self, key) -> None:
        with self._lock:
            self._min["c"][key] += 1

    def _ac(self, cat, icao) -> None:
        s = self._min["ac"].get(cat)
        if s is None:
            s = self._min["ac"][cat] = set()
        s.add(icao)

    def _cadence(self, icao: str, kind: str, ts: float, phase: str | None) -> None:
        key = (icao, kind)
        prev = self._last.get(key)
        self._last[key] = ts
        if prev is None or phase is None:
            return
        dt = ts - prev
        c = self._min["c"]
        if dt < 0:
            return
        if dt < (CAD_DUP_ES_SEC if kind.startswith("es_") else CAD_DUP_SEC):
            c[("dup", kind)] += 1
            c[("dup_ph", kind, phase)] += 1
            self._last[key] = prev      # keep the first of the pair as the reference
            return
        c[("cad_n", kind, phase)] += 1
        if dt >= CAD_GAP_SEC:
            c[("gap", kind, phase)] += 1
            return
        h = self._min["h"].get((kind, phase))
        if h is None:
            h = self._min["h"][(kind, phase)] = [0] * len(CAD_EDGES)
        i = 0
        while i + 1 < len(CAD_EDGES) and dt >= CAD_EDGES[i + 1]:
            i += 1
        h[i] += 1

    def _range(self, icao: str, ts: float, lat: float, lon: float, alt) -> None:
        """One decoded ADS-B airborne position (lock held)."""
        prev = self._rpos.get(icao)
        self._rpos[icao] = (ts, lat, lon)
        if prev is None or not 0 <= ts - prev[0] <= 60:
            return                       # the first position of a visit: not yet confirmed
        if _dist_nm(prev[1], prev[2], lat, lon) > 2.0 + 0.35 * (ts - prev[0]):
            self._min["c"]["rng_jump"] += 1
            return
        d = _dist_nm(self.site[0], self.site[1], lat, lon)
        c = self._min["c"]
        if d > RNG_MAX_NM:
            c["rng_far"] += 1
            return
        c["rng_n"] += 1
        band = ("low" if alt is not None and alt < 10_000 else
                "high" if alt is not None and alt >= 25_000 else "mid")
        sec = self._min["r"].get(band)
        if sec is None:
            sec = self._min["r"][band] = [None] * RNG_SECTORS
        i = int(_bearing(self.site[0], self.site[1], lat, lon) // (360 / RNG_SECTORS)) % RNG_SECTORS
        if sec[i] is None or d > sec[i][0]:
            sec[i] = [round(d, 1), int(alt) if alt is not None else None, icao]
        rb = len(RNG_EDGES_NM) - 1
        for j in range(1, len(RNG_EDGES_NM)):
            if d < RNG_EDGES_NM[j]:
                rb = j - 1
                break
        c[("rbn", rb)] += 1
        self._ac(("rb", rb), icao)
        sig = self._cur_sig
        if sig:
            k = ("rb", rb)
            h = self._min["s"].get(k)
            if h is None:
                h = self._min["s"][k] = [0] * SIG_BINS
            h[_SIG_BIN[sig if sig < 256 else 255]] += 1

    def message(self, ts: float, msg_hex: str, result: dict, alt, lat, lon) -> None:
        """One decoded, not blocked message (collector thread)."""
        df = result.get("df")
        icao = result.get("icao") or ""
        phase = None
        if alt is not None and lat is not None and lon is not None:
            d = _dist_nm(lat, lon, *self.airport)
            phase = ("final" if alt < FINAL_ALT_FT and d <= FINAL_NM else
                     "terminal" if alt < TERM_ALT_FT and d <= TERM_NM else "enroute")
        iid = df11_iid(msg_hex) if df == 11 else None
        with self._lock:
            c = self._min["c"]
            c[("df", df)] += 1
            self._ac("all", icao)
            self._ac(("df", df), icao)
            self._seen[icao] = ts
            if df == 17:
                tc = result.get("typecode")
                c[("tc", tc)] += 1
                self._ac("df17", icao)
                if tc is not None and (9 <= tc <= 18 or 20 <= tc <= 22):
                    self._cadence(icao, "es_pos", ts, phase)
                    plat, plon = result.get("latitude"), result.get("longitude")
                    if plat is not None and plon is not None:
                        self._range(icao, ts, plat, plon, alt)
                elif tc == 19:
                    c[("v19", result.get("subtype"))] += 1
                    if result.get("geo_minus_baro") is not None:
                        c["gmb"] += 1
                    self._cadence(icao, "es_vel", ts, phase)
                elif tc == 31 and result.get("version") is not None:
                    c[("ver", result.get("version"))] += 1
                    self._ac(("ver", result.get("version")), icao)
            elif df in (20, 21):
                bds = result.get("bds") or "?"
                c[("bds", bds)] += 1
                self._ac(("bds", bds), icao)
                self._ac("commb", icao)
                cand = result.get("bds_candidates")
                if cand and len(cand) > 1:
                    c["ambig"] += 1
                if result.get("icao_verified") is False:
                    c["unverified"] += 1
                if bds in ("5,0", "6,0"):
                    self._ac("ehs", icao)
                    if bds == "5,0":
                        self._b50[icao] = ts
                if bds in ("5,0", "6,0", "4,0", "2,0"):
                    self._cadence(icao, bds, ts, phase)
            elif df == 11:
                if iid is None:
                    c["df11_bad"] += 1
                else:
                    c[("iid",) + iid] += 1
                    if iid[0] != "SQ":
                        self._ac(("iid",) + iid, icao)
                        fl = self._iid_seen.get(iid)
                        if fl is None:
                            self._iid_seen[iid] = [ts, ts]
                        else:
                            fl[1] = ts
            if df in (4, 5, 20, 21):
                um = result.get("utility_message")
                if um:
                    c[("um", um >> 2, um & 3)] += 1
                if df in (4, 5):
                    self._cadence(icao, "surv", ts, phase)

    def meteo(self, kind: str) -> None:
        """Per new BDS 5,0 / 6,0 reply: 'wind' (a wind computed and stored),
        'wind_old' (its partner reply older than WIND_MAX_AGE_SEC), 'nowind'
        (no partner within WIND_MAX_PAIR_AGE, or rejected by the checks: roll,
        track rate, speed); 'temp' (Mach/TAS temperature with the wind);
        'mrar' / 'mhr' per BDS 4,4 / 4,5 report."""
        with self._lock:
            self._min["c"][("met", kind)] += 1

    # ── JSON poller ──────────────────────────────────────────────────────────
    def json_poll(self, entries: int, mlat: int, adsb: int, other: int,
                  stations: dict | None = None) -> None:
        now = time.time()
        with self._lock:
            j = self._json
            j.update(ts=now, entries=entries, mlat=mlat, adsb=adsb, other=other)
            j["polls"] += 1
            for code, info in (stations or {}).items():
                s = j["stations"].setdefault(code, {"first": now})
                s.update(info)
                s["last"] = now
            self._min["c"]["json_polls"] += 1
            self._min["c"]["json_mlat"] += mlat

    def json_error(self) -> None:
        with self._lock:
            self._json["errors"] += 1

    # ── snapshot (web thread) ───────────────────────────────────────────────
    def coverage(self, hours: int = 24) -> dict:
        """The receiver's coverage of the last `hours` (1–24) for the Live Map
        (from 2026-10-31): per 10° bearing sector the farthest ADS-B airborne
        position of any height (the range rings' data, RAM only — a few
        microseconds), as an outline of points at the sector's middle bearing.
        A list of receivers, so more receivers can be combined later (the page
        draws the outline of their union); the position rounded to 0.01°."""
        now = time.time()
        hours = max(1, min(HOURS_DETAIL, int(hours)))
        with self._lock:
            self._roll(now)
            h0 = float(int(now // 3600) * 3600) - (hours - 1) * 3600
            recs = [h for h in self._hours if h["t0"] >= h0] + ([self._hour] if self._hour else []) + [self._min]
            best = [None] * RNG_SECTORS
            for m in recs:
                for band, sec in (m.get("r") or {}).items():
                    for i, x in enumerate(sec[:RNG_SECTORS]):
                        if x and (best[i] is None or x[0] > best[i][0]):
                            best[i] = (x[0], x[1], band)
            site, src = self.site, self.site_src
            since = max(recs[0]["t0"], self.since or 0.0)
        step = 360.0 / RNG_SECTORS
        lat0, lon0 = round(site[0], 2), round(site[1], 2)
        sectors, outline = [], []
        for i, x in enumerate(best):
            if x is None:
                sectors.append(None)
                continue
            brg = (i + 0.5) * step
            sectors.append({"brg": brg, "nm": x[0], "alt": x[1], "band": x[2]})
            plat, plon = _dest(lat0, lon0, brg, x[0])
            outline.append([round(plat, 4), round(plon, 4)])
        far = max((x for x in sectors if x), key=lambda x: x["nm"], default=None)
        return {"now": now, "hours": hours, "since": since, "sectors_n": RNG_SECTORS,
                "receivers": [{"lat": lat0, "lon": lon0, "src": src, "sectors": sectors,
                               "outline": outline if len(outline) >= 3 else [],
                               "farthest": far}]}

    def snapshot(self, window_min: int = 10, db=None, week_trend: bool = False) -> dict:
        """The statistics of the last window_min minutes (1–60, 1440 = 24 h, or
        WEEK_MIN = 7 d with db: the stored hours older than the 24 h are read
        from msg_stats_hours, merged once per hour and kept while asked for).
        week_trend (with db): also the 7 d chart series per 10 min."""
        now = time.time()
        week = None
        if db is not None and (int(window_min) >= WEEK_MIN or week_trend):
            try:
                week = self._week(db, now)
            except Exception as exc:                 # noqa: BLE001  (the 24 h still works)
                log.warning("Statistics 7 d: stored hours not read (%s)", exc)
        elif self._week_cache and now - self._week_cache["used"] > WEEK_CACHE_IDLE_SEC:
            self._week_cache = None                  # nobody looks at the 7 d: free the memory
        is_week = int(window_min) >= WEEK_MIN and week is not None
        window_min = WEEK_MIN if is_week else max(1, min(WINDOW_MAX_MIN, int(window_min)))
        hours: list = []
        with self._lock:
            self._roll(now)
            agg = _new_minute(0.0)
            if window_min > 60:
                # 24 h: the closed hours (immutable; merged outside the lock),
                # the current hour so far and the current minute; 7 d: the
                # same plus the older stored hours (week["base"])
                h0 = float(int(now // 3600) * 3600) - (min(window_min, WINDOW_MAX_MIN) // 60 - 1) * 3600
                hours = [h for h in self._hours if h["t0"] >= h0]
                for m in ([self._hour] if self._hour else []) + [self._min]:
                    _merge(agg, m)
                t_first = (hours[0] if hours else self._hour or self._min)["t0"]
            else:
                m0 = self._min["t0"] - (window_min - 1) * 60
                mins = [m for m in self._minutes if m["t0"] >= m0] + [self._min]
                for m in mins:
                    _merge(agg, m)
                t_first = mins[0]["t0"]
            sig_state = self.sig_state
            site = self.site
            downs = list(self._gaps)
            ten = list(self._ten)[-360:]
            trend = list(self._trend)
            iid_seen = {k: list(v) for k, v in self._iid_seen.items()}
            js = dict(self._json, stations={k: dict(v) for k, v in self._json["stations"].items()})
            # EHS aircraft heard in the last 10 s whose last BDS 5,0 is older than 30 s
            recent = {i for i, t in self._seen.items() if now - t <= 10}
            silent = sum(1 for i in recent if i in self._b50 and now - self._b50[i] > EHS_SILENT_SEC
                         and now - self._b50[i] <= 600)
            ehs_now = sum(1 for i in recent if i in self._b50 and now - self._b50[i] <= EHS_SILENT_SEC)
            feed = {"started": self.started, "connects": self.connects,
                    "connected_ts": self.connected_ts, "last_msg_ts": self.last_msg_ts,
                    "total_msgs": self.total_msgs}
        if hours:
            key = (len(hours), hours[0]["t0"], hours[-1]["t0"])
            hc = self._hours_cache
            if hc is None or hc[0] != key:
                base = _new_minute(0.0)
                for m in hours:
                    _merge(base, m)
                hc = self._hours_cache = (key, base)
            _merge(agg, hc[1])
        t_from = max(t_first, self.since)
        down_from = t_from
        week_down = 0.0
        if is_week and week["n"]:
            _merge(agg, week["base"])
            t_from = week["since"]
            down_from = max(t_from, week["cutoff"])    # older down time: the hours without a row
            week_down = week["down"]
        c, hist, ac = agg["c"], agg["h"], agg["ac"]
        down = week_down + sum(max(0.0, min(b, now) - max(a, down_from)) for a, b in downs)
        secs = max(1.0, now - t_from - down)
        rate = lambda n: round(n / secs, 2)
        n_ac = lambda k: len(ac.get(k, ()))
        # downlink formats
        dfs = []
        for df in (0, 4, 5, 11, 16, 17, 18, 19, 20, 21, 24):
            n = c[("df", df)]
            if n or df in (0, 4, 5, 11, 16, 17, 18, 20, 21):
                dfs.append({"df": df, "n": n, "rate": rate(n), "ac": n_ac(("df", df))})
        # ADS-B type codes
        tcs = sorted(((k[1], v) for k, v in c.items() if isinstance(k, tuple) and k[0] == "tc"),
                     key=lambda x: (x[0] is None, x[0] or 0))
        v19 = {str(k[1]): v for k, v in c.items() if isinstance(k, tuple) and k[0] == "v19"}
        ver = {str(k[1]): {"n": v, "ac": n_ac(("ver", k[1]))}
               for k, v in c.items() if isinstance(k, tuple) and k[0] == "ver"}
        # Comm-B
        bds = sorted(((k[1], v) for k, v in c.items() if isinstance(k, tuple) and k[0] == "bds"),
                     key=lambda x: x[0])
        commb = c[("df", 20)] + c[("df", 21)]
        # cadence
        cad = []
        for kind in CAD_KINDS:
            lo = CAD_DUP_ES_SEC if kind.startswith("es_") else CAD_DUP_SEC
            for ph in PHASES:
                h = hist.get((kind, ph))
                n_int = sum(h) if h else 0
                dup = c[("dup_ph", kind, ph)]
                gaps = c[("gap", kind, ph)]
                if not (n_int or dup or gaps):
                    continue
                cad.append({"kind": kind, "phase": ph, "n": n_int, "dup": dup, "gaps": gaps,
                            "median": _hist_quantile(h, 0.5, lo) if h else None,
                            "p90": _hist_quantile(h, 0.9, lo) if h else None,
                            "hist": h or [0] * len(CAD_EDGES)})
        # interrogators
        iids = []
        for k, v in c.items():
            if isinstance(k, tuple) and k[0] == "iid":
                code = (k[1], k[2])
                fl = iid_seen.get(code)
                iids.append({"type": k[1], "code": k[2], "n": v, "rate": rate(v),
                             "ac": n_ac(("iid",) + code) if k[1] != "SQ" else None,
                             "first": fl[0] if fl else None, "last": fl[1] if fl else None})
        iids.sort(key=lambda x: (x["type"] == "SQ", -x["n"]))
        # interrogators heard earlier but not in this window
        in_win = {(x["type"], x["code"]) for x in iids}
        quiet = [{"type": k[0], "code": k[1], "first": v[0], "last": v[1]}
                 for k, v in iid_seen.items() if k not in in_win]
        um = sorted(({"iis": k[1], "ids": k[2], "n": v} for k, v in c.items()
                     if isinstance(k, tuple) and k[0] == "um"), key=lambda x: -x["n"])
        # signal level
        sh = agg["s"]
        sig_cats = {}
        for cat in SIG_CATS:
            h = sh.get(("sig", cat))
            if not h:
                continue
            sig_cats[cat] = {"n": sum(h), "hist": h, "strong": c[("sig_strong", cat)],
                             "median": _sig_quantile(h, 0.5), "p10": _sig_quantile(h, 0.1),
                             "p90": _sig_quantile(h, 0.9)}
        # range
        rows = []
        for j in range(len(RNG_EDGES_NM)):
            n = c[("rbn", j)]
            if not n:
                continue
            h = sh.get(("rb", j))
            rows.append({"lo": RNG_EDGES_NM[j],
                         "hi": RNG_EDGES_NM[j + 1] if j + 1 < len(RNG_EDGES_NM) else None,
                         "pos": n, "ac": n_ac(("rb", j)),
                         "sig_median": _sig_quantile(h, 0.5) if h else None,
                         "sig_p10": _sig_quantile(h, 0.1) if h else None})
        far = None
        for band, sec in agg["r"].items():
            for i, x in enumerate(sec):
                if x and (far is None or x[0] > far["nm"]):
                    far = {"nm": x[0], "alt": x[1], "icao": x[2], "brg": i * 360 // RNG_SECTORS + 5}
        return {
            "now": now, "window_min": window_min, "window_sec": round(secs, 1),
            "since": self.since, "gaps": [g for g in downs if g[1] > now - 86400],
            "feed": feed,
            "totals": {"msgs": c["msgs"], "rate": rate(c["msgs"]), "short": c["short"],
                       "long": c["long"], "dec_err": c["dec_err"], "err": c["err"],
                       "blocked": c["blocked"], "aircraft": n_ac("all"), "adsb": n_ac("df17"),
                       "ehs": n_ac("ehs"), "ehs_now": ehs_now, "ehs_silent": silent},
            "df": dfs,
            "adsb": {"tc": [{"tc": t, "n": v, "rate": rate(v)} for t, v in tcs], "v19": v19,
                     "gmb": c["gmb"], "ver": ver},
            "commb": {"total": commb, "ambig": c["ambig"], "unverified": c["unverified"],
                      "ehs_ac": n_ac("ehs"), "ac": n_ac("commb"),
                      "bds": [{"bds": b, "n": v, "rate": rate(v), "ac": n_ac(("bds", b))}
                              for b, v in bds]},
            "cadence": {"edges": list(CAD_EDGES), "rows": cad},
            "iid": {"rows": iids, "quiet": quiet, "df11_bad": c["df11_bad"], "um": um[:20]},
            "meteo": {k: c[("met", k)] for k in ("wind", "wind_old", "nowind", "temp", "mrar", "mhr")},
            "json": js,
            "signal": {"state": sig_state, "lo_db": SIG_LO_DB, "step_db": SIG_STEP_DB, "bins": SIG_BINS,
                       "strong_db": -3.0, "zero": c["sig0"], "cats": sig_cats,
                       "parser": _sig_parser_state()},
            "range": {"site": list(site), "site_src": self.site_src, "site_alt": self.site_alt,
                      "site_cfg": list(self.site_cfg) if self.site_cfg else None, "site_rc_why": self.site_rc_why,
                      "sectors": RNG_SECTORS, "max": agg["r"], "rows": rows,
                      "n": c["rng_n"], "jumps": c["rng_jump"], "far_rejected": c["rng_far"],
                      "farthest": far, "max_nm": RNG_MAX_NM},
            "ten": ten,
            "trend": {"keys": ["t0"] + list(TREND_KEYS), "rows": trend},
            **({"trend_week": {"keys": ["t0"] + list(TREND_KEYS), "step": WEEK_STEP_SEC,
                               "rows": self._week_rows(week, trend, now)}}
               if week_trend and week is not None else {}),
        }

    # ── 7 d (from 2026-10-26) ────────────────────────────────────────────────
    def _week(self, db, now: float) -> dict:
        """The stored hours of the 7 d window that lie before the 24 h kept in
        RAM ([now − 168 h, now − 23 h) by clock hour), merged into one record,
        with their per-minute series binned per 10 min.  Read again when the
        hour changes or a row is added (about 1 s on a Pi for 144 rows, once an
        hour, only while the 7 d is asked for); nothing is written."""
        cur_h = float(int(now // 3600) * 3600)
        cutoff = cur_h - (HOURS_DETAIL - 1) * 3600
        w0 = cur_h - (WEEK_MIN // 60 - 1) * 3600
        with self._week_lock:
            ensure_tables(db)
            n, last = db.execute("SELECT COUNT(*), MAX(ts) FROM msg_stats_hours WHERE ts >= ? AND ts < ?",
                                 (int(w0), int(cutoff))).fetchone()
            key = (cutoff, n, last)
            wc = self._week_cache
            if wc is None or wc["key"] != key:
                base, bins, have, since = _new_minute(0.0), {}, set(), None
                for ts, blob in db.execute("SELECT ts, data FROM msg_stats_hours WHERE ts >= ? AND ts < ? "
                                           "ORDER BY ts", (int(w0), int(cutoff))):
                    try:
                        d = _unpack(blob)
                        _merge(base, _rec_dec(d["rec"]))
                    except Exception as exc:     # noqa: BLE001
                        log.warning("Statistics history: hour %s unreadable (%s)", ts, exc.__class__.__name__)
                        continue
                    have.add(int(ts))
                    if since is None:
                        since = max(float(ts), float(d.get("since") or ts))
                    _bin_rows(bins, d.get("trend") or [])
                down = 0.0
                if since is not None:            # hours without a row: the server was down (or crashed)
                    h = float(int(since // 3600) * 3600)
                    while h < cutoff:
                        if int(h) not in have:
                            down += 3600.0
                        h += 3600
                wc = self._week_cache = {"key": key, "cutoff": cutoff, "n": len(have), "base": base,
                                         "since": since, "down": down, "bins": bins, "w0": w0}
            wc["used"] = now
            return wc

    def _week_rows(self, week: dict, trend: list, now: float) -> list:
        """The 7 d chart rows: per 10 min the mean of the minutes (the same
        units as the 24 h series); the stored part plus the RAM minutes from the
        cutoff on; empty 10-min slots as gaps (None)."""
        bins = {k: [list(v[0]), v[1]] for k, v in week["bins"].items()}
        _bin_rows(bins, [r for r in trend if r and r[0] >= week["cutoff"]])
        start = week["w0"] if not bins else min(min(bins), week["w0"])
        out, t = [], start
        end = float(int(now // WEEK_STEP_SEC) * WEEK_STEP_SEC)
        nk = len(TREND_KEYS)
        while t <= end:
            b = bins.get(t)
            if b is None:
                out.append([t] + [None] * nk)
            else:
                sums, cnts = b
                out.append([t] + [round(sums[i] / cnts[i], 2) if cnts[i] else None for i in range(nk)])
            t += WEEK_STEP_SEC
        while out and all(v is None for v in out[0][1:]):   # no leading gap before the first data
            out.pop(0)
        return out


def _bin_rows(bins: dict, rows: list) -> None:
    """Add per-minute series rows [t0, v…] into 10-min bins {t: [sums, counts]}
    (None values — gaps — are skipped)."""
    nk = len(TREND_KEYS)
    for r in rows:
        if not r or r[0] is None:
            continue
        t = float(int(r[0] // WEEK_STEP_SEC) * WEEK_STEP_SEC)
        b = bins.get(t)
        if b is None:
            b = bins[t] = [[0.0] * nk, [0] * nk]
        for i in range(nk):
            v = r[i + 1] if i + 1 < len(r) else None
            if v is not None:
                b[0][i] += v
                b[1][i] += 1


# ── persistence ────────────────────────────────────────────────────────────

def _persist(self, db) -> int:
    """Write the closed hours not yet stored (housekeeping thread, every
    minute; one INSERT per hour) and delete rows older than keep_days."""
    with self._lock:
        pend, self._pending = self._pending, []
        rows = [(h, [r for r in self._trend if h["t0"] <= r[0] < h["t0"] + 3600]) for h in pend]
        since = self.since
    if not rows:
        return 0
    try:
        ensure_tables(db)
        for h, tr in rows:
            db.execute("INSERT OR REPLACE INTO msg_stats_hours (ts, data) VALUES (?, ?)",
                       (int(h["t0"]), _pack({"v": 1, "rec": _rec_enc(h), "trend": tr,
                                             "since": max(since, h["t0"])})))
        db.execute("DELETE FROM msg_stats_hours WHERE ts < ?", (int(time.time() - self.keep_days * 86400),))
        db.commit()
    except Exception:
        with self._lock:                         # try again at the next round
            self._pending[:0] = pend[-48:]
        raise
    return len(rows)


def _save_state(self, db) -> int:
    """At a clean stop: the hour in progress, the minute records, the 24 h
    series, the 10-s series and the other small state (one row)."""
    from collector import health as _hb
    try:
        self.persist(db)
    except Exception as exc:                     # noqa: BLE001
        log.warning("Statistics history: hourly rows not written at the stop (%s)", exc)
    now = time.time()
    with self._lock:
        self._roll(now)
        st = {"v": 1, "saved": now, "since": self.since, "gaps": self._gaps[-20:],
              "minutes": [_rec_enc(m) for m in self._minutes] + [_rec_enc(self._min)],
              "hour": _rec_enc(self._hour) if self._hour else None,
              "trend": list(self._trend) + [self._compact(self._min)],
              "ten": [list(t) for t in self._ten] + [list(self._ten_cur)],
              "iid_seen": [[list(k), v] for k, v in self._iid_seen.items()],
              "health": _hb.export_changes()}
    blob = _pack(st)
    ensure_tables(db)
    db.execute("INSERT OR REPLACE INTO msg_stats_state (k, saved, data) VALUES ('state', ?, ?)", (now, blob))
    db.commit()
    return len(blob)


def _restore(self, db) -> str:
    """At the start, before the collector runs: the last 24 h of hourly rows
    and the state saved at the last clean stop (if under 24 h old)."""
    from collector import health as _hb
    now = time.time()
    ensure_tables(db)
    cur_h = float(int(now // 3600) * 3600)
    h_from = cur_h - (HOURS_DETAIL - 1) * 3600
    hours, trends, first = {}, {}, {}
    for ts, blob in db.execute("SELECT ts, data FROM msg_stats_hours WHERE ts >= ? ORDER BY ts",
                               (int(h_from),)).fetchall():
        try:
            d = _unpack(blob)
            hours[float(ts)] = _rec_dec(d["rec"])
            trends[float(ts)] = d.get("trend") or []
            first[float(ts)] = float(d.get("since") or ts)
        except Exception as exc:                 # noqa: BLE001
            log.warning("Statistics history: hour %s unreadable (%s)", ts, exc.__class__.__name__)
    st = None
    row = db.execute("SELECT saved, data FROM msg_stats_state WHERE k = 'state'").fetchone()
    if row and now - float(row[0]) < 86400:
        try:
            st = _unpack(row[1])
        except Exception as exc:                 # noqa: BLE001
            log.warning("Statistics state unreadable (%s)", exc.__class__.__name__)
    if row:                                      # used once
        db.execute("DELETE FROM msg_stats_state")
        db.commit()
    gap_marker = lambda t: [t] + [None] * len(TREND_KEYS)      # noqa: E731
    with self._lock:
        closed = []
        if st:
            mins = [_rec_dec(x) for x in st.get("minutes") or []]
            hour = _rec_dec(st["hour"]) if st.get("hour") else None
            if mins:                             # the minute in progress at the stop: closed now
                m = mins[-1]
                th = float(int(m["t0"] // 3600) * 3600)
                if hour is not None and hour["t0"] != th:
                    closed.append(hour)
                    hour = None
                if hour is None:
                    hour = _new_minute(th)
                _merge(hour, m)
            if hour is not None:
                if hour["t0"] == cur_h:
                    self._hour = hour
                else:
                    closed.append(hour)
            self._minutes = deque((m for m in mins if m["t0"] >= now - 3600), maxlen=MINUTES_DETAIL)
            trend = [r for r in st.get("trend") or [] if r and r[0] >= now - 86400]
            stop = float(st.get("saved") or now)
            self._gaps = [tuple(g) for g in st.get("gaps") or [] if g[1] > now - 86400 * 2] + [(stop, now)]
            ten = [tuple(t) for t in st.get("ten") or [] if t[0] >= now - 3600]
            if ten:                              # the down time as empty 10-s slots (a break in the chart)
                t = max(ten[-1][0] + 10, self._ten_of(now) - 3600)
                while t < self._ten_of(now):
                    ten.append((t, None))
                    t += 10
            self._ten = deque(ten, maxlen=360)
            for k, v in st.get("iid_seen") or []:
                self._iid_seen[tuple(k)] = list(v)
            _hb.import_changes(st.get("health") or [], stop, now)
        else:
            trend = []
            for ts in sorted(trends):
                trend.extend(trends[ts])
            trend = [r for r in trend if r and r[0] >= now - 86400]
            if hours:
                stop = max(hours) + 3600
                self._gaps = [(stop, now)]
                _hb.import_changes([], None, now)
        for h in closed:
            hours[h["t0"]] = h
        self._hours = deque((hours[t] for t in sorted(hours) if t >= h_from and t < cur_h),
                            maxlen=HOURS_DETAIL)
        self._pending = [h for h in closed if h["t0"] >= now - self.keep_days * 86400]
        if trend:
            if self._gaps:                       # the down time as empty minutes (a break in the chart)
                t = max(trend[-1][0] + 60, self._minute_of(now) - 86400)
                while t < self._minute_of(now):
                    trend.append(gap_marker(t))
                    t += 60
            self._trend = deque(trend, maxlen=MINUTES_TREND)
        t0s = [h["t0"] for h in self._hours] + [m["t0"] for m in self._minutes] + \
              ([self._hour["t0"]] if self._hour else [])
        if t0s:
            self.since = min(t0s)
            if st and st.get("since"):
                self.since = max(self.since, float(st["since"]))
            elif self._hours and self._hours[0]["t0"] in first:
                self.since = max(self.since, first[self._hours[0]["t0"]])
        n_h = len(self._hours)
    return (f"{n_h} hour(s) of the last 24 h" + (", and the state of the last stop "
            f"({time.strftime('%H:%M', time.gmtime(stop))} UTC, down {_dur(now - stop)})" if st else
            ", no saved state (the hour in progress at the stop is lost)" if hours else ""))


def _dur(s: float) -> str:
    return f"{s:.0f} s" if s < 90 else f"{s / 60:.0f} min" if s < 5400 else f"{s / 3600:.1f} h"


MsgStats.persist = _persist
MsgStats.save_state = _save_state
MsgStats.restore = _restore


def _sig_parser_state() -> dict:
    try:
        from collector import beast_sig
        return beast_sig.state()
    except Exception:                       # noqa: BLE001
        return {}


_STATS = MsgStats()


def get() -> MsgStats:
    return _STATS
