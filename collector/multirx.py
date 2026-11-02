"""
multirx.py — more receivers: the other Beast feeds, watched (from 2026-11-02;
phase 1 of the multi-receiver work).

The main receiver (RADARCAPE_HOST / RADARCAPE_PORT, RECEIVER_ID, by default
MODES-RX-01, the Radarcape) stays the only source of the weather: nothing of
the decoding, the winds, the series or the database changes.  Each receiver in
EXTRA_RECEIVERS (config_local.py) is read by its own thread here:

  • its own Beast reader (TCP client, reconnects every 10 s): the frames with
    their 48-bit time stamp and signal byte; Mode A/C frames (readsb's
    heartbeat: type 0x31 with zero time and payload) and status frames are
    skipped; the bytes go to the data transfer counters (beast2);
  • its clock: airspy_adsb / readsb stamp the frames with a free-running
    counter (12 / 20 / 24 MHz = the sample rate; restarts with the program),
    not with real time.  The counter is lined up with the main receiver's GPS
    time from the ADS-B messages both receivers heard (DF17: the same 112 bits
    within a second are the same transmission): the median of the last 101
    time differences.  Measured on 2 Nov 2026 (10 min): AirSpy R2 12 MHz,
    −0.2 ppm, spread of the differences 32 µs (= the different distance from
    the aircraft to the two sites), so the lined-up times are good to well
    under a millisecond.  Without the main receiver (down, or not in GPS
    mode) the time is the counter plus the smallest arrival delay of the last
    minute (good to some tens of milliseconds);
  • the comparison: each frame is held HOLD_SEC (the main receiver's copy
    can arrive up to ~0.4 s later through its tunnel) and then looked up
    among the main receiver's frames: the same bytes within DUP_SEC (5 ms)
    of the lined-up time = heard by both, else heard only here.  1 ms and
    5 ms found the same pairs in the test; 100 ms would wrongly join 1.4 %
    (separate identical replies), so no wider window is used — without the
    main receiver there is nothing to compare;
  • its statistics: a MsgStats of its own (collector/msg_stats.py: the same
    panels as the main receiver's, stored hours in msg_stats_rx_hours),
    filled from its own PipeDecoder (decoded for the statistics only);
  • readsb's status (optional status_url, once a minute): receiver.json
    gives the antenna position (readsb-set-location at the site, so a mobile
    station needs no change here), stats.json the message counts.

The main receiver's frames come from collector/beast_sig.py (set_tap): the
same bytes pyModeS parsed, with the Radarcape's GPS time stamp (upper 18
bits: second of the UTC day, lower 30 bits: nanoseconds — 2^30 counts a
second; confirmed in the test).  RAM only (the comparison counts of the last
24 h); a few µs per frame.
"""

from __future__ import annotations

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

HOLD_SEC = 0.6            # a frame waits this long for the main receiver's copy
DUP_SEC = 0.005           # same bytes within this (lined-up time): heard by both
PAIR_SEC_SYNCED = 0.05    # DF17 pair window once lined up
PAIR_SEC_START = 2.0      # … before that (the counter plus the arrival delay)
PAIR_N = 101              # time differences in the running median
SYNC_MIN_PAIRS = 15
SYNC_MAX_AGE = 120.0      # s without a new pair: back to the own clock
RX1_KEEP_SEC = 5.0        # the main receiver's frames kept for the look-up
RX1_ALIVE_SEC = 10.0      # main receiver frames this recent: compare
LOW_FT = 1500             # "low" replies (altitude, ft): BDS 5,0 heard only here
STATUS_SEC = 60.0
CLOCK_HZ = {"12mhz": 12e6, "20mhz": 20e6, "24mhz": 24e6}
_BODY = {0x31: 9, 0x32: 14, 0x33: 21}

_lock = threading.Lock()
_RX: dict = {}            # id → ExtraRx
_main = {"id": "MODES-RX-01", "name": "", "type": "radarcape"}


# ── the main receiver's frames (collector thread, via beast_sig) ─────────────
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

    def tap(self, frames, wall: float) -> None:
        """pyModeS's frames of one receive burst: [(48-bit stamp, hex), …]."""
        day0 = wall - (wall % 86400)
        q = self.q
        for ticks, hx in frames:
            ns = ticks & 0x3FFFFFFF
            if ns >= 1_000_000_000:
                self.gps_bad += 1
                continue
            t = day0 + (ticks >> 30) + ns * 1e-9
            if t - wall > 43200:
                t -= 86400
            elif wall - t > 43200:
                t += 86400
            if abs(t - wall) > 30:                 # not GPS time (12 MHz mode, no GPS)
                self.gps_bad += 1
                continue
            self.gps_ok += 1
            q.append((t, hx))
            self._n += 1
            if self._n % 8 == 0:
                self.delays.append(wall - t)
        if self.gps_ok:
            self.last_wall = wall

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


def _pct(vals, q):
    if not vals:
        return None
    v = sorted(vals)
    return v[min(len(v) - 1, int(q * len(v)))]


def _delay_stats(vals) -> dict | None:
    v = [x for x in vals if x is not None]
    if len(v) < 20:
        return None
    return {"min": round(min(v) * 1000, 1), "p50": round(_pct(v, 0.5) * 1000, 1),
            "p99": round(_pct(v, 0.99) * 1000, 1), "max": round(max(v) * 1000, 1), "n": len(v)}


# ── one other receiver ──────────────────────────────────────────────────────
class ExtraRx:
    def __init__(self, spec: dict, cfg) -> None:
        self.id = str(spec["id"])
        self.name = str(spec.get("name") or self.id)
        self.type = str(spec.get("type") or "readsb").lower()
        self.host = str(spec.get("host") or "127.0.0.1")
        self.port = int(spec["port"])
        clock = str(spec.get("clock") or ("gps" if self.type == "radarcape" else "12mhz")).lower()
        self.clock = clock if clock in CLOCK_HZ or clock == "gps" else "12mhz"
        self.hz = CLOCK_HZ.get(self.clock)
        self.status_url = spec.get("status_url") or None
        if self.status_url and not self.status_url.endswith("/"):
            self.status_url += "/"
        self.private = bool(spec.get("private", True))
        self.cfg_pos = ((float(spec["lat"]), float(spec["lon"]))
                        if spec.get("lat") is not None and spec.get("lon") is not None else None)
        self.blocked = tuple(getattr(cfg, "BLOCKED_ICAO_PREFIXES", ()) or ())
        self.surface_ref = (float(cfg.RECEIVER_LAT), float(cfg.RECEIVER_LON))
        # statistics (msg_stats panels)
        ms = self.ms = msg_stats.add_receiver(self.id)
        ms.keep_days = float(getattr(cfg, "MSG_STATS_DAYS", 7))
        ms.airport = (cfg.WINDSHEAR_AIRPORT_LAT, cfg.WINDSHEAR_AIRPORT_LON)
        ms.site_centre = (float(cfg.RECEIVER_LAT), float(cfg.RECEIVER_LON))
        ms.site_round = 2 if self.private else None
        ms.sig_state = "on"
        ms.sig_parser = lambda: {"installed": True, "reason": "", "own_reader": True}
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
        self.pairs: deque = deque(maxlen=PAIR_N)   # (arrival, t1 − counter time)
        self.sync_off = None
        self.sync_ts = None
        self.env: deque = deque(maxlen=60)         # [second, min(arrival − counter time)]
        self.drift: deque = deque(maxlen=60)       # (counter time, offset) every 10 s → ppm
        self.delays: deque = deque(maxlen=6000)
        self._n = 0
        # comparison per minute: t0 → Counter (24 h)
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
                traffic.add("beast2", len(chunk))
                buf += chunk
                buf = self._parse(buf, now)
            self._process(now)

    def _parse(self, buf: bytes, wall: float) -> bytes:
        """Beast frames of buf → pending; the incomplete rest is returned."""
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
            pend.append((wall, int.from_bytes(body[:6], "big"), body[6], bytes(body[7:]).hex().upper()))
        rest = buf[last:]
        return rest if len(rest) < 1 << 16 else b""

    # ── the clock ────────────────────────────────────────────────────────
    def _ctr_time(self, ctr: int) -> float:
        if self.hz is None:                        # a Radarcape in GPS mode: seconds of the day
            return (ctr >> 30) + (ctr & 0x3FFFFFFF) * 1e-9
        return ctr / self.hz

    def _offset(self, now: float):
        """(offset, 'sync' / 'own') to add to the counter time; None at the start."""
        if self.sync_off is not None and self.sync_ts is not None and now - self.sync_ts < SYNC_MAX_AGE \
                and len(self.pairs) >= SYNC_MIN_PAIRS:
            return self.sync_off, "sync"
        if self.env:
            return min(e[1] for e in self.env), "own"
        return None, None

    def _reset_clock(self) -> None:
        self.resets += 1
        self.pairs.clear()
        self.sync_off = self.sync_ts = None
        self.env.clear()
        self.drift.clear()

    # ── comparison and statistics of the held frames ─────────────────────
    def _process(self, now: float) -> None:
        pend = self.pending
        if not pend or pend[0][0] > now - HOLD_SEC:
            return
        _RX1.drain()
        rx1_alive = _RX1.alive(now)
        while pend and pend[0][0] <= now - HOLD_SEC:
            wall, ctr, sig, hx = pend.popleft()
            try:
                self._one(wall, ctr, sig, hx, rx1_alive)
            except Exception as exc:               # noqa: BLE001
                log.debug("%s: frame not handled: %s", self.id, exc)
        if now - self._ac_prune > 60:
            self._ac_prune = now
            cut = now - 600
            for k in [k for k, v in self._ac.items() if v[0] < cut]:
                del self._ac[k]

    def _one(self, wall: float, ctr: int, sig: int, hx: str, rx1_alive: bool) -> None:
        self.frames += 1
        self.last_frame = wall
        ct = self._ctr_time(ctr)
        # counter restart / jump (the program on the receiver restarted)
        if self.last_ctr is not None and self.hz is not None:
            d = (ctr - self.last_ctr) / self.hz
            if d < -1.0 or d > 3600.0:
                self._reset_clock()
        self.last_ctr = ctr
        # smallest arrival − counter time per second (the own clock)
        sec = int(wall)
        e = wall - ct
        env = self.env
        if env and env[-1][0] == sec:
            if e < env[-1][1]:
                env[-1][1] = e
        else:
            env.append([sec, e])
        off, kind = self._offset(wall)
        t = ct + off if off is not None else wall
        if self.hz is None and off is None:        # GPS stamp without a day yet
            t = wall
        try:
            df = int(hx[:2], 16) >> 3
        except ValueError:
            df = None
        # the comparison with the main receiver
        both = None
        if rx1_alive:
            cands = _RX1.lookup(hx)
            if kind == "sync":
                both = bool(cands) and any(abs(c - t) < DUP_SEC for c in cands)
            elif cands:
                both = any(abs(c - t) < 1.0 for c in cands)
            else:
                both = False
            if df == 17 and cands:
                win = PAIR_SEC_SYNCED if kind == "sync" else PAIR_SEC_START
                near = [c for c in cands if abs(c - t) < win] if off is not None else cands
                if len(near) == 1:
                    with self._clk_lock:
                        self.pairs.append((wall, near[0] - ct))
                        self.sync_off = statistics.median(p[1] for p in self.pairs)
                        self.sync_ts = wall
                        if not self.drift or ct - self.drift[-1][0] >= 10:
                            self.drift.append((ct, self.sync_off))
        if kind == "sync":
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
        off, kind = self._offset(now)
        ppm = None
        with self._clk_lock:
            dr = list(self.drift)
            npairs = len(self.pairs)
            spread = None
            if npairs >= SYNC_MIN_PAIRS:
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
        return {
            "id": self.id, "name": self.name, "type": self.type, "main": False,
            "feed": {"host_local": self.host in ("127.0.0.1", "localhost", "::1"),
                     "connects": self.connects, "connected_ts": self.connected_ts,
                     "last_frame_age": round(now - self.last_frame, 1) if self.last_frame else None,
                     "err": self.err, "frames": self.frames, "bytes": self.bytes,
                     "down_sec": round(now - self.down_since) if self.down_since else None,
                     "skipped": dict(self.skipped)},
            "clock": {"kind": self.clock, "hz": self.hz, "state": kind or "starting",
                      "main_gps": _RX1.alive(now), "pairs": npairs, "spread_us": spread,
                      "ppm": ppm, "resets": self.resets},
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
    """Create the readers of EXTRA_RECEIVERS (not started).  [] when none."""
    # RECEIVER_ID / RECEIVER_NAME / EXTRA_RECEIVERS: optional (config_local.py);
    # config.py has none of them, so it needs no change on any machine
    _main.update(id=str(getattr(cfg, "RECEIVER_ID", "MODES-RX-01") or "MODES-RX-01"),
                 name=str(getattr(cfg, "RECEIVER_NAME", "Tuusula") or ""), type="radarcape")
    out = []
    for spec in getattr(cfg, "EXTRA_RECEIVERS", None) or []:
        try:
            if not spec.get("id") or not spec.get("port") or spec["id"] == _main["id"] or spec["id"] in _RX:
                log.warning("EXTRA_RECEIVERS: entry skipped (id / port missing or the id used twice)")
                continue
            rx = ExtraRx(spec, cfg)
        except Exception as exc:                   # noqa: BLE001
            log.warning("EXTRA_RECEIVERS: entry not usable: %s", exc)
            continue
        _RX[rx.id] = rx
        out.append(rx)
    return out


def start(rxs: list) -> None:
    """Start the readers (after the statistics were restored)."""
    if not rxs:
        return
    from collector import beast_sig
    beast_sig.set_tap(_RX1.tap)
    for rx in rxs:
        threading.Thread(target=rx.run, name=f"rx_{rx.id}", daemon=True).start()
        if rx.status_url:
            threading.Thread(target=rx.run_status, name=f"rxs_{rx.id}", daemon=True).start()
        log.info("Other receiver %s (%s, %s clock) watched at %s:%d%s", rx.id, rx.type, rx.clock,
                 rx.host, rx.port, " with readsb status" if rx.status_url else "")


def active() -> bool:
    return bool(_RX)


def get(rx_id: str):
    return _RX.get(rx_id)


def extras() -> list:
    return list(_RX.values())


def main_public() -> dict:
    """The main receiver: its id, name and the GPS time check of its frames."""
    now = time.time()
    return {"id": _main["id"], "name": _main["name"], "type": _main["type"], "main": True,
            "gps": {"ok": _RX1.gps_ok, "bad": _RX1.gps_bad, "alive": _RX1.alive(now)} if _RX else None,
            "delay": _delay_stats(_RX1.delays) if _RX else None}


def receivers() -> list:
    """The receivers for the page's selector (the main one first)."""
    now = time.time()
    last = msg_stats.get().last_msg_ts
    out = [{"id": _main["id"], "name": _main["name"], "type": _main["type"], "main": True,
            "clock": "gps", "live": last is not None and now - last < 60}]
    for rx in _RX.values():
        age = now - rx.last_frame if rx.last_frame else None
        out.append({"id": rx.id, "name": rx.name, "type": rx.type, "main": False,
                    "clock": rx.clock, "live": age is not None and age < 60})
    return out
