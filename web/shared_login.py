"""
web/shared_login.py — ending the shared test login (from 2026-10-25).

The built-in user of config.py (WEB_USER / WEB_PASS) was given to many testers.
Now that every tester can have a personal user (web/users.py), the shared login
is phased out:

  * grace period — the login works; its pages show a chip in the navbar
    ("Shared test login ends in N days") and, once a day per browser (on every
    page load in the last LAST_DAYS days), a notice with the author's contact
    details asking for personal credentials;
  * after the end date — the shared credentials open no data any more: pages
    show the "shared test login has ended" page (HTTP 403) with the same
    contact details and a "log in with my personal account" button, the API
    answers 403.

The end date (the last day the login works, UTC) is set on the Maintenance
page (Web Users) and stored in shared_login.json next to the users file
(webusers.txt), or in config.py as WEB_USER_EXPIRES = "YYYY-MM-DD" (used when
the file has no date).  No date: the login works as before.  The maintenance
user and the personal users are never affected.

Usage of the shared login (page loads per UTC day, last used — no addresses,
no passwords) is counted in memory and written to the same file at most every
10 minutes, for the Maintenance page.
"""

from __future__ import annotations

import calendar
import hmac
import json
import logging
import os
import threading
import time
from typing import Optional

log = logging.getLogger("modes.web")

LAST_DAYS = 3                 # the last days: red chip, notice on every page load
FILE_NAME = "shared_login.json"
WRITE_EVERY = 600.0           # s — usage written at most this often
KEEP_DAYS = 14                # days of usage kept

_lock = threading.Lock()
_st = {"path": None, "mtime": None, "data": {}, "dirty": False, "written": 0.0}


def _path(cfg) -> Optional[str]:
    from web import users as web_users
    up = web_users.users_path(cfg)
    return os.path.join(os.path.dirname(os.path.abspath(up)), FILE_NAME) if up else None


def _load(cfg) -> dict:
    """The settings / usage file (re-read when it changes; lock held)."""
    p = _path(cfg)
    try:
        mt = os.path.getmtime(p) if p else None
    except OSError:
        mt = None
    if p != _st["path"] or (mt != _st["mtime"] and not _st["dirty"]):
        data = {}
        if p and mt is not None:
            try:
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f) or {}
            except (OSError, ValueError) as exc:
                log.warning("Shared login file not read: %s", exc)
        _st.update(path=p, mtime=mt, data=data if isinstance(data, dict) else {})
    return _st["data"]


def _write(cfg) -> None:
    """Write the file (lock held; atomic replace, mode 600)."""
    p = _path(cfg)
    if not p:
        raise OSError("no users file folder: set MAINTENANCE_AUTH_FILE (or WEB_USERS_FILE) in config.py")
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(_st["data"], f, indent=1, sort_keys=True)
    os.chmod(tmp, 0o600)
    os.replace(tmp, p)
    _st.update(mtime=os.path.getmtime(p), dirty=False, written=time.time())


def is_shared(cfg, username: Optional[str]) -> bool:
    if not username:
        return False
    return hmac.compare_digest(str(username).encode(), str(cfg.WEB_USER).encode())


def _expires(cfg, data: dict) -> Optional[str]:
    if "expires" in data:                         # set on the Maintenance page (null = no end)
        return data.get("expires") or None
    v = getattr(cfg, "WEB_USER_EXPIRES", None)
    return str(v) if v else None


def _end_ts(date: str) -> Optional[float]:
    """The moment the login stops: the day after the end date, 00:00 UTC."""
    try:
        return calendar.timegm(time.strptime(date, "%Y-%m-%d")) + 86400.0
    except (TypeError, ValueError):
        return None


def state(cfg, now: Optional[float] = None) -> dict:
    """{"user", "expires" (last day, YYYY-MM-DD) | None, "end_ts", "days_left",
    "phase": "none" | "grace" | "last" | "ended"}."""
    now = time.time() if now is None else now
    with _lock:
        data = _load(cfg)
        exp = _expires(cfg, data)
    end = _end_ts(exp) if exp else None
    if end is None:
        return {"user": str(cfg.WEB_USER), "expires": None, "expires_txt": None, "end_ts": None,
                "days_left": None, "phase": "none"}
    left = end - now
    days = max(1, int(round(left / 86400))) if left > 0 else 0   # whole days (at least 1 while it works)
    phase = "ended" if left <= 0 else "last" if left <= LAST_DAYS * 86400 else "grace"
    t = time.gmtime(end - 86400)
    txt = f"{t.tm_mday} {time.strftime('%B %Y', t)}"            # e.g. "4 November 2026"
    return {"user": str(cfg.WEB_USER), "expires": exp, "expires_txt": txt, "end_ts": end,
            "days_left": days, "phase": phase}


def set_expires(cfg, value: Optional[str]) -> dict:
    """Maintenance page: "YYYY-MM-DD" (last day), "now" (ends at once: the last
    day was yesterday) or None / "" (no end date)."""
    if value == "now":
        value = time.strftime("%Y-%m-%d", time.gmtime(time.time() - 86400))
    elif value:
        if _end_ts(value) is None:
            raise ValueError("the date must be YYYY-MM-DD")
    else:
        value = None
    with _lock:
        _load(cfg)
        _st["data"]["expires"] = value
        _st["data"]["set"] = int(time.time())
        _write(cfg)
    log.info("Shared login end date set: %s", value or "none")
    return state(cfg)


def note_page(cfg, now: Optional[float] = None) -> None:
    """A page load with the shared login (not the API calls)."""
    now = time.time() if now is None else now
    day = time.strftime("%Y-%m-%d", time.gmtime(now))
    with _lock:
        data = _load(cfg)
        use = data.setdefault("use", {})
        use[day] = int(use.get(day, 0)) + 1
        data["last"] = int(now)
        for d in sorted(use)[:-KEEP_DAYS]:
            del use[d]
        _st["dirty"] = True
        if now - _st["written"] >= WRITE_EVERY and _path(cfg):
            try:
                _write(cfg)
            except OSError as exc:
                log.debug("Shared login usage not written: %s", exc)


def flush(cfg) -> None:
    """Write pending usage counts (at shutdown)."""
    with _lock:
        if _st["dirty"] and _path(cfg):
            try:
                _write(cfg)
            except OSError:
                pass


def usage(cfg, now: Optional[float] = None) -> dict:
    """For the Maintenance page: last used, days used and page loads in the
    last 7 days."""
    now = time.time() if now is None else now
    with _lock:
        data = _load(cfg)
        use = dict(data.get("use") or {})
        last = data.get("last")
    days7 = [time.strftime("%Y-%m-%d", time.gmtime(now - k * 86400)) for k in range(7)]
    return {"last": last, "days_7": sum(1 for d in days7 if use.get(d)),
            "pages_7": sum(int(use.get(d, 0)) for d in days7)}
