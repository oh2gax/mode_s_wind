"""
access_log.py — compact access and misuse log of the web server
(logs/access.log, from 2026-10-21).

The open pages poll the server every few seconds, so a line per request
(the werkzeug access log, LOG_HTTP_ACCESS = True) is mostly noise.  This log
writes instead:

  LOGIN    a successful login from an address (first request of a session;
           "new address" when the address has never logged in before)
  SESSION  the end of that session (no requests for ACCESS_SESSION_IDLE_MIN):
           duration, number of requests, pages opened
  DENIED   a request without credentials (scanners, link checkers).  The
           browser's own first request before the login dialog is not listed
           when the same address logs in within CHALLENGE_GRACE_SEC.
  BADPASS  a wrong user name or password (the user name tried is shown, the
           password never)
  BLOCKED  ACCESS_LOCKOUT_FAILS wrong passwords within LOCKOUT_WINDOW_SEC:
           the address gets HTTP 429 for ACCESS_LOCKOUT_MIN minutes (not for
           addresses of the local network); also written to the main log
  PROBE    a request that is not HTTP at all, classified: TLS handshake
           (https:// to the plain-HTTP port), SOCKS4 / SOCKS5 open-proxy test,
           Remote Desktop (RDP) probe, SSH, other malformed request
  ACTION   a successful changing request (maintenance purge / delete /
           settings, Approach History clear)
  MAINT-PW a wrong maintenance password
  ERROR    a server error (HTTP 5xx)
  DAILY    a summary of the day (local midnight)
  START    the web server started

At most ACCESS_LOG_PER_IP_HOUR lines per address and kind per clock hour;
the rest are counted and summarised in one line at the end of the hour, so a
path scanner with hundreds of requests costs a few lines.

The addresses that have logged in are kept in logs/access_known.json
(written only when a session starts).
"""

from __future__ import annotations

import atexit
import ipaddress
import json
import logging
import os
import re
import threading
import time
from logging.handlers import RotatingFileHandler

from werkzeug.serving import WSGIRequestHandler

log = logging.getLogger("modes.access")       # → logs/access.log only
main_log = logging.getLogger("modes.web")

CHALLENGE_GRACE_SEC = 30.0
LOCKOUT_WINDOW_SEC = 600.0
SWEEP_SEC = 10.0
_READ_ONLY_POST = re.compile(r"/(stats|preview|date-preview|list)$")
_STATIC = ("/static/", "/api/", "/favicon.ico")


def _clean(s, n: int = 120) -> str:
    """Printable, length-limited form of an untrusted string."""
    if s is None:
        return ""
    if isinstance(s, bytes):
        s = s.decode("latin-1")
    out = []
    for ch in s[:n]:
        o = ord(ch)
        out.append(ch if 32 <= o < 127 or 160 <= o < 0x2000 else f"\\x{o & 0xff:02x}")
    return "".join(out) + ("…" if len(s) > n else "")


def _is_local(ip: str) -> bool:
    try:
        a = ipaddress.ip_address(ip)
        return a.is_private or a.is_loopback or a.is_link_local
    except ValueError:
        return False


def classify_probe(raw: bytes) -> str:
    """What a non-HTTP first line most likely is."""
    raw = raw or b""
    if raw[:2] == b"\x16\x03":
        return "TLS handshake (https:// to the plain-HTTP port)"
    if raw[:1] == b"\x04" and len(raw) >= 8 and raw[1] in (1, 2):
        port = int.from_bytes(raw[2:4], "big")
        ip = ".".join(str(b) for b in raw[4:8])
        return f"SOCKS4 proxy test (connect to {ip}:{port})"
    if raw[:1] == b"\x05" and len(raw) >= 2:
        return "SOCKS5 proxy test"
    if raw[:3] == b"\x03\x00\x00":
        m = re.search(rb"mstshash=([\x21-\x7e]{1,32})", raw)
        return "Remote Desktop (RDP) probe" + (f", user {_clean(m.group(1), 32)}" if m else "")
    if raw[:4] == b"SSH-":
        return "SSH client"
    if raw[:24] == b"PRI * HTTP/2.0\r\n":
        return "HTTP/2 without TLS"
    return f"malformed request ({_clean(raw.rstrip(), 40)!s})"


class AccessTracker:
    def __init__(self, cfg, log_dir: str):
        self.enabled = bool(getattr(cfg, "ACCESS_LOG", True))
        self.idle = float(getattr(cfg, "ACCESS_SESSION_IDLE_MIN", 30)) * 60
        self.per_hour = int(getattr(cfg, "ACCESS_LOG_PER_IP_HOUR", 20))
        self.lock_fails = int(getattr(cfg, "ACCESS_LOCKOUT_FAILS", 10))
        self.lock_sec = float(getattr(cfg, "ACCESS_LOCKOUT_MIN", 15)) * 60
        self.full_http = bool(getattr(cfg, "LOG_HTTP_ACCESS", False))
        self.known_path = os.path.join(log_dir, "access_known.json")
        self._lock = threading.RLock()
        self._sessions: dict = {}     # (ip, user) → dict
        self._pending: dict = {}      # ip → [(ts, line)] no-credential denials held back
        self._caps: dict = {}         # (ip, kind) → [logged, suppressed, samples]
        self._fails: dict = {}        # ip → [ts …] wrong passwords
        self._blocked: dict = {}      # ip → until ts
        self._hour = int(time.time() // 3600)
        self._day = time.strftime("%Y-%m-%d")
        self._stats = self._new_stats()
        try:
            with open(self.known_path) as f:
                self._known = json.load(f)
        except Exception:
            self._known = {}
        self._thread = None

    @staticmethod
    def _new_stats():
        return {"sessions": 0, "login_ips": set(), "denied": 0, "denied_ips": set(),
                "badpass": 0, "blocked": 0, "probes": 0, "probe_ips": set(), "actions": 0}

    # ── output helpers ──────────────────────────────────────────────────────
    def _emit(self, ip: str, kind: str, text: str, sample: str = "") -> None:
        """Write one line, at most per_hour per (address, kind) and hour."""
        c = self._caps.setdefault((ip, kind), [0, 0, []])
        if self.per_hour and c[0] >= self.per_hour:
            c[1] += 1
            if sample and len(c[2]) < 5 and sample not in c[2]:
                c[2].append(sample)
            return
        c[0] += 1
        log.info("%-8s %-15s %s", kind, ip, text)

    def _flush_caps(self) -> None:
        for (ip, kind), (_, sup, samples) in sorted(self._caps.items()):
            if sup:
                eg = f" (e.g. {', '.join(samples)})" if samples else ""
                log.info("%-8s %-15s … %d more in the last hour not listed%s", kind, ip, sup, eg)
        self._caps.clear()

    # ── Flask hooks ─────────────────────────────────────────────────────────
    def is_blocked(self, ip: str) -> bool:
        if not self.enabled:
            return False
        with self._lock:
            until = self._blocked.get(ip)
            if until is None:
                return False
            if time.time() >= until:
                del self._blocked[ip]
                return False
            return True

    def record(self, ip: str, method: str, path: str, status: int,
               auth: str, user, ua: str) -> None:
        """One finished request.  auth: ok / none / bad / blocked."""
        if not self.enabled:
            return
        now = time.time()
        req = f"{method} {_clean(path, 80)}"
        with self._lock:
            st = self._stats
            if auth == "blocked":
                self._emit(ip, "BLOCKED", f"{req} refused (blocked)", _clean(path, 40))
                return
            if auth == "none":
                st["denied"] += 1
                st["denied_ips"].add(ip)
                p = self._pending.setdefault(ip, [])
                if len(p) < self.per_hour + 1:
                    p.append((now, req, ua, _clean(path, 40)))
                else:                                                 # counted only
                    c = self._caps.setdefault((ip, "DENIED"), [0, 0, []])
                    c[1] += 1
                    sample = _clean(path, 40)
                    if len(c[2]) < 5 and sample not in c[2]:
                        c[2].append(sample)
                return
            if auth == "bad":
                st["badpass"] += 1
                self._emit(ip, "BADPASS", f'{req}  user "{_clean(user, 32)}"  ua "{ua}"', _clean(path, 40))
                self._fail(ip, now)
                return
            # authenticated
            self._pending.pop(ip, None)      # the browser's login challenge — not listed
            key = (ip, user or "")
            s = self._sessions.get(key)
            if s is None:
                new = ip not in self._known
                s = self._sessions[key] = {"t0": now, "t1": now, "n": 0, "pages": [], "ua": ua}
                st["sessions"] += 1
                st["login_ips"].add(ip)
                tag = (" LAN" if _is_local(ip) else "") + ("  new address" if new else "")
                log.info("%-8s %-15s user %s  %s  ua \"%s\"%s", "LOGIN", ip, _clean(user, 32), req, ua, tag)
                if new and not _is_local(ip):
                    main_log.warning("Web login from a new address %s (user %s)", ip, _clean(user, 32))
                self._remember(ip, now)
            s["t1"] = now
            s["n"] += 1
            if status < 400 and not path.startswith(_STATIC) and path not in s["pages"] \
                    and len(s["pages"]) < 12:
                s["pages"].append(_clean(path, 40))
            if path.startswith("/api/maintenance/") and status == 401:
                st["badpass"] += 1
                self._emit(ip, "MAINT-PW", req, _clean(path, 40))
                self._fail(ip, now)
            elif method in ("POST", "PUT", "DELETE", "PATCH") and status < 400 \
                    and not _READ_ONLY_POST.search(path):
                st["actions"] += 1
                log.info("%-8s %-15s user %s  %s → %d", "ACTION", ip, _clean(user, 32), req, status)
            elif status >= 500:
                self._emit(ip, "ERROR", f"{req} → {status}", _clean(path, 40))

    def probe(self, ip: str, code, message: str, raw: bytes) -> None:
        """A request the HTTP parser refused (called from the request handler)."""
        if not self.enabled:
            return
        with self._lock:
            self._stats["probes"] += 1
            self._stats["probe_ips"].add(ip)
            what = classify_probe(raw)
            self._emit(ip, "PROBE", f"{what}  → {code}", what.split(" (")[0])

    # ── internals ───────────────────────────────────────────────────────────
    def _fail(self, ip: str, now: float) -> None:
        f = [t for t in self._fails.get(ip, []) if now - t < LOCKOUT_WINDOW_SEC] + [now]
        self._fails[ip] = f
        if self.lock_fails > 0 and len(f) >= self.lock_fails and not _is_local(ip) \
                and ip not in self._blocked:
            self._blocked[ip] = now + self.lock_sec
            self._fails[ip] = []
            self._stats["blocked"] += 1
            mins = round(self.lock_sec / 60)
            log.info("%-8s %-15s %d wrong passwords in %d min — blocked for %d min",
                     "BLOCKED", ip, len(f), round(LOCKOUT_WINDOW_SEC / 60), mins)
            main_log.warning("Web: %s blocked for %d min after %d wrong passwords (see logs/access.log)",
                             ip, mins, len(f))

    def _remember(self, ip: str, now: float) -> None:
        day = time.strftime("%Y-%m-%d", time.localtime(now))
        k = self._known.get(ip)
        if k and k.get("last") == day:
            return
        self._known[ip] = {"first": (k or {}).get("first", day), "last": day}
        try:
            tmp = self.known_path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(self._known, f, indent=0, sort_keys=True)
            os.replace(tmp, self.known_path)
        except Exception as exc:
            main_log.debug("access_known.json not written: %s", exc)

    def _end_session(self, key, s) -> None:
        ip, user = key
        dur = s["t1"] - s["t0"]
        h, m = divmod(int(dur // 60), 60)
        span = f"{time.strftime('%H:%M', time.localtime(s['t0']))}–{time.strftime('%H:%M', time.localtime(s['t1']))}"
        log.info("%-8s %-15s user %s  %s (%s)  %d requests  pages %s", "SESSION", ip, _clean(user, 32),
                 span, f"{h} h {m} min" if h else f"{m} min", s["n"], ", ".join(s["pages"]) or "–")

    def sweep(self, final: bool = False) -> None:
        if not self.enabled:
            return
        now = time.time()
        with self._lock:
            for ip, items in list(self._pending.items()):
                if final or now - items[0][0] >= CHALLENGE_GRACE_SEC:
                    for _, req, ua, sample in items:
                        self._emit(ip, "DENIED", f"{req}  no credentials  ua \"{ua}\"", sample)
                    del self._pending[ip]
            for key, s in list(self._sessions.items()):
                if final or now - s["t1"] >= self.idle:
                    self._end_session(key, s)
                    del self._sessions[key]
            hour = int(now // 3600)
            if hour != self._hour or final:
                self._flush_caps()
                self._hour = hour
                self._fails = {ip: f for ip, f in self._fails.items()
                               if f and now - f[-1] < LOCKOUT_WINDOW_SEC}
            day = time.strftime("%Y-%m-%d", time.localtime(now))
            if day != self._day:
                self._daily(self._day)
                self._day = day
                self._stats = self._new_stats()

    def _daily(self, day: str) -> None:
        s = self._stats
        ips = ", ".join(sorted(s["login_ips"])) or "–"
        log.info("%-8s %s  logins %d (%s)  denied %d from %d addresses  wrong passwords %d  "
                 "blocked %d  probes %d from %d addresses  actions %d",
                 "DAILY", day, s["sessions"], ips, s["denied"], len(s["denied_ips"]),
                 s["badpass"], s["blocked"], s["probes"], len(s["probe_ips"]), s["actions"])

    def start(self) -> None:
        if not self.enabled or self._thread is not None:
            return

        def _loop():
            while True:
                time.sleep(SWEEP_SEC)
                try:
                    self.sweep()
                except Exception as exc:          # never let the log stop the server
                    main_log.warning("access log sweep failed: %s", exc)

        self._thread = threading.Thread(target=_loop, name="access-log", daemon=True)
        self._thread.start()
        atexit.register(lambda: self.sweep(final=True))
        log.info("%-8s %-15s access logging on (sessions end after %d min idle, %d lines per address "
                 "and kind per hour, lockout %s)", "START", "-", round(self.idle / 60), self.per_hour,
                 f"after {self.lock_fails} wrong passwords for {round(self.lock_sec / 60)} min"
                 if self.lock_fails > 0 else "off")


tracker: AccessTracker | None = None


def setup(cfg, log_dir: str) -> AccessTracker:
    """Create the tracker and the logs/access.log handler (called by run.py)."""
    global tracker
    tracker = AccessTracker(cfg, log_dir)
    if tracker.enabled:
        fh = RotatingFileHandler(os.path.join(log_dir, "access.log"),
                                 maxBytes=int(float(getattr(cfg, "ACCESS_LOG_MAX_MB", 1)) * 1024 * 1024),
                                 backupCount=int(getattr(cfg, "ACCESS_LOG_BACKUPS", 5)))
        fh.setFormatter(logging.Formatter("%(asctime)s  %(message)s", "%Y-%m-%d %H:%M:%S"))
        log.addHandler(fh)
        log.setLevel(logging.INFO)
        log.propagate = False
    return tracker


class _DisconnectFilter(logging.Filter):
    """werkzeug's "Error on request" traceback for a client that went away
    (mobile network change, closed laptop) → one line."""
    _pat = re.compile(r"(BrokenPipeError|ConnectionResetError|ConnectionAbortedError|TimeoutError|"
                      r"OSError: \[Errno (32|104|110|113)\][^\n]*)")

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:
            return True
        if msg.startswith("Error on request"):
            m = self._pat.search(msg)
            if m:
                record.msg, record.args = "Client connection lost during a response (%s)", (m.group(0).strip(),)
                record.levelno, record.levelname = logging.INFO, "INFO"
        return True


def quiet_werkzeug(full_access: bool) -> None:
    wz = logging.getLogger("werkzeug")
    wz.addFilter(_DisconnectFilter())
    if not full_access:
        wz.setLevel(logging.WARNING)


class RequestHandler(WSGIRequestHandler):
    """werkzeug request handler: requests the HTTP parser refuses go to the
    access log as PROBE lines instead of an ERROR line in the main log; the
    per-request access line only with LOG_HTTP_ACCESS = True."""

    def log_request(self, code="-", size="-"):
        if tracker is None or tracker.full_http:
            super().log_request(code, size)

    def log_error(self, format, *args):
        if tracker is not None and tracker.enabled and format.startswith("code %d") and args:
            try:
                tracker.probe(self.client_address[0] if self.client_address else "?",
                              args[0], str(args[1]) if len(args) > 1 else "",
                              getattr(self, "raw_requestline", b"") or b"")
                return
            except Exception:
                pass
        super().log_error(format, *args)


def init_app(app) -> None:
    """Register the after-request hook (called by create_app)."""
    from flask import g, request

    @app.after_request
    def _access_after(resp):
        if tracker is not None and tracker.enabled:
            try:
                tracker.record(request.remote_addr or "?", request.method, request.full_path.rstrip("?"),
                               resp.status_code, g.get("auth_state", "ok"), g.get("auth_user"),
                               _clean(request.headers.get("User-Agent", ""), 120))
            except Exception as exc:
                main_log.debug("access log record failed: %s", exc)
        return resp

    if tracker is not None:
        tracker.start()
