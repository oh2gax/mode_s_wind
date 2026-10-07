"""
collector/aircraft_db.py

Optional aircraft registration / type lookup from a BaseStation.sqb file
(the SQLite aircraft database used by BaseStation, Virtual Radar Server and
the companion project modes_logger, which keeps it populated).

The Radarcape JSON feed provides a registration and type for most aircraft,
but not for all.  When an aircraft has no registration from the JSON feed,
the ICAO24 address is looked up in BaseStation.sqb (table Aircraft:
ModeS → Registration, ICAOTypeCode).  This matters for the registration
blocklist (BLOCKED_REG_PREFIXES, e.g. Finnish helicopters "OH-H"), which can
only filter aircraft whose registration is known, and fills the registration
and type columns of e.g. Approach History.

The file is optional:
  • path: config key BASESTATION_DB_PATH (optional), default
    data/BaseStation.sqb in the project folder;
  • if the file does not exist, lookups return nothing and everything works
    as before (JSON only); the file is looked for again every 5 minutes, so it
    can be added or replaced while the server runs;
  • when the file's modification time changes (manual update), the cache is
    cleared and the file is reopened.

The file is opened read-only.  Results (including "not found") are cached in
RAM per ICAO; the cache is bounded and cleared when it grows too large.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
import time
from pathlib import Path

log = logging.getLogger("modes.aircraft_db")

CACHE_MAX        = 50_000     # cached ICAO entries before the cache is cleared
CHECK_FILE_SEC   = 60.0       # how often the file's mtime is checked
RETRY_MISSING_SEC = 300.0     # how often a missing file is looked for again

_lock      = threading.Lock()
_path: str | None = None
_conn: sqlite3.Connection | None = None
_mtime     = 0.0
_last_check = 0.0
_cache: dict[str, tuple[str | None, str | None]] = {}
_announced_missing = False


def init(path: str | None) -> None:
    """Set the BaseStation.sqb path (call once at startup)."""
    global _path, _last_check
    with _lock:
        _path = path or None
        _last_check = 0.0
        _reopen_locked(force=True)


def _close_locked() -> None:
    global _conn
    if _conn is not None:
        try:
            _conn.close()
        except Exception:
            pass
    _conn = None


def _reopen_locked(force: bool = False) -> None:
    """(Re)open the file when it appeared or changed (lock held)."""
    global _conn, _mtime, _last_check, _announced_missing
    now = time.monotonic()
    interval = CHECK_FILE_SEC if _conn is not None else RETRY_MISSING_SEC
    if not force and now - _last_check < interval:
        return
    _last_check = now
    if not _path:
        return
    try:
        mtime = os.path.getmtime(_path)
    except OSError:
        if _conn is not None:
            log.warning("BaseStation.sqb no longer found at %s — registrations from JSON only", _path)
        elif not _announced_missing:
            log.info("BaseStation.sqb not found at %s — registrations from JSON only "
                     "(optional file)", _path)
            _announced_missing = True
        _close_locked()
        _cache.clear()
        return
    if _conn is not None and mtime == _mtime:
        return
    _close_locked()
    _cache.clear()
    try:
        uri = Path(_path).resolve().as_uri() + "?mode=ro"
        conn = sqlite3.connect(uri, uri=True, check_same_thread=False, timeout=2.0)
        n = conn.execute("SELECT COUNT(*) FROM Aircraft").fetchone()[0]
        _conn, _mtime = conn, mtime
        _announced_missing = False
        log.info("BaseStation.sqb: %d aircraft available for registration lookup (%s)", n, _path)
    except Exception as exc:
        log.warning("BaseStation.sqb could not be opened (%s): %s", _path, exc)
        _conn = None


def lookup(icao: str) -> tuple[str | None, str | None]:
    """Return (registration, ICAO type code) for an ICAO24 address, or
    (None, None) when unknown or when no BaseStation.sqb is available."""
    if not icao:
        return None, None
    key = icao.upper()
    hit = _cache.get(key)                 # lock-free fast path (dict get is atomic)
    if hit is not None:
        return hit
    with _lock:
        _reopen_locked()
        if _conn is None:
            return None, None
        hit = _cache.get(key)
        if hit is not None:
            return hit
        try:
            row = _conn.execute(
                "SELECT Registration, ICAOTypeCode FROM Aircraft WHERE ModeS = ?", (key,)
            ).fetchone()
        except sqlite3.Error as exc:      # e.g. locked while being replaced — try again later
            log.debug("BaseStation.sqb lookup failed for %s: %s", key, exc)
            return None, None
        reg = typ = None
        if row:
            reg = (row[0] or "").strip().upper() or None
            typ = (row[1] or "").strip().upper() or None
        if len(_cache) >= CACHE_MAX:
            _cache.clear()
        _cache[key] = (reg, typ)
        return reg, typ


def status() -> dict:
    """Small status dict for logging / diagnostics."""
    with _lock:
        return {"path": _path, "open": _conn is not None, "cached": len(_cache)}
