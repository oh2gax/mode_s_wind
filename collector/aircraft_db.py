"""
collector/aircraft_db.py

Aircraft registration / type lookup from a BaseStation.sqb file (the SQLite
aircraft database used by BaseStation, Virtual Radar Server and the
companion project modes_logger) and, from 2026-11-01, from the reference
data of the daily aircraft database update (data/aircraft_ref.db, written
by collector/regdb_update.py from tar1090-db and plane-alert-db).

The Radarcape JSON feed provides a registration and type for most aircraft,
but not for all.  When an aircraft has no registration or no type from the
JSON feed, the ICAO24 address is looked up:

  1. in BaseStation.sqb (table Aircraft: ModeS → Registration, ICAOTypeCode);
  2. for whatever is still missing, in aircraft_ref.db (table ac).

This matters for the registration blocklist (BLOCKED_REG_PREFIXES, e.g.
Finnish helicopters "OH-H"), which can only filter aircraft whose
registration is known, and fills the registration and type columns of e.g.
Approach History.

Both files are optional:
  • BaseStation.sqb: config key BASESTATION_DB_PATH (optional), default
    data/BaseStation.sqb next to the main database;
  • aircraft_ref.db: next to the main database (data/aircraft_ref.db);
  • a missing file is looked for again every 5 minutes; when a file's
    modification time changes (manual copy, daily update) it is reopened and
    the cache cleared.  reload() does the same at once (after the daily
    update, which writes both files).

Both files are opened read-only here.  Results (including "not found") are
cached in RAM per ICAO; the cache is bounded and cleared when it grows too
large.

classify() (from 2026-11-01) tells military / government / police aircraft
from the reference data (plane-alert-db's #CMPG class, or tar1090-db's
military flag) for the military / government visit log
(collector/special_traffic.py).  Aircraft that tar1090-db marks with a
privacy flag (PIA or LADD) are reported as private and never logged.

status() feeds the "Reg. DB" indicator of the Statistics page's system
health: whether the files are in use, their size in aircraft and date, and
how many lookups found a registration.
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
_n_aircraft: int | None = None     # rows of the Aircraft table when opened
_opened = 0.0                      # wall-clock time the file was (re)opened
_open_err: str | None = None       # why the last open failed
_n_lookups = 0                     # file lookups (cache misses) since the start
_n_found = 0                       # … of which gave a registration
_n_found_ref = 0                   # … of which the registration came from aircraft_ref.db

# reference data of the daily update (data/aircraft_ref.db)
_ref_path: str | None = None
_ref_conn: sqlite3.Connection | None = None
_ref_mtime = 0.0
_ref_last_check = 0.0
_ref_n: int | None = None
_ref_alert_n: int | None = None
_cls_cache: dict[str, dict | None] = {}


def init(path: str | None, ref_path: str | None = None) -> None:
    """Set the BaseStation.sqb path (and the reference-data path); call once
    at startup."""
    global _path, _last_check, _ref_path, _ref_last_check
    with _lock:
        _path = path or None
        _ref_path = ref_path or None
        _last_check = _ref_last_check = 0.0
        _reopen_locked(force=True)
        _reopen_ref_locked(force=True)


def paths() -> tuple[str | None, str | None]:
    """(BaseStation.sqb path, aircraft_ref.db path)."""
    return _path, _ref_path


def reload() -> None:
    """Reopen both files now and clear the caches (after the daily update)."""
    global _last_check, _ref_last_check
    with _lock:
        _close_locked()
        _close_ref_locked()
        _cache.clear()
        _cls_cache.clear()
        _last_check = _ref_last_check = 0.0
        _reopen_locked(force=True)
        _reopen_ref_locked(force=True)


def _close_locked() -> None:
    global _conn
    if _conn is not None:
        try:
            _conn.close()
        except Exception:
            pass
    _conn = None


def _close_ref_locked() -> None:
    global _ref_conn
    if _ref_conn is not None:
        try:
            _ref_conn.close()
        except Exception:
            pass
    _ref_conn = None


def _reopen_locked(force: bool = False) -> None:
    """(Re)open BaseStation.sqb when it appeared or changed (lock held)."""
    global _conn, _mtime, _last_check, _announced_missing, _n_aircraft, _opened, _open_err
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
        _n_aircraft, _opened, _open_err = int(n), time.time(), None
        log.info("BaseStation.sqb: %d aircraft available for registration lookup (%s)", n, _path)
    except Exception as exc:
        log.warning("BaseStation.sqb could not be opened (%s): %s", _path, exc)
        _conn = None
        _open_err = type(exc).__name__


def _reopen_ref_locked(force: bool = False) -> None:
    """(Re)open aircraft_ref.db when it appeared or changed (lock held)."""
    global _ref_conn, _ref_mtime, _ref_last_check, _ref_n, _ref_alert_n
    now = time.monotonic()
    interval = CHECK_FILE_SEC if _ref_conn is not None else RETRY_MISSING_SEC
    if not force and now - _ref_last_check < interval:
        return
    _ref_last_check = now
    if not _ref_path:
        return
    try:
        mtime = os.path.getmtime(_ref_path)
    except OSError:
        _close_ref_locked()
        return
    if _ref_conn is not None and mtime == _ref_mtime:
        return
    _close_ref_locked()
    _cache.clear()
    _cls_cache.clear()
    try:
        uri = Path(_ref_path).resolve().as_uri() + "?mode=ro"
        conn = sqlite3.connect(uri, uri=True, check_same_thread=False, timeout=2.0)
        meta = dict(conn.execute("SELECT key, value FROM meta").fetchall())
        _ref_n = int(meta.get("ac_entries") or 0) or None
        _ref_alert_n = int(meta.get("alert_entries") or 0) or None
        if not _ref_n:                     # no aircraft data yet (first download pending)
            conn.close()
            return
        _ref_conn, _ref_mtime = conn, mtime
    except Exception as exc:
        log.debug("aircraft_ref.db could not be opened (%s): %s", _ref_path, exc)
        _ref_conn = None


def _ref_row_locked(key: str):
    """(reg, type, flags) of tar1090-db for an ICAO, or None (lock held)."""
    if _ref_conn is None:
        return None
    try:
        return _ref_conn.execute("SELECT reg, type, flags FROM ac WHERE icao = ?", (key,)).fetchone()
    except sqlite3.Error:
        return None


def lookup(icao: str) -> tuple[str | None, str | None]:
    """Return (registration, ICAO type code) for an ICAO24 address, or
    (None, None) when unknown or when neither file is available."""
    global _n_lookups, _n_found, _n_found_ref
    if not icao:
        return None, None
    key = icao.upper()
    hit = _cache.get(key)                 # lock-free fast path (dict get is atomic)
    if hit is not None:
        return hit
    with _lock:
        _reopen_locked()
        _reopen_ref_locked()
        if _conn is None and _ref_conn is None:
            return None, None
        hit = _cache.get(key)
        if hit is not None:
            return hit
        reg = typ = None
        if _conn is not None:
            try:
                row = _conn.execute(
                    "SELECT Registration, ICAOTypeCode FROM Aircraft WHERE ModeS = ?", (key,)
                ).fetchone()
            except sqlite3.Error as exc:  # e.g. locked while being written — try again later
                log.debug("BaseStation.sqb lookup failed for %s: %s", key, exc)
                return None, None
            if row:
                reg = (row[0] or "").strip().upper() or None
                typ = (row[1] or "").strip().upper() or None
        from_ref = False
        if (reg is None or typ is None) and _ref_conn is not None:
            r = _ref_row_locked(key)
            if r:
                if reg is None and (r[0] or "").strip():
                    reg, from_ref = r[0].strip().upper(), True
                if typ is None and (r[1] or "").strip():
                    typ = r[1].strip().upper()
        _n_lookups += 1
        if reg:
            _n_found += 1
            if from_ref:
                _n_found_ref += 1
        if len(_cache) >= CACHE_MAX:
            _cache.clear()
        _cache[key] = (reg, typ)
        return reg, typ


def classify(icao: str) -> dict | None:
    """Military / government / police class of an aircraft from the
    reference data, or None for an ordinary (or unknown) aircraft.

    Returns {"cls": "mil"|"gov"|"pol", "src": "pad"|"tar1090", "operator",
    "type", "descr", "reg", "private": bool}.  plane-alert-db (src "pad")
    has priority; its civil entries are not special.  An aircraft with a
    tar1090-db privacy flag (PIA / LADD) is returned with private=True and
    must not be logged."""
    if not icao:
        return None
    key = icao.upper()
    if key in _cls_cache:
        return _cls_cache[key]
    with _lock:
        _reopen_ref_locked()
        if _ref_conn is None:
            return None
        out = None
        try:
            r = _ref_conn.execute("SELECT reg, type, flags, descr FROM ac WHERE icao = ?",
                                  (key,)).fetchone()
            flags = (r[2] or "") if r else ""
            private = len(flags) >= 3 and ("1" in flags[2:4])
            a = None
            try:
                a = _ref_conn.execute(
                    "SELECT reg, operator, type_name, icao_type, cmpg FROM alert WHERE icao = ?",
                    (key,)).fetchone()
            except sqlite3.Error:
                a = None
            cmpg = ((a[4] or "").strip().lower() if a else "")
            if cmpg in ("mil", "gov", "pol"):
                out = {"cls": cmpg, "src": "pad", "operator": a[1] or None,
                       "type": (a[3] or (r[1] if r else None) or None),
                       "descr": a[2] or (r[3] if r else None) or None,
                       "reg": a[0] or (r[0] if r else None) or None, "private": private}
            elif flags[:1] == "1":
                out = {"cls": "mil", "src": "tar1090", "operator": None,
                       "type": (r[1] or None), "descr": r[3] or None,
                       "reg": r[0] or None, "private": private}
            elif private:
                out = {"cls": None, "private": True}
        except sqlite3.Error:
            return None
        if len(_cls_cache) >= CACHE_MAX:
            _cls_cache.clear()
        _cls_cache[key] = out
        return out


def icaos_for_reg(text: str, limit: int = 20) -> list[str]:
    """ICAO24 addresses whose registration contains text (the Flights page
    search, from 2026-10-29); [] without a BaseStation.sqb."""
    text = (text or "").strip().upper()
    if len(text) < 3:
        return []
    with _lock:
        _reopen_locked()
        if _conn is None:
            return []
        try:
            rows = _conn.execute(
                "SELECT ModeS FROM Aircraft WHERE Registration LIKE ? LIMIT ?",
                (f"%{text}%", limit)).fetchall()
        except sqlite3.Error:
            return []
    return [r[0].upper() for r in rows if r[0]]


def status() -> dict:
    """Status for the system health (Statistics page) and diagnostics:
    path, exists (the file is there now), open (in use), aircraft (rows when
    opened), mtime / opened (Unix s), error (why it could not be opened),
    lookups / found since the start (found_ref: registration from the
    reference data), cached; ref_open / ref_aircraft / ref_alert for
    aircraft_ref.db."""
    with _lock:
        _reopen_locked()                  # notices a file added or removed (at most every 1–5 min)
        _reopen_ref_locked()
        exists = bool(_path) and os.path.exists(_path)
        return {"path": _path, "exists": exists, "open": _conn is not None,
                "aircraft": _n_aircraft if _conn is not None else None,
                "mtime": _mtime if _conn is not None else None,
                "opened": _opened if _conn is not None else None,
                "error": _open_err if exists and _conn is None else None,
                "lookups": _n_lookups, "found": _n_found, "found_ref": _n_found_ref,
                "cached": len(_cache),
                "ref_path": _ref_path, "ref_open": _ref_conn is not None,
                "ref_aircraft": _ref_n if _ref_conn is not None else None,
                "ref_alert": _ref_alert_n if _ref_conn is not None else None}
