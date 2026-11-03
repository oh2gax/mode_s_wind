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

Which list (from the evening of 2026-11-03; json_feed_src, Maintenance page):
 • 'main' (the default): the main receiver's Radarcape aircraftlist.json as
   received, as before — e.g. only MODES-RX-01, whose landings at EFHK a
   logger has been tuned for;
 • 'all': all receivers merged — built from MODE-S Wind's own aircraft state
   (every receiver's replies decoded once, plus the Radarcape list's MLAT
   positions), in the Radarcape list's field names (hex, fli, lat, lon, alt,
   spd, trk, vrt, squ, reg, typ, uti, alts); the aircraft heard within 60 s, on
   top of the main receiver's raw entry of each when it has one; from the
   evening of 2026-11-03 also the main receiver's raw entries of the aircraft
   MODE-S Wind leaves out (BLOCKED_ICAO / _REG_PREFIXES), as they came — those
   heard only by another receiver stay out;
 • another receiver's id: that receiver's own list — a readsb receiver's
   aircraft.json (its status_url, e.g. through its tunnel) or a json_url in its
   EXTRA_RECEIVERS entry (a Radarcape's aircraftlist.json), polled every 2 s
   only while the feed is on and that list is chosen; readsb's fields are
   turned into the Radarcape names.
"""

from __future__ import annotations

import json
import logging
import socket
import threading
import time
from typing import Optional

log = logging.getLogger("modes.json_feed")

DEFAULT_PORT = 31009
STALE_SEC = 10.0
_KEY = "json_feed_enabled"
_KEY_SRC = "json_feed_src"
POLL_SEC = 2.0
MERGED_AGE_SEC = 60.0

_snap_lock = threading.Lock()
_raw: bytes = b""
_raw_ts: float = 0.0


def set_snapshot(raw: bytes, ts: Optional[float] = None) -> None:
    """The newest aircraft list as received (called by the JSON poller)."""
    global _raw, _raw_ts
    with _snap_lock:
        _raw = raw
        _raw_ts = ts or time.time()


_src = {"mode": "main"}                 # which list: 'main' | 'all' | a receiver id
_live = {"state": None, "lock": None}  # MODE-S Wind's aircraft state (the merged list)
_merged = {"t": 0.0, "raw": b"[]", "n": 0}
_other = {"id": None, "raw": b"", "ts": 0.0, "err": None, "n": 0, "run": 0}


def bind_live(state: dict, lock) -> None:
    """The collector's live_state and its lock (run.py), for the merged list."""
    _live["state"], _live["lock"] = state, lock


def _num(v, nd=None):
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return round(f, nd) if nd else int(round(f))


def _merged_list(now: float):
    """All receivers merged, in the Radarcape list's field names: every aircraft of
    MODE-S Wind's live_state heard within MERGED_AGE_SEC, on top of the main
    receiver's raw Radarcape entry of the same aircraft when it has one (so its own
    fields — the MLAT flag, operator, country … — stay), plus (from the evening of
    2026-11-03) the raw entries of the aircraft that live_state does not have — those
    MODE-S Wind leaves out on purpose (BLOCKED_ICAO / _REG_PREFIXES: e.g. the WAM
    ground stations, OH-H helicopters) or has not decoded yet — as they came.  The
    selected altitude (alts, ft) comes from live_state when heard within 2 min."""
    if now - _merged["t"] < 1.0:
        return _merged["raw"], 0.0
    st, lk = _live["state"], _live["lock"]
    if st is None or lk is None:
        return b"[]", None
    rawmap = {}
    with _snap_lock:
        raw, rts = _raw, _raw_ts
    if raw and rts and now - rts <= STALE_SEC:
        try:
            for e in json.loads(raw):
                if isinstance(e, dict) and e.get("hex"):
                    rawmap[str(e["hex"]).upper()] = e
        except ValueError:
            rawmap = {}
    out = []
    with lk:
        items = list(st.items())
    for icao, a in items:
        try:
            seen = float(a.get("last_seen") or 0)
        except (TypeError, ValueError):
            continue
        if not seen or now - seen > MERGED_AGE_SEC or not isinstance(icao, str) or len(icao) != 6:
            continue
        hx = icao.upper()
        e = dict(rawmap.pop(hx, None) or {})
        sel = a.get("sel_alt")
        try:
            sel_ok = sel is not None and now - float(a.get("sel_alt_ts") or 0) <= 120
        except (TypeError, ValueError):
            sel_ok = False
        mine = {"fli": a.get("callsign") or None,
                "lat": _num(a.get("lat"), 5), "lon": _num(a.get("lon"), 5), "alt": _num(a.get("altitude")),
                "spd": _num(a.get("groundspeed")), "trk": _num(a.get("track")), "vrt": _num(a.get("vert_rate")),
                "squ": a.get("squawk") or None, "reg": a.get("registration") or None,
                "typ": a.get("aircraft_type") or None, "alts": _num(sel) if sel_ok else None}
        for k, v in mine.items():                      # MODE-S Wind's value wins where it has one
            if v is not None:
                e[k] = v
            elif k not in e and k != "alts":
                e[k] = None
        try:
            e["uti"] = max(int(seen), int(e.get("uti") or 0))
        except (TypeError, ValueError):
            e["uti"] = int(seen)
        e["hex"] = hx
        out.append(e)
    out.extend(rawmap.values())                          # the main receiver's others, as they came
    raw_out = json.dumps(out, separators=(",", ":")).encode()
    _merged.update(t=now, raw=raw_out, n=len(out))
    return raw_out, 0.0


def _from_readsb(d: dict, now: float) -> list:
    """readsb / tar1090 aircraft.json → the Radarcape list's field names."""
    base = d.get("now") or now
    out = []
    for a in d.get("aircraft") or []:
        hx = str(a.get("hex") or "")
        if len(hx) != 6 or hx.startswith("~"):
            continue
        alt = a.get("alt_baro")
        out.append({"uti": int(base - float(a.get("seen") or 0)), "hex": hx.upper(),
                    "fli": (str(a.get("flight") or "").strip() or None),
                    "lat": a.get("lat"), "lon": a.get("lon"), "alt": 0 if alt == "ground" else _num(alt),
                    "spd": _num(a.get("gs")), "trk": _num(a.get("track")), "vrt": _num(a.get("baro_rate")),
                    "squ": a.get("squawk") or None, "reg": a.get("r") or None, "typ": a.get("t") or None})
    return out


def _poll_other(rx_id: str, url: str, kind: str, run: int) -> None:
    """Another receiver's own list, every POLL_SEC while it is chosen and the feed is on."""
    import urllib.request
    while _other["run"] == run and _src["mode"] == rx_id and _feed is not None and _feed.running:
        try:
            with urllib.request.urlopen(url, timeout=4.0) as r:
                body = r.read()
            now = time.time()
            if kind == "readsb":
                lst = _from_readsb(json.loads(body), now)
                raw = json.dumps(lst, separators=(",", ":")).encode()
            else:
                lst = json.loads(body)
                if not isinstance(lst, list):
                    raise ValueError("not a list")
                raw = body
            _other.update(raw=raw, ts=now, err=None, n=len(lst))
        except Exception as e:                         # noqa: BLE001
            _other["err"] = f"{e.__class__.__name__}: {str(e)[:80]}"
        time.sleep(POLL_SEC)


def sources() -> list:
    """The lists that can be chosen: [{id, name, kind}] — 'main', 'all' and other receivers with a list."""
    out = [{"id": "main", "name": "", "kind": "radarcape"}]
    try:
        from collector import multirx
        out[0]["name"] = multirx.main_id()
        xs = multirx.extras()
        if xs:
            out.append({"id": "all", "name": "All receivers (merged)", "kind": "merged"})
        for r in xs:
            url, kind = _url_of(r)
            if url:
                out.append({"id": r.id, "name": r.name, "kind": kind})
    except Exception:                                  # noqa: BLE001
        pass
    return out


def _url_of(r):
    spec_url = getattr(r, "json_url", None)
    if spec_url:
        return spec_url, ("readsb" if spec_url.endswith("aircraft.json") else "radarcape")
    if getattr(r, "status_url", None):
        return r.status_url + "aircraft.json", "readsb"
    return None, None


def set_source(mode: str) -> None:
    mode = mode or "main"
    _src["mode"] = mode
    if mode in ("main", "all"):
        _other["run"] += 1
        return
    if _other["id"] != mode:
        _other.update(id=mode, raw=b"", ts=0.0, err=None, n=0)
    _other["run"] += 1
    run = _other["run"]
    try:
        from collector import multirx
        r = multirx.get(mode)
    except Exception:                                  # noqa: BLE001
        r = None
    url, kind = _url_of(r) if r is not None else (None, None)
    if not url:
        _other["err"] = "this receiver has no aircraft list"
        return
    if _feed is not None and _feed.running:
        threading.Thread(target=_poll_other, args=(mode, url, kind, run), name="json_feed_rx", daemon=True).start()


def snapshot(now: Optional[float] = None):
    """(bytes to send, age in s or None): the chosen list, or b'[]' when none or stale."""
    now = now or time.time()
    mode = _src["mode"]
    if mode == "all":
        return _merged_list(now)
    if mode != "main":
        raw, ts = _other["raw"], _other["ts"]
    else:
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
    try:
        s = conn.execute("SELECT value FROM maintenance_config WHERE key = ?", (_KEY_SRC,)).fetchone()
    except Exception:                                  # noqa: BLE001
        s = None
    return {"enabled": (r[0] if r else "0") == "1",           # off by default
            "src": (s[0] if s and s[0] else "main")}          # the main receiver's list by default


def set_settings(conn, enabled=None, src=None) -> dict:
    if enabled is not None or src is not None:
        conn.execute("CREATE TABLE IF NOT EXISTS maintenance_config (key TEXT PRIMARY KEY, value TEXT)")
        if enabled is not None:
            conn.execute("INSERT OR REPLACE INTO maintenance_config (key, value) VALUES (?, ?)",
                         (_KEY, "1" if enabled else "0"))
        if src is not None:
            conn.execute("INSERT OR REPLACE INTO maintenance_config (key, value) VALUES (?, ?)",
                         (_KEY_SRC, str(src)[:40] or "main"))
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
                s.shutdown(socket.SHUT_RDWR)          # wakes the accept() at once: the port is closed now
            except OSError:
                pass
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

    def apply(self, enabled: bool, src: Optional[str] = None) -> None:
        if enabled:
            self.start()
        else:
            self.stop()
        set_source(src if src is not None else _src["mode"])

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
            "src": _src["mode"], "sources": sources(),
            "list_n": (_merged["n"] if _src["mode"] == "all" else _other["n"] if _src["mode"] != "main" else None),
            "list_err": _other["err"] if _src["mode"] not in ("main", "all") else None,
        }


_feed: Optional[JsonFeed] = None


def init(cfg, get_db) -> JsonFeed:
    """Create the feed and open it when the saved setting says so (at the start)."""
    global _feed
    _feed = JsonFeed(getattr(cfg, "JSON_FEED_PORT", DEFAULT_PORT) or DEFAULT_PORT)
    try:
        s = get_settings(get_db())
    except Exception:                                  # noqa: BLE001
        s = {"enabled": False, "src": "main"}
    _feed.apply(s["enabled"], s.get("src", "main"))
    return _feed


def get() -> Optional[JsonFeed]:
    return _feed
