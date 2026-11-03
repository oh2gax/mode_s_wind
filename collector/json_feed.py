"""
collector/json_feed.py — a local feed of the Radarcape aircraft list for other
programs on the same machine (from 2026-11-03).

The JSON poller (collector/radarcape_json.py) reads the Radarcape's
aircraftlist.json every 2 s; it hands each good copy to set_snapshot().  When
the feed is switched on (Maintenance page, off by default) a small TCP server
on 127.0.0.1:JSON_FEED_PORT (31009 unless config_local.py says otherwise)
answers every connection with that copy as it came from the Radarcape — a JSON
array of aircraft — and closes the connection: the protocol of the JSON relay
that the separate modes_logger program reads, so it can run on the same
machine without polling the Radarcape a second time.

 • localhost only: the socket is bound to 127.0.0.1, never reachable from
   outside and not served through the web server;
 • the latest list only, nothing stored; a list older than STALE_SEC (the
   Radarcape or its tunnel down) is sent as [] so nothing stale is logged;
 • off: no socket at all.  The setting is in maintenance_config
   (json_feed_enabled, '0' by default), so it survives restarts and updates
   and each machine has its own.
"""

from __future__ import annotations

import logging
import socket
import threading
import time
from typing import Optional

log = logging.getLogger("modes.json_feed")

DEFAULT_PORT = 31009
STALE_SEC = 10.0
_KEY = "json_feed_enabled"

_snap_lock = threading.Lock()
_raw: bytes = b""
_raw_ts: float = 0.0


def set_snapshot(raw: bytes, ts: Optional[float] = None) -> None:
    """The newest aircraft list as received (called by the JSON poller)."""
    global _raw, _raw_ts
    with _snap_lock:
        _raw = raw
        _raw_ts = ts or time.time()


def snapshot(now: Optional[float] = None):
    """(bytes to send, age in s or None): the list, or b'[]' when none or stale."""
    now = now or time.time()
    with _snap_lock:
        raw, ts = _raw, _raw_ts
    if not raw or not ts:
        return b"[]", None
    age = now - ts
    return (raw if age <= STALE_SEC else b"[]"), age


# ── settings (maintenance_config) ─────────────────────────────────────────────

def get_settings(conn) -> dict:
    try:
        r = conn.execute("SELECT value FROM maintenance_config WHERE key = ?", (_KEY,)).fetchone()
    except Exception:                                  # noqa: BLE001  (old database)
        r = None
    return {"enabled": (r[0] if r else "0") == "1"}          # off by default


def set_settings(conn, enabled=None) -> dict:
    if enabled is not None:
        conn.execute("CREATE TABLE IF NOT EXISTS maintenance_config (key TEXT PRIMARY KEY, value TEXT)")
        conn.execute("INSERT OR REPLACE INTO maintenance_config (key, value) VALUES (?, ?)",
                     (_KEY, "1" if enabled else "0"))
        conn.commit()
    return get_settings(conn)


# ── the server ────────────────────────────────────────────────────────────────

class JsonFeed:
    def __init__(self, port: int = DEFAULT_PORT):
        self.port = int(port)
        self._sock: Optional[socket.socket] = None
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self.started = None              # time the socket was opened
        self.error = None                # (time, text) of the last failure to open it
        self.requests_total = 0
        self.requests_day = 0
        self._day = ""
        self.last = None                 # (time, bytes sent, age of the list or None)

    @property
    def running(self) -> bool:
        return self._sock is not None

    def start(self) -> bool:
        with self._lock:
            if self._sock is not None:
                return True
            try:
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
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
                log.warning("JSON feed: cannot open %s", self.error[1])
                return False
            self._sock = s
            self.started = time.time()
            self.error = None
            self._thread = threading.Thread(target=self._serve, args=(s,), name="json_feed", daemon=True)
            self._thread.start()
            log.info("JSON feed on 127.0.0.1:%d (the Radarcape aircraft list for local programs)", self.port)
            return True

    def stop(self) -> None:
        with self._lock:
            s, self._sock = self._sock, None
            self.started = None
        if s is not None:
            try:
                s.close()
            except Exception:                          # noqa: BLE001
                pass
            log.info("JSON feed closed (127.0.0.1:%d)", self.port)

    def _serve(self, s: socket.socket) -> None:
        while self._sock is s:
            try:
                conn, _addr = s.accept()
            except socket.timeout:
                continue
            except OSError:
                break                                  # closed by stop()
            try:
                conn.settimeout(5.0)
                data, age = snapshot()
                conn.sendall(data)
                try:
                    conn.shutdown(socket.SHUT_WR)
                except OSError:
                    pass
                now = time.time()
                day = time.strftime("%Y-%m-%d", time.gmtime(now))
                if day != self._day:
                    self._day, self.requests_day = day, 0
                self.requests_total += 1
                self.requests_day += 1
                self.last = (now, len(data), age)
            except OSError as e:
                log.debug("JSON feed: a connection failed: %s", e)
            finally:
                try:
                    conn.close()
                except Exception:                      # noqa: BLE001
                    pass

    def apply(self, enabled: bool) -> None:
        if enabled:
            self.start()
        else:
            self.stop()

    def status(self, conn=None) -> dict:
        _, age = snapshot()
        today = time.strftime("%Y-%m-%d", time.gmtime())
        return {
            "settings": get_settings(conn) if conn is not None else None,
            "running": self.running, "host": "127.0.0.1", "port": self.port,
            "started": self.started, "error": list(self.error) if self.error else None,
            "requests_total": self.requests_total,
            "requests_today": self.requests_day if self._day == today else 0,
            "last": list(self.last) if self.last else None,
            "list_age": age, "stale_sec": STALE_SEC,
        }


_feed: Optional[JsonFeed] = None


def init(cfg, get_db) -> JsonFeed:
    """Create the feed and open it when the saved setting says so (at the start)."""
    global _feed
    _feed = JsonFeed(getattr(cfg, "JSON_FEED_PORT", DEFAULT_PORT) or DEFAULT_PORT)
    try:
        on = get_settings(get_db())["enabled"]
    except Exception:                                  # noqa: BLE001
        on = False
    if on:
        _feed.start()
    return _feed


def get() -> Optional[JsonFeed]:
    return _feed
