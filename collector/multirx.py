"""
multirx.py — more receivers (from 2026-11-02).

Phase 1 (EXTRA_RECEIVERS set, RECEIVERS_MERGE off): the other receivers are
*watched*.  The main receiver (RADARCAPE_HOST / RADARCAPE_PORT, RECEIVER_ID —
by default MODES-RX-01, the Radarcape) is read by pyModeS as before and stays
the only source of the weather.

Phase 2 (RECEIVERS_MERGE = True, from 2026-11-02 afternoon): the replies of
all receivers are *merged* into the weather.  The main receiver gets an own
reader here too (pyModeS's NetworkSource is then not used), every reader
stamps its frames with the reply's time on one time scale, and the merger
(below) removes the duplicates — a reply heard by two receivers is decoded
once — and hands the replies to the collector (collector/receiver.py) in time
order, with a bit mask of the receivers that heard each one (bit 0 = the main
receiver, bit 1 = the first of EXTRA_RECEIVERS, …).  The mask is kept with the
BDS 5,0 / 6,0 replies of the approach and climb-out series ("rx").

Every receiver has:

  • its own Beast reader (TCP client, reconnects every 10 s): the frames with
    their 48-bit time stamp and signal byte; Mode A/C frames (readsb's
    heartbeat: type 0x31 with zero time and payload) and status frames are
    skipped; the bytes go to the data transfer counters (beast / beast2);
  • its clock.  A Radarcape in GPS mode stamps the reply with GPS time (upper
    18 bits: second of the UTC day, lower 30 bits: nanoseconds — 2^30 counts a
    second; confirmed in the recording of 2 Nov 2026).  airspy_adsb / readsb
    stamp it with a free-running counter (12 / 20 / 24 MHz = the sample rate;
    restarts with the program).  The counter is lined up with the main
    receiver's GPS time from the ADS-B messages both receivers heard (DF17:
    the same 112 bits within a second are the same transmission): the median
    of the last 101 time differences.  Measured on 2 Nov 2026 (10 min): AirSpy
    R2 12 MHz, −0.2 ppm, spread of the differences 32 µs (= the different
    distance from the aircraft to the two sites).  Without the main receiver's
    GPS time the counter is lined up with the server clock instead (the
    smallest arrival delay of the last minute; good to some tens of ms), and
    a Radarcape without GPS lock uses its arrival time;
  • its statistics: a MsgStats of its own (collector/msg_stats.py; stored
    hours in msg_stats_rx_hours), decoded by its own PipeDecoder for the
    statistics only;
  • (the other receivers) the comparison with the main receiver: each frame
    is held HOLD_SEC and then looked up among the main receiver's frames — the
    same bytes within DUP_SEC (5 ms) of the lined-up time = heard by both;
  • (optional status_url) readsb's status once a minute: receiver.json gives
    the antenna position (readsb-set-location at the site — a mobile station
    needs no change here), stats.json the message counts.

The merger: every frame goes in at arrival with its time t; the same bytes
within 5 ms (both times precise: GPS / lined up) or 0.25 s (one of them on a
fallback clock — joining two identical replies is harmless, counting one
twice is not) from two DIFFERENT receivers are one reply (one receiver hears
the same bits twice often enough: separate replies to two interrogators,
kept apart as before).  A reply leaves MERGE_HOLD_SEC after its time t
(arrival delays measured on 2 Nov: up to 0.43 s through the tunnels), in time
order; a copy arriving after its reply left is dropped (counted), a reply
arriving later than the hold is passed on at once with its time set to the
last one passed (counted).  A frame arriving more than MERGE_STALE_SEC
(2.5 s) after its time — a burst after a stall of its tunnel, e.g. a mobile
station on 4G — is dropped (counted "stale"): its copy from the other
receiver may already be forgotten, and it would be taken twice.  The weather
then has a delay of under a second.
"""

from __future__ import annotations

import heapq
import json
import logging
import socket
import statistics
import threading
import time
import urllib.request
from collections import Counter, deque

from collector import msg_stats, traffic

log = logging.getLogger("modes.multirx")

HOLD_SEC = 0.6            # a frame of another receiver waits this long for the main receiver's copy
DUP_SEC = 0.005           # same bytes within this (lined-up time): heard by both
DUP_SEC_LOOSE = 0.25      # … when one of the two times is on a fallback clock (merger)
MERGE_HOLD_SEC = 0.8      # the merger passes a reply on this long after its time
MERGE_STALE_SEC = 2.5     # a frame older than this on arrival is dropped (counted "stale")
MERGE_DONE_SEC = 3.0      # passed-on replies remembered this long for late copies (> MERGE_STALE_SEC)
PAIR_SEC_SYNCED = 0.05    # DF17 pair window once lined up
PAIR_SEC_START = 2.0      # … before that (the counter plus the arrival delay)
PAIR_N = 101              # time differences in the running median
SYNC_MIN_PAIRS = 15
SYNC_MAX_AGE = 120.0      # s without a new pair: back to the own clock
RX1_KEEP_SEC = 5.0        # the main receiver's frames kept for the look-up
RX1_ALIVE_SEC = 10.0      # main receiver frames this recent: compare
LOW_FT = 1500             # "low" replies (altitude, ft): BDS 5,0 heard only here
STATUS_SEC = 60.0
NOGPS_DELAY = 0.1         # a Radarcape without GPS time: its arrival time minus this
CLOCK_HZ = {"12mhz": 12e6, "20mhz": 20e6, "24mhz": 24e6}
_BODY = {0x31: 9, 0x32: 14, 0x33: 21}

_RX: dict = {}            # id → Rx of the other receivers
_main = {"id": "MODES-RX-01", "name": "Tuusula", "type": "radarcape", "rx": None}
_state = {"merge": False}


def _gps_time(ticks: int, wall: float):
    """A Radarcape GPS stamp as Unix time, None when it is not GPS time."""
    ns = ticks & 0x3FFFFFFF
    if ns >= 1_000_000_000:
        return None
    day0 = wall - (wall % 86400)
    t = day0 + (ticks >> 30) + ns * 1e-9
    if t - wall > 43200:
        t -= 86400
    elif wall - t > 43200:
        t += 86400
    if abs(t - wall) > 30:                         # 12 MHz mode, or no GPS time
        return None
    return t


# ── the main receiver's frames (for the comparison and the clock line-up) ────
class _Rx1:
    def __init__(self) -> None:
        self.q: deque = deque(maxlen=50000)        # (t, hex) not yet indexed
        self.lock = threading.Lock()
        self.idx: dict = {}                        # hex → [t, …]
        self.order: deque = deque()                # (t, hex) in arrival order
        self.last_wall = None                      # last frame with GPS time
        self.gps_ok = 0
        self.gps_bad = 0
        self.delays: deque = deque(maxlen=6000)    # arrival − GPS time (s), every 8th frame
        self._n = 0

    def add(self, t: float, hx: str, wall: float) -> None:
        self.gps_ok += 1
        self.q.append((t, hx))
        self._n += 1
        if self._n % 8 == 0:
            self.delays.append(wall - t)
        self.last_wall = wall

    def tap(self, frames, wall: float) -> None:
        """Phase 1: pyModeS's frames of one receive burst [(48-bit stamp, hex), …]
        (collector/beast_sig.py set_tap)."""
        for ticks, hx in frames:
            t = _gps_time(ticks, wall)
            if t is None:
                self.gps_bad += 1
                continue
            self.add(t, hx, wall)

    def drain(self) -> None:
        """Index the queued frames; forget those older than RX1_KEEP_SEC."""
        with self.lock:
            q, idx, order = self.q, self.idx, self.order
            while q:
                t, hx = q.popleft()
                lst = idx.get(hx)
                if lst is None:
                    idx[hx] = [t]
                else:
                    lst.append(t)
                order.append((t, hx))
            if order:
                cut = order[-1][0] - RX1_KEEP_SEC
                while order and order[0][0] < cut:
                    t, hx = order.popleft()
                    lst = idx.get(hx)
                    if lst:
                        if lst[0] == t:
                            lst.pop(0)
                        else:
                            try:
                                lst.remove(t)
                            except ValueError:
                                pass
                        if not lst:
                            del idx[hx]

    def lookup(self, hx: str):
        with self.lock:
            lst = self.idx.get(hx)
            return list(lst) if lst else None

    def alive(self, now: float) -> bool:
        return self.last_wall is not None and now - self.last_wall < RX1_ALIVE_SEC


_RX1 = _Rx1()


# ── the merger (phase 2) ────────────────────────────────────────────────────
class Merger:
    def __init__(self, n_rx: int) -> None:
        self.n = n_rx
        self.cv = threading.Condition()
        self.heap: list = []                       # (t, seq, entry)
        self.pend: dict = {}                       # hex → [entry, …] waiting
        self.done: dict = {}                       # hex → [(t, mask), …] passed on (last MERGE_DONE_SEC)
        self.done_order: deque = deque()
        self.seq = 0
        self.last_t = 0.0
        self.cur_sig = None
        self.cur_mask = None
        self._cmp_lock = threading.Lock()
        self.cmp: deque = deque(maxlen=1440)       # (minute, Counter) for 24 h
        self._cur = None

    def _count(self, key, n: int = 1) -> None:
        t0 = float(int(time.time() // 60) * 60)
        with self._cmp_lock:
            if self._cur is None or self._cur[0] != t0:
                self._cur = (t0, Counter())
                self.cmp.append(self._cur)
            self._cur[1][key] += n

    def push(self, bit: int, t: float, sig, hx: str, precise: bool) -> None:
        """A frame of receiver `bit` (reader threads)."""
        b = 1 << bit
        with self.cv:
            # a frame delivered in a burst after a stall of its tunnel (a 4G
            # link, a congested cell): its copy from the other receiver may
            # already have been passed on and forgotten (MERGE_DONE_SEC), so it
            # would go out a second time with a wrong time — drop it instead
            if t < time.time() - MERGE_STALE_SEC:
                self._count("stale")
                return
            # only a copy from ANOTHER receiver is a duplicate: one receiver
            # often hears the same bits twice within a fraction of a second
            # (separate replies to two interrogators: a third of the frames
            # within 0.25 s, 2.5 % within 5 ms in the recording of 2 Nov) —
            # those stay separate replies, as without merging
            lst = self.pend.get(hx)
            if lst:
                best, bd = None, None
                for e in lst:
                    if e[2] & b:
                        continue
                    d = abs(e[0] - t)
                    if d < (DUP_SEC if (precise and e[4]) else DUP_SEC_LOOSE) and (bd is None or d < bd):
                        best, bd = e, d
                if best is not None:
                    best[2] |= b
                    if best[3] is None:
                        best[3] = sig
                    self._count("dup")
                    return
            done = self.done.get(hx)
            if done and any(not (m & b) and abs(d - t) < (DUP_SEC if precise else DUP_SEC_LOOSE)
                            for d, m in done):
                self._count("late_dup")
                return
            # entry: [t, hex, mask, sig, precise]
            e = [t, hx, 1 << bit, sig, precise]
            self.seq += 1
            heapq.heappush(self.heap, (t, self.seq, e))
            self.pend.setdefault(hx, []).append(e)
            self.cv.notify()

    def frames(self):
        """The merged replies in time order: yields (hex, t); the signal byte of
        the first copy and the mask of the receivers are in cur_sig / cur_mask
        (collector thread)."""
        while True:
            out = []
            with self.cv:
                now = time.time()
                lim = now - MERGE_HOLD_SEC
                while self.heap and self.heap[0][0] <= lim:
                    t, _, e = heapq.heappop(self.heap)
                    lst = self.pend.get(e[1])
                    if lst:
                        try:
                            lst.remove(e)
                        except ValueError:
                            pass
                        if not lst:
                            del self.pend[e[1]]
                    if t < self.last_t:                # later than the hold: at once, in order
                        t = e[0] = self.last_t
                        self._count("late")
                    self.last_t = t
                    dn = (t, e[2])
                    self.done.setdefault(e[1], []).append(dn)
                    self.done_order.append((dn, e[1]))
                    out.append(e)
                cut = now - MERGE_DONE_SEC
                while self.done_order and self.done_order[0][0][0] < cut:
                    td, hd = self.done_order.popleft()
                    lst = self.done.get(hd)
                    if lst:
                        try:
                            lst.remove(td)
                        except ValueError:
                            pass
                        if not lst:
                            del self.done[hd]
                if not out:
                    wait = (self.heap[0][0] - lim) if self.heap else 0.2
                    self.cv.wait(timeout=max(0.01, min(0.2, wait)))
                    continue
            for e in out:
                self._count(("mask", e[2]))
                self._count("out")
                self.cur_sig, self.cur_mask = e[3], e[2]
                yield e[1], e[0]

    def public(self, window_min: int) -> dict:
        now = time.time()
        w = max(1, min(1440, int(window_min)))
        tot = Counter()
        with self._cmp_lock:
            for t0, c in self.cmp:
                if t0 + 60 > now - w * 60:
                    tot.update(c)
        masks = {str(k[1]): v for k, v in tot.items() if isinstance(k, tuple) and k[0] == "mask"}
        return {"window_min": w, "out": tot["out"], "dup": tot["dup"], "late_dup": tot["late_dup"],
                "late": tot["late"], "stale": tot["stale"], "masks": masks, "hold_sec": MERGE_HOLD_SEC,
                "stale_sec": MERGE_STALE_SEC}


_MERGER: Merger | None = None


def _pct(vals, q):
    if not vals:
        return None
    v = sorted(vals)
    return v[min(len(v) - 1, int(q * len(v)))]


def _delay_stats(vals) -> dict | None:
    # list(deque) copies it at once; iterating the deque itself while the
    # reader thread appends raised "deque mutated during iteration" (2 Nov)
    v = [x for x in list(vals) if x is not None]
    if len(v) < 20:
        return None
    return {"min": round(min(v) * 1000, 1), "p50": round(_pct(v, 0.5) * 1000, 1),
            "p99": round(_pct(v, 0.99) * 1000, 1), "max": round(max(v) * 1000, 1), "n": len(v)}


# ── one receiver ────────────────────────────────────────────────────────────
class Rx:
    def __init__(self, spec: dict, cfg, bit: int, main: bool = False) -> None:
        self.main = main
        self.bit = bit
        self.id = str(spec["id"])
        self.name = str(spec.get("name") or self.id)
        self.type = str(spec.get("type") or "readsb").lower()
        self.host = str(spec.get("host") or "127.0.0.1")
        self.port = int(spec["port"])
        clock = str(spec.get("clock") or ("gps" if self.type == "radarcape" else "12mhz")).lower()
        self.clock = clock if clock in CLOCK_HZ or clock == "gps" else "12mhz"
        self.hz = CLOCK_HZ.get(self.clock)
        self.status_url = spec.get("status_url") or None
        # its own aircraft list for the local JSON feed (collector/json_feed.py, from 2026-11-03):
        # readsb's aircraft.json under status_url, or json_url (e.g. a Radarcape's aircraftlist.json)
        self.json_url = spec.get("json_url") or None
        if self.status_url and not self.status_url.endswith("/"):
            self.status_url += "/"
        self.private = bool(spec.get("private", not main))
        self.cfg_pos = ((float(spec["lat"]), float(spec["lon"]))
                        if spec.get("lat") is not None and spec.get("lon") is not None else None)
        self.blocked = tuple(getattr(cfg, "BLOCKED_ICAO_PREFIXES", ()) or ())
        self.surface_ref = (float(cfg.RECEIVER_LAT), float(cfg.RECEIVER_LON))
        self.traffic_kind = "beast" if main else "beast2"
        # statistics (msg_stats panels)
        ms = self.ms = msg_stats.add_receiver(self.id)
        ms.keep_days = float(getattr(cfg, "MSG_STATS_DAYS", 7))
        ms.airport = (cfg.WINDSHEAR_AIRPORT_LAT, cfg.WINDSHEAR_AIRPORT_LON)
        ms.site_centre = (float(cfg.RECEIVER_LAT), float(cfg.RECEIVER_LON))
        ms.site_round = 2 if self.private else None
        ms.sig_state = "on"
        ms.sig_parser = lambda: {"installed": True, "reason": "", "own_reader": True}
        if main:                                   # the Radarcape's position comes from radarcape_status
            if getattr(cfg, "ANTENNA_LAT", None) is not None and getattr(cfg, "ANTENNA_LON", None) is not None:
                ms.site_cfg = (float(cfg.ANTENNA_LAT), float(cfg.ANTENNA_LON))
            ms.choose_site(None)
        else:
            self._set_site(None)
        # connection
        self.connects = 0
        self.connected_ts = None
        self.last_frame = None
        self.err = None
        self.down_since = time.time()              # not connected since (None while connected)
        self.bytes = 0
        self.frames = 0
        self.skipped = Counter()                   # heartbeat / Mode A/C / status / other
        # clock
        self._clk_lock = threading.Lock()
        self.last_ctr = None
        self.resets = 0
        self.nogps = 0                             # GPS-clock frames without a GPS time
        self.pairs: deque = deque(maxlen=PAIR_N)   # (arrival, t1 − counter time)
        self.sync_off = None
        self.sync_ts = None
        self.env: deque = deque(maxlen=60)         # [second, min(arrival − counter time)]
        self.drift: deque = deque(maxlen=60)       # (counter time, offset) every 10 s → ppm
        self.delays: deque = deque(maxlen=6000)
        self._n = 0
        self.clock_state = "starting"
        # comparison per minute: (t0, Counter) for 24 h
        self._cmp_lock = threading.Lock()
        self.cmp: deque = deque(maxlen=1440)
        self._cmp_cur = None
        # own small aircraft state for the statistics (altitude, position)
        self._ac: dict = {}
        self._ac_prune = time.time()
        self.pending: deque = deque()
        # readsb status
        self.status = None
        self.status_ok = None
        self.status_err = None
        self.pipe = None

    # ── position ─────────────────────────────────────────────────────────
    def _set_site(self, readsb_pos) -> None:
        ms = self.ms
        if readsb_pos:
            ms.site, ms.site_src = readsb_pos, "readsb"
        elif self.cfg_pos:
            ms.site, ms.site_src = self.cfg_pos, "config"
        else:
            ms.site, ms.site_src = ms.site_centre, "centre"
        ms.site_cfg = self.cfg_pos

    # ── the reader thread ────────────────────────────────────────────────
    def run(self) -> None:
        from pyModeS import PipeDecoder
        while True:
            self.pipe = PipeDecoder(surface_ref=self.surface_ref)
            self.pending.clear()
            try:
                sock = socket.create_connection((self.host, self.port), timeout=10)
            except OSError as exc:
                self.err = f"no connection ({exc.__class__.__name__})"
                time.sleep(10)
                continue
            self.connects += 1
            self.connected_ts = time.time()
            self.down_since = None
            self.err = None
            self.ms.connected()
            log.info("%s: connected to %s:%d", self.id, self.host, self.port)
            try:
                self._read(sock)
            except Exception as exc:                # noqa: BLE001
                self.err = f"connection lost ({exc.__class__.__name__})"
                log.info("%s: %s — reconnecting in 10 s", self.id, self.err)
            finally:
                try:
                    sock.close()
                except OSError:
                    pass
                self.down_since = time.time()
            time.sleep(10)

    def _read(self, sock) -> None:
        sock.settimeout(0.25)
        buf = b""
        idle_since = time.time()
        while True:
            try:
                chunk = sock.recv(65536)
                if not chunk:
                    raise ConnectionError("closed by the other end")
                idle_since = time.time()
            except socket.timeout:
                chunk = b""
                if time.time() - idle_since > 120:
                    raise ConnectionError("no data for 2 min")
            now = time.time()
            if chunk:
                self.bytes += len(chunk)
                traffic.add(self.traffic_kind, len(chunk))
                buf += chunk
                buf = self._parse(buf, now)
            self._process(now)

    def _parse(self, buf: bytes, wall: float) -> bytes:
        """Beast frames of buf: stamped, to the merger (phase 2) and the main
        receiver's index, and held for the statistics; the incomplete rest is
        returned."""
        i, L, last = 0, len(buf), 0
        pend = self.pending
        while i < L:
            if buf[i] != 0x1A:
                i += 1
                last = i
                continue
            if i + 1 >= L:
                break
            ty = buf[i + 1]
            n = _BODY.get(ty)
            if n is None:
                if ty == 0x34:                     # status frame: to the next unescaped marker
                    j = i + 2
                    while j < L:
                        if buf[j] == 0x1A:
                            if j + 1 < L and buf[j + 1] == 0x1A:
                                j += 2
                                continue
                            break
                        j += 1
                    if j >= L:
                        break
                    self.skipped["status"] += 1
                    i = last = j
                    continue
                self.skipped["other"] += 1
                i += 1 if ty == 0x1A else 2
                last = i
                continue
            body = bytearray()
            j, bad = i + 2, False
            while j < L and len(body) < n:
                c = buf[j]
                if c == 0x1A:
                    if j + 1 >= L:
                        break
                    if buf[j + 1] == 0x1A:
                        body.append(0x1A)
                        j += 2
                        continue
                    bad = True
                    break
                body.append(c)
                j += 1
            if bad:
                self.skipped["broken"] += 1
                i = last = j
                continue
            if len(body) < n:
                break                              # incomplete: wait for more
            i = last = j
            if ty == 0x31:
                self.skipped["heartbeat" if not any(body) else "mode_ac"] += 1
                continue
            ctr = int.from_bytes(body[:6], "big")
            sig = body[6]
            hx = bytes(body[7:]).hex().upper()
            t, kind, precise = self._stamp(wall, ctr)
            if self.main and kind == "gps":
                _RX1.add(t, hx, wall)
            if _MERGER is not None:
                _MERGER.push(self.bit, t, sig, hx, precise)
            pend.append((wall, ctr, t, kind, sig, hx))
        rest = buf[last:]
        return rest if len(rest) < 1 << 16 else b""

    # ── the clock ────────────────────────────────────────────────────────
    def _stamp(self, wall: float, ctr: int):
        """(time of the reply, clock kind, precise) of one frame: kind 'gps'
        (a Radarcape's GPS time), 'sync' (lined up with the main receiver's GPS
        time), 'own' (lined up with this server's clock), 'nogps' (a Radarcape
        without GPS time: arrival − NOGPS_DELAY) or 'start' (arrival time)."""
        if self.hz is None:                        # a Radarcape: GPS time
            t = _gps_time(ctr, wall)
            if t is not None:
                self.clock_state = "gps"
                return t, "gps", True
            self.nogps += 1
            self.clock_state = "nogps"
            return wall - NOGPS_DELAY, "nogps", False
        ct = ctr / self.hz
        if self.last_ctr is not None:              # counter restart / jump (the program restarted)
            d = (ctr - self.last_ctr) / self.hz
            if d < -1.0 or d > 3600.0:
                self._reset_clock()
        self.last_ctr = ctr
        sec = int(wall)                            # smallest arrival − counter time per second
        e = wall - ct
        env = self.env
        if env and env[-1][0] == sec:
            if e < env[-1][1]:
                env[-1][1] = e
        else:
            env.append([sec, e])
        off, kind = self._offset(wall)
        self.clock_state = kind or "starting"
        if off is None:
            return wall, "start", False
        return ct + off, kind, kind == "sync"

    def _offset(self, now: float):
        """(offset, 'sync' / 'own') to add to the counter time; None at the start."""
        if self.sync_off is not None and self.sync_ts is not None and now - self.sync_ts < SYNC_MAX_AGE \
                and len(self.pairs) >= SYNC_MIN_PAIRS:
            return self.sync_off, "sync"
        env = list(self.env)                       # a copy (the web thread reads this too)
        if env:
            return min(e[1] for e in env), "own"
        return None, None

    def _reset_clock(self) -> None:
        self.resets += 1
        with self._clk_lock:
            self.pairs.clear()
            self.sync_off = self.sync_ts = None
            self.drift.clear()
        self.env.clear()

    # ── comparison and statistics of the held frames ─────────────────────
    def _process(self, now: float) -> None:
        pend = self.pending
        hold = 0.0 if self.main else HOLD_SEC
        if not pend or pend[0][0] > now - hold:
            return
        if not self.main:
            _RX1.drain()
        rx1_alive = _RX1.alive(now)
        while pend and pend[0][0] <= now - hold:
            item = pend.popleft()
            try:
                self._one(*item, rx1_alive)
            except Exception as exc:               # noqa: BLE001
                log.debug("%s: frame not handled: %s", self.id, exc)
        if now - self._ac_prune > 60:
            self._ac_prune = now
            cut = now - 600
            for k in [k for k, v in self._ac.items() if v[0] < cut]:
                del self._ac[k]

    def _one(self, wall: float, ctr: int, t: float, kind: str, sig: int, hx: str, rx1_alive: bool) -> None:
        self.frames += 1
        self.last_frame = wall
        try:
            df = int(hx[:2], 16) >> 3
        except ValueError:
            df = None
        both = None
        if not self.main and rx1_alive:
            cands = _RX1.lookup(hx)
            precise = kind in ("sync", "gps")
            if precise:
                both = bool(cands) and any(abs(c - t) < DUP_SEC for c in cands)
            elif cands:
                both = any(abs(c - t) < 1.0 for c in cands)
            else:
                both = False
            if df == 17 and cands and self.hz is not None:
                ct = ctr / self.hz
                win = PAIR_SEC_SYNCED if kind == "sync" else PAIR_SEC_START
                near = [c for c in cands if abs(c - t) < win] if kind in ("sync", "own") else cands
                if len(near) == 1:
                    with self._clk_lock:
                        self.pairs.append((wall, near[0] - ct))
                        self.sync_off = statistics.median(p[1] for p in self.pairs)
                        self.sync_ts = wall
                        if not self.drift or ct - self.drift[-1][0] >= 10:
                            self.drift.append((ct, self.sync_off))
        if kind in ("sync", "gps"):
            self._n += 1
            if self._n % 4 == 0:
                self.delays.append(wall - t)
        # decoding for the statistics
        ms = self.ms
        ms.raw(t, hx, sig)
        try:
            res = self.pipe.decode(hx, timestamp=t)
        except Exception:                          # noqa: BLE001
            ms.count("dec_err")
            self._cmp(wall, both, df, None, None)
            return
        if not res or res.get("error"):
            ms.count("err")
            self._cmp(wall, both, df, None, None)
            return
        icao = res.get("icao") or ""
        if not icao:
            ms.count("err")
            self._cmp(wall, both, df, None, None)
            return
        if self.blocked and any(icao.startswith(p) for p in self.blocked):
            ms.count("blocked")
            return
        st = self._ac.get(icao)
        alt = res.get("altitude")
        lat, lon = res.get("latitude"), res.get("longitude")
        if st is None:
            st = self._ac[icao] = [wall, alt, lat, lon]
        st[0] = wall
        if alt is not None:
            st[1] = alt
        if lat is not None and lon is not None:
            st[2], st[3] = lat, lon
        ms.message(t, hx, res, alt if alt is not None else st[1], st[2], st[3])
        self._cmp(wall, both, df, res.get("bds"), alt if alt is not None else st[1])

    def _cmp(self, wall: float, both, df, bds, alt) -> None:
        t0 = float(int(wall // 60) * 60)
        with self._cmp_lock:
            cur = self._cmp_cur
            if cur is None or cur[0] != t0:
                cur = self._cmp_cur = (t0, Counter())
                self.cmp.append(cur)
            c = cur[1]
            c["frames"] += 1
            if both is None:
                return
            c["compared"] += 1
            low = alt is not None and alt < LOW_FT
            if bds == "5,0" and low:
                c["b50_low"] += 1
            if both:
                c["both"] += 1
            else:
                c["only"] += 1
                c[("only_df", df)] += 1
                if bds == "5,0" and low:
                    c["b50_low_only"] += 1

    # ── readsb's status (receiver.json / stats.json) ─────────────────────
    def _get(self, name: str):
        with urllib.request.urlopen(self.status_url + name, timeout=8) as r:
            data = r.read(2_000_000)
        traffic.add("status2", len(data))
        return json.loads(data.decode("utf-8", "replace"))

    def run_status(self) -> None:
        time.sleep(5)
        while True:
            try:
                rcv = self._get("receiver.json")
                st = {}
                try:
                    st = self._get("stats.json")
                except Exception:                  # noqa: BLE001  (receiver.json is enough)
                    pass
                pos = None
                try:
                    if rcv.get("lat") is not None and rcv.get("lon") is not None:
                        pos = (float(rcv["lat"]), float(rcv["lon"]))
                except (TypeError, ValueError):
                    pos = None
                self._set_site(pos)
                l1 = st.get("last1min") or {}
                rem = l1.get("remote") or {}
                md = l1.get("max_distance")
                self.status = {
                    "version": str(rcv.get("version") or "")[:40] or None,
                    "pos": bool(pos),
                    "msgs_1min": l1.get("messages_valid", l1.get("messages")),
                    "accepted_1min": (sum(rem.get("accepted") or []) if isinstance(rem.get("accepted"), list)
                                      else None),
                    "max_dist_nm": round(float(md) / 1852.0, 1) if isinstance(md, (int, float)) else None,
                    "ac_pos": st.get("aircraft_with_pos"),
                    "ac_nopos": st.get("aircraft_without_pos"),
                }
                self.status_ok = time.time()
                self.status_err = None
            except Exception as exc:               # noqa: BLE001
                self.status_err = f"not read ({exc.__class__.__name__})"
            time.sleep(STATUS_SEC)

    # ── the page ─────────────────────────────────────────────────────────
    def rate_now(self):
        """Frames per second in the last complete 10 s (None: none yet)."""
        ten = list(self.ms._ten)
        for t0, n in reversed(ten):
            if n is not None:
                return n / 10.0
        return None

    def public(self, window_min: int = 10) -> dict:
        now = time.time()
        off, kind = self._offset(now) if self.hz is not None else (None, None)
        ppm = None
        with self._clk_lock:
            dr = list(self.drift)
            npairs = len(self.pairs)
            spread = None
            if npairs >= SYNC_MIN_PAIRS and self.sync_off is not None:
                med = self.sync_off
                spread = round(statistics.median(abs(p[1] - med) for p in self.pairs) * 1e6, 1)
        if len(dr) >= 6 and dr[-1][0] - dr[0][0] >= 120:
            n = len(dr)
            mx = sum(x for x, _ in dr) / n
            my = sum(y for _, y in dr) / n
            sxx = sum((x - mx) ** 2 for x, _ in dr)
            if sxx > 0:
                ppm = round(sum((x - mx) * (y - my) for x, y in dr) / sxx * 1e6, 2)
        w = max(1, min(1440, int(window_min)))
        t_from = now - w * 60
        tot = Counter()
        with self._cmp_lock:
            for t0, c in self.cmp:
                if t0 + 60 > t_from:
                    tot.update(c)
        only_df = {str(k[1]): v for k, v in tot.items() if isinstance(k, tuple) and k[0] == "only_df"}
        st = None
        if self.status is not None:
            st = dict(self.status, age=round(now - self.status_ok) if self.status_ok else None)
        if self.status_err:
            st = dict(st or {}, err=self.status_err)
        state = self.clock_state if self.hz is None else (kind or "starting")
        return {
            "id": self.id, "name": self.name, "type": self.type, "main": False,
            "view": "main" if self.main else "extra", "is_main_rx": self.main, "bit": self.bit,
            "feed": {"host_local": self.host in ("127.0.0.1", "localhost", "::1"),
                     "connects": self.connects, "connected_ts": self.connected_ts,
                     "last_frame_age": round(now - self.last_frame, 1) if self.last_frame else None,
                     "err": self.err, "frames": self.frames, "bytes": self.bytes,
                     "down_sec": round(now - self.down_since) if self.down_since else None,
                     "skipped": dict(self.skipped)},
            "clock": {"kind": self.clock, "hz": self.hz, "state": state,
                      "main_gps": _RX1.alive(now), "pairs": npairs, "spread_us": spread,
                      "ppm": ppm, "resets": self.resets, "nogps": self.nogps},
            "delay": _delay_stats(self.delays),
            "cmp": {"window_min": w, "frames": tot["frames"], "compared": tot["compared"],
                    "both": tot["both"], "only": tot["only"], "only_df": only_df,
                    "b50_low": tot["b50_low"], "b50_low_only": tot["b50_low_only"], "low_ft": LOW_FT},
            "site": {"src": self.ms.site_src, "private": self.private,
                     "pos": self.ms._pub_site(self.ms.site)},
            "readsb": st if self.status_url else None,
        }


# ── set-up and the page ─────────────────────────────────────────────────────
def init(cfg) -> list:
    """Create the readers of EXTRA_RECEIVERS (not started), and with
    RECEIVERS_MERGE the main receiver's own reader and the merger.  [] when
    there are no other receivers (nothing changes then)."""
    # RECEIVER_ID / RECEIVER_NAME / EXTRA_RECEIVERS / RECEIVERS_MERGE: optional
    # (config_local.py); config.py has none of them, so it needs no change
    _main.update(id=str(getattr(cfg, "RECEIVER_ID", "MODES-RX-01") or "MODES-RX-01"),
                 name=str(getattr(cfg, "RECEIVER_NAME", "Tuusula") or ""), type="radarcape")
    out = []
    for spec in getattr(cfg, "EXTRA_RECEIVERS", None) or []:
        try:
            if not spec.get("id") or not spec.get("port") or spec["id"] == _main["id"] or spec["id"] in _RX:
                log.warning("EXTRA_RECEIVERS: entry skipped (id / port missing or the id used twice)")
                continue
            rx = Rx(spec, cfg, bit=len(out) + 1)
        except Exception as exc:                   # noqa: BLE001
            log.warning("EXTRA_RECEIVERS: entry not usable: %s", exc)
            continue
        _RX[rx.id] = rx
        out.append(rx)
    if out and bool(getattr(cfg, "RECEIVERS_MERGE", False)):
        global _MERGER
        _main["rx"] = Rx({"id": _main["id"], "name": _main["name"], "type": "radarcape",
                          "host": cfg.RADARCAPE_HOST, "port": cfg.RADARCAPE_PORT, "clock": "gps",
                          "private": False}, cfg, bit=0, main=True)
        _MERGER = Merger(len(out) + 1)
        _state["merge"] = True
    return out


def start(rxs: list) -> None:
    """Start the readers (after the statistics were restored)."""
    if not rxs:
        return
    if _state["merge"]:
        m = _main["rx"]
        threading.Thread(target=m.run, name=f"rx_{m.id}", daemon=True).start()
        log.info("Receivers merged: %s (own reader at %s:%d) and %s; replies passed on %.1f s after "
                 "their time, duplicates removed", m.id, m.host, m.port, ", ".join(r.id for r in rxs),
                 MERGE_HOLD_SEC)
    else:
        from collector import beast_sig
        beast_sig.set_tap(_RX1.tap)
    for rx in rxs:
        threading.Thread(target=rx.run, name=f"rx_{rx.id}", daemon=True).start()
        if rx.status_url:
            threading.Thread(target=rx.run_status, name=f"rxs_{rx.id}", daemon=True).start()
        log.info("Other receiver %s (%s, %s clock) %s at %s:%d%s", rx.id, rx.type, rx.clock,
                 "merged" if _state["merge"] else "watched", rx.host, rx.port,
                 " with readsb status" if rx.status_url else "")


def active() -> bool:
    return bool(_RX)


def merging() -> bool:
    return _state["merge"]


def merger() -> Merger | None:
    return _MERGER


def main_id() -> str:
    return _main["id"]


def main_rx():
    """The main receiver's own reader (phase 2), else None."""
    return _main["rx"]


def get(rx_id: str):
    """An Rx by id: another receiver, or (phase 2) the main receiver's reader."""
    if _main["rx"] is not None and rx_id == _main["id"]:
        return _main["rx"]
    return _RX.get(rx_id)


def extras() -> list:
    return list(_RX.values())


def main_public() -> dict:
    """Phase 1: the main receiver (read by pyModeS): its id, name and the GPS
    time check of its frames."""
    now = time.time()
    return {"id": _main["id"], "name": _main["name"], "type": _main["type"], "main": True, "view": "main",
            "gps": {"ok": _RX1.gps_ok, "bad": _RX1.gps_bad, "alive": _RX1.alive(now)} if _RX else None,
            "delay": _delay_stats(_RX1.delays) if _RX else None}


def all_public(window_min: int = 10) -> dict:
    """Phase 2, the All receivers view: the merger's counts and each receiver."""
    rxs = ([_main["rx"]] if _main["rx"] is not None else []) + list(_RX.values())
    now = time.time()
    lst = []
    for r in rxs:
        age = now - r.last_frame if r.last_frame else None
        p = r.public(window_min)
        lst.append({"id": r.id, "name": r.name, "type": r.type, "bit": r.bit, "rate": r.rate_now(),
                    "live": age is not None and age < 60, "clock": p["clock"]["state"],
                    "frames": p["feed"]["frames"], "delay": p["delay"], "cmp": p["cmp"]})
    return {"id": "ALL", "name": "All receivers", "type": "merged", "main": True, "view": "all",
            "merged": _MERGER.public(window_min) if _MERGER else None, "receivers": lst}


def receivers() -> list:
    """The receivers for the page's selector.  'sel' is the value of ?rx= that
    shows it ('' = the default view)."""
    now = time.time()
    last = msg_stats.get().last_msg_ts
    out = []
    if _state["merge"]:
        out.append({"id": "ALL", "name": "All receivers", "type": "merged", "main": True, "sel": "",
                    "clock": "merged", "live": last is not None and now - last < 60})
        m = _main["rx"]
        age = now - m.last_frame if m.last_frame else None
        out.append({"id": m.id, "name": m.name, "type": m.type, "main": False, "sel": m.id,
                    "clock": "gps", "live": age is not None and age < 60})
    else:
        out.append({"id": _main["id"], "name": _main["name"], "type": _main["type"], "main": True, "sel": "",
                    "clock": "gps", "live": last is not None and now - last < 60})
    for rx in _RX.values():
        age = now - rx.last_frame if rx.last_frame else None
        out.append({"id": rx.id, "name": rx.name, "type": rx.type, "main": False, "sel": rx.id,
                    "clock": rx.clock, "live": age is not None and age < 60})
    return out
