"""
collector/beast_feed.py — a local Beast feed of the receivers' replies for other
programs on the same machine (from 2026-11-03).

The collector (collector/receiver.py) reads every reply once: on AWS the
merger's stream of all receivers (collector/multirx.py — clocks lined up,
duplicates removed, in time order, about 0.8 s late), on a single-receiver
station the Radarcape's own frames.  When the feed is switched on
(Maintenance page, off by default) each reply is also written, in the binary
Beast format, to every program connected to 127.0.0.1:BEAST_FEED_PORT (31005
unless config_local.py says otherwise):

    0x1a, '2' (56-bit Mode S) or '3' (112-bit), 6-byte time stamp,
    1 signal byte, the payload — every 0x1a byte in the frame doubled.

 • a continuous stream: a client stays connected and gets the replies as they
   come (readsb / dump1090 --net-connector …,beast_in, pyModeS TcpClient, …);
 • the time stamp: a 12 MHz counter of the reply's time (default, what most
   programs expect), the Radarcape's GPS form (second of the UTC day << 30 |
   nanoseconds) or zero — set on the Maintenance page;
 • the signal byte of the first receiver that heard the reply (the receivers'
   scales differ);
 • which replies: all merged (default) or only those one receiver heard;
 • NOT for multilateration: the merged time stamps come from different
   receivers lined up to some tens of microseconds — good for decoding,
   useless for MLAT (never feed it to mlat-client or an MLAT network);
 • every client has its own buffer; one that falls more than MAX_BUF bytes
   behind is disconnected (counted), so a slow program never holds up the
   collector;
 • localhost only (bound to 127.0.0.1), the raw frames as the receivers heard
   them, nothing stored; off: no socket at all.  Settings in
   maintenance_config (beast_feed_enabled '0' by default, beast_feed_rx,
   beast_feed_ts), each machine its own.
"""

from __future__ import annotations

import logging
import socket
import threading
import time
from collections import deque
from typing import Optional

log = logging.getLogger("modes.beast_feed")

DEFAULT_PORT = 31005
MAX_BUF = 2 * 1024 * 1024          # bytes a client may fall behind before it is dropped
SEND_TIMEOUT = 10.0
TS_MODES = ("12mhz", "gps", "zero")
_KEYS = {"enabled": "beast_feed_enabled", "rx": "beast_feed_rx", "ts": "beast_feed_ts"}
_DEFAULTS = {"enabled": "0", "rx": "all", "ts": "12mhz"}


# ── encoding ──────────────────────────────────────────────────────────────────

def _ts_bytes(t: float, mode: str) -> bytes:
    if mode == "zero" or not t:
        return b"\x00" * 6
    if mode == "gps":
        day = t % 86400.0
        sec = int(day)
        ns = int(round((day - sec) * 1e9))
        if ns >= 1_000_000_000:
            sec, ns = sec + 1, ns - 1_000_000_000
        v = ((sec % 86400) << 30) | ns
    else:                                           # 12 MHz counter
        v = int(round(t * 12_000_000))
    return (v & 0xFFFFFFFFFFFF).to_bytes(6, "big")


def encode(hx: str, t: float, sig, mode: str = "12mhz") -> Optional[bytes]:
    """One Beast frame for a Mode S reply (hex of 14 or 28 digits), else None."""
    try:
        payload = bytes.fromhex(hx)
    except ValueError:
        return None
    if len(payload) == 7:
        kind = b"2"
    elif len(payload) == 14:
        kind = b"3"
    else:
        return None
    s = sig if isinstance(sig, int) and 0 <= sig <= 255 else 0
    body = _ts_bytes(t, mode) + bytes((s,)) + payload
    return b"\x1a" + kind + body.replace(b"\x1a", b"\x1a\x1a")


# ── settings (maintenance_config) ─────────────────────────────────────────────

def get_settings(conn) -> dict:
    out = dict(_DEFAULTS)
    try:
        for k, key in _KEYS.items():
            r = conn.execute("SELECT value FROM maintenance_config WHERE key = ?", (key,)).fetchone()
            if r and r[0] is not None:
                out[k] = r[0]
    except Exception:                                  # noqa: BLE001  (old database)
        pass
    if out["ts"] not in TS_MODES:
        out["ts"] = "12mhz"
    return {"enabled": out["enabled"] == "1", "rx": out["rx"] or "all", "ts": out["ts"]}


def set_settings(conn, enabled=None, rx=None, ts=None) -> dict:
    vals = {}
    if enabled is not None:
        vals["enabled"] = "1" if enabled else "0"
    if rx is not None:
        vals["rx"] = str(rx)[:40] or "all"
    if ts is not None and ts in TS_MODES:
        vals["ts"] = ts
    if vals:
        conn.execute("CREATE TABLE IF NOT EXISTS maintenance_config (key TEXT PRIMARY KEY, value TEXT)")
        for k, v in vals.items():
            conn.execute("INSERT OR REPLACE INTO maintenance_config (key, value) VALUES (?, ?)", (_KEYS[k], v))
        conn.commit()
    return get_settings(conn)


def receiver_bits() -> list:
    """[{id, name, bit}] of the receivers whose replies can be chosen alone."""
    try:
        from collector import multirx
        if multirx.merging():
            out = []
            m = multirx.main_rx()
            for r in ([m] if m is not None else []) + multirx.extras():
                out.append({"id": r.id, "name": r.name, "bit": r.bit})
            return out
        return [{"id": multirx.main_id(), "name": "", "bit": 0}]
    except Exception:                                  # noqa: BLE001
        return []


# ── the server ────────────────────────────────────────────────────────────────

class _Client:
    def __init__(self, sock: socket.socket, addr) -> None:
        self.sock = sock
        self.addr = addr
        self.since = time.time()
        self.buf = bytearray()
        self.cv = threading.Condition()
        self.closed = False
        self.frames = 0
        self.bytes = 0
        self.why = ""

    def put(self, data: bytes) -> bool:
        with self.cv:
            if self.closed:
                return False
            if len(self.buf) + len(data) > MAX_BUF:
                self.why = "too slow (more than 2 MB behind)"
                self.closed = True
                self.cv.notify()
                return False
            self.buf += data
            self.frames += 1
            self.cv.notify()
            return True

    def close(self, why: str = "") -> None:
        with self.cv:
            if not self.closed:
                self.closed = True
                self.why = self.why or why
            self.cv.notify()

    def run(self, on_end) -> None:
        try:
            self.sock.settimeout(SEND_TIMEOUT)
            while True:
                with self.cv:
                    while not self.buf and not self.closed:
                        self.cv.wait(timeout=1.0)
                    if self.closed:
                        break
                    data = bytes(self.buf)
                    self.buf.clear()
                self.sock.sendall(data)
                self.bytes += len(data)
        except OSError as e:
            self.why = self.why or f"disconnected ({e.__class__.__name__})"
        finally:
            try:
                self.sock.close()
            except Exception:                          # noqa: BLE001
                pass
            on_end(self)


class BeastFeed:
    def __init__(self, port: int = DEFAULT_PORT):
        self.port = int(port)
        self._sock: Optional[socket.socket] = None
        self._lock = threading.Lock()
        self._clients: list = []
        self.started = None
        self.error = None
        self.ts_mode = "12mhz"
        self.rx = "all"
        self._rx_bit: Optional[int] = None             # None = all
        self.frames_total = 0
        self.bytes_total = 0
        self.frames_day = 0
        self._day = ""
        self.clients_total = 0
        self.dropped = 0
        self.ended: deque = deque(maxlen=5)            # (time, reason) of the last clients that left
        self._rate: deque = deque()                    # second → frames, the last 60 s
        self._rate_sec = 0
        self._rate_n = 0

    # the collector calls this for every reply (cheap when nobody is connected)
    def publish(self, hx: str, t: float, sig=None, mask=None) -> None:
        if not self._clients:
            return
        if self._rx_bit is not None and mask is not None and not (mask >> self._rx_bit) & 1:
            return
        fr = encode(hx, t, sig, self.ts_mode)
        if fr is None:
            return
        for c in list(self._clients):
            c.put(fr)
        self.frames_total += 1
        self.bytes_total += len(fr)
        now = time.time()
        day = time.strftime("%Y-%m-%d", time.gmtime(now))
        if day != self._day:
            self._day, self.frames_day = day, 0
        self.frames_day += 1
        sec = int(now)
        if sec != self._rate_sec:
            if self._rate_sec:
                self._rate.append((self._rate_sec, self._rate_n))
            self._rate_sec, self._rate_n = sec, 0
            while self._rate and self._rate[0][0] < sec - 60:
                self._rate.popleft()
        self._rate_n += 1

    @property
    def running(self) -> bool:
        return self._sock is not None

    def configure(self, rx: str = None, ts: str = None) -> None:
        if ts in TS_MODES:
            self.ts_mode = ts
        if rx is not None:
            self.rx = rx or "all"
            bit = None
            if self.rx != "all":
                for r in receiver_bits():
                    if r["id"] == self.rx:
                        bit = r["bit"]
                        break
            self._rx_bit = bit

    def start(self) -> bool:
        with self._lock:
            if self._sock is not None:
                return True
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind(("127.0.0.1", self.port))
                s.listen(8)
                s.settimeout(1.0)
            except OSError as e:
                try:
                    s.close()
                except Exception:                      # noqa: BLE001
                    pass
                self.error = (time.time(), f"127.0.0.1:{self.port}: {e}")
                log.warning("Beast feed: cannot open %s", self.error[1])
                return False
            self._sock = s
            self.started = time.time()
            self.error = None
            threading.Thread(target=self._accept, args=(s,), name="beast_feed", daemon=True).start()
            log.info("Beast feed on 127.0.0.1:%d (replies of %s, time stamps %s)", self.port, self.rx, self.ts_mode)
            return True

    def stop(self) -> None:
        with self._lock:
            s, self._sock = self._sock, None
            self.started = None
            clients = list(self._clients)
        if s is not None:
            try:
                s.shutdown(socket.SHUT_RDWR)          # wakes the accept() at once: the port is closed now
            except OSError:
                pass
            try:
                s.close()
            except Exception:                          # noqa: BLE001
                pass
            log.info("Beast feed closed (127.0.0.1:%d)", self.port)
        for c in clients:
            c.close("the feed was switched off")

    def _accept(self, s: socket.socket) -> None:
        while self._sock is s:
            try:
                conn, addr = s.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError:
                pass
            c = _Client(conn, addr)
            with self._lock:
                if self._sock is not s:
                    conn.close()
                    break
                self._clients.append(c)
                self.clients_total += 1
            log.info("Beast feed: a client connected (%d now)", len(self._clients))
            threading.Thread(target=c.run, args=(self._ended,), name="beast_feed_client", daemon=True).start()

    def _ended(self, c: _Client) -> None:
        with self._lock:
            if c in self._clients:
                self._clients.remove(c)
        if c.why.startswith("too slow"):
            self.dropped += 1
        self.ended.append((time.time(), c.why or "disconnected"))
        log.info("Beast feed: a client left — %s (%d now)", c.why or "disconnected", len(self._clients))

    def apply(self, settings: dict) -> None:
        self.configure(rx=settings.get("rx", "all"), ts=settings.get("ts", "12mhz"))
        if settings.get("enabled"):
            self.start()
        else:
            self.stop()

    def status(self, conn=None) -> dict:
        now = time.time()
        today = time.strftime("%Y-%m-%d", time.gmtime(now))
        n60 = sum(n for s, n in self._rate if s >= now - 60)
        return {
            "settings": get_settings(conn) if conn is not None else None,
            "running": self.running, "host": "127.0.0.1", "port": self.port,
            "started": self.started, "error": list(self.error) if self.error else None,
            "rx": self.rx, "rx_found": self.rx == "all" or self._rx_bit is not None, "ts": self.ts_mode,
            "receivers": receiver_bits(),
            "clients": [{"since": c.since, "frames": c.frames, "bytes": c.bytes, "behind": len(c.buf)}
                        for c in list(self._clients)],
            "clients_total": self.clients_total, "dropped": self.dropped,
            "ended": [list(e) for e in self.ended],
            "frames_today": self.frames_day if self._day == today else 0,
            "frames_total": self.frames_total, "bytes_total": self.bytes_total,
            "rate": round(n60 / 60.0, 1),
        }


_feed: Optional[BeastFeed] = None


def init(cfg, get_db) -> BeastFeed:
    """Create the feed and open it when the saved setting says so (at the start)."""
    global _feed
    _feed = BeastFeed(getattr(cfg, "BEAST_FEED_PORT", DEFAULT_PORT) or DEFAULT_PORT)
    try:
        s = get_settings(get_db())
    except Exception:                                  # noqa: BLE001
        s = {"enabled": False, "rx": "all", "ts": "12mhz"}
    _feed.apply(s)
    return _feed


def get() -> Optional[BeastFeed]:
    return _feed


def publish(hx: str, t: float, sig=None, mask=None) -> None:
    f = _feed
    if f is not None and f._clients:
        f.publish(hx, t, sig, mask)
