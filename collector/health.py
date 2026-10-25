"""
health.py — heartbeats of the background parts for the system health
indicators of the Statistics page (from 2026-10-25).

Each background loop records here that it is alive (``beat``) and, when a
round fails, a short plain-language reason (``fail``).  The reasons are
written by the callers in general terms — no exception texts, addresses or
paths; those stay in the log.  RAM only, a dictionary update per round.

The indicators themselves are evaluated on the web side (web/api/health.py),
which also reads the state the modules already keep (message statistics,
sounding and MEPS fetchers, METAR cache, windshear tracker, calibrations).
"""

from __future__ import annotations

import threading
import time
from collections import deque

_lock = threading.Lock()
_rec: dict = {}
STARTED = time.time()
CHANGES: deque = deque(maxlen=50)   # state changes of the indicators, newest first (web/api/health.py)


def beat(name: str, **info) -> None:
    """A successful round of `name` (optional small info values)."""
    now = time.time()
    with _lock:
        r = _rec.setdefault(name, {"n": 0, "err_n": 0})
        r["ts"] = r["ok_ts"] = now
        r["n"] += 1
        if info:
            r.update(info)


def fail(name: str, reason: str, level: str = "error", **info) -> None:
    """A failed round: reason in plain words; level 'warn' (kept / retried)
    or 'error' (lost / not done)."""
    now = time.time()
    with _lock:
        r = _rec.setdefault(name, {"n": 0, "err_n": 0})
        r["ts"] = now
        r["err_ts"] = now
        r["err"] = reason
        r["err_level"] = level
        r["err_n"] += 1
        if info:
            r.update(info)


def mark(name: str, **info) -> None:
    """Record values without counting a round (e.g. 'running since')."""
    with _lock:
        r = _rec.setdefault(name, {"n": 0, "err_n": 0})
        r.update(info)


def get(name: str) -> dict:
    with _lock:
        return dict(_rec.get(name) or {})


def export_changes() -> list:
    """The recent state changes, for the state saved at a clean stop."""
    return [dict(c) for c in CHANGES]


def import_changes(changes: list, stop, now: float) -> None:
    """Restore the state changes saved at the last stop and add the restart."""
    CHANGES.clear()
    for c in changes[:CHANGES.maxlen]:
        CHANGES.append(dict(c))
    if stop:
        down = now - stop
        txt = (f"{down:.0f} s" if down < 90 else f"{down / 60:.0f} min" if down < 5400 else f"{down / 3600:.1f} h")
        CHANGES.appendleft({"ts": now, "key": "server", "label": "Server", "from": "off", "to": "ok",
                            "text": f"Restarted (down {txt})"})
    else:
        CHANGES.appendleft({"ts": now, "key": "server", "label": "Server", "from": "err", "to": "ok",
                            "text": "Started after an unclean stop (the hour in progress was lost)"})
