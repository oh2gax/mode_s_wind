"""
database/archive.py — monthly archive files for purged data (from 2026-10-11)

Keeps the running database small (e.g. the last 30 days of observations)
while every observation stays available for later analysis.

Archive before purge
--------------------
When enabled on the Maintenance page (maintenance_config key
``archive_enabled``), every purge of flight & meteo data — the daily
autopurge as well as the manual "older than N days" and date-range purges —
first copies the rows it is about to delete into a per-month archive file:

    <ARCHIVE_DIR>/modes_meteo_archive_YYYY-MM.db      (UTC month of the row)

``ARCHIVE_DIR`` is an optional config key; default ``archive/`` next to the
database (data/archive/).  Copied are:
  • observations (all columns, same ids) and the flights they belong to;
  • approach_series and departure_profiles rows before their own retention
    purge (APPROACH_SERIES_DAYS / DEPARTURE_PROFILE_DAYS).
Tables that are never auto-purged (approach_history, GPS quality, episodes,
profile_hours, heading_cal) stay in the running database.

The copy works day by day (ATTACH + INSERT OR IGNORE … SELECT with the same
ids, so a repeated run never duplicates rows), commits the archive, then
checks that every row of that day exists in the archive.  Only then may the
caller delete.  If anything fails (disk full, I/O error) an ArchiveError is
raised and the purge is skipped — nothing is deleted that was not archived.
The last error is kept in maintenance_config (``archive_last_error``) and
shown on the Maintenance page.  New columns added to the running database
later (e.g. hdg_off) are added to an existing archive file automatically.

Every observation is in exactly one place: the running database or one
monthly file.  A flight crossing a month boundary appears in both months'
files (same id).  tools/archive_query.py combines the archive files and the
running database for analysis.

Snapshot
--------
create_snapshot() writes a compact copy of the whole running database
(VACUUM INTO) as ``modes_meteo_snapshot_YYYYMMDD_HHMM.db`` in the same folder,
e.g. for an analysis copy; it runs in a background thread.
"""

from __future__ import annotations

import datetime
import glob
import logging
import os
import re
import shutil
import sqlite3
import threading
import time

log = logging.getLogger("modes.archive")

ARCHIVE_PREFIX   = "modes_meteo_archive_"
SNAPSHOT_PREFIX  = "modes_meteo_snapshot_"
FREE_MARGIN_MB   = 200          # keep at least this much free after archiving
BYTES_PER_ROW    = 260          # observations row in an archive file incl. ts index (measured ~220)
DAY = 86_400.0

# Tables that can be archived: (table, ts column)
ARCHIVABLE = {
    "observations":       "ts",
    "approach_series":    "ts",
    "departure_profiles": "ts",
    "height_series":      "ts",
}


class ArchiveError(RuntimeError):
    pass


# ── Settings ─────────────────────────────────────────────────────────────────

def _main_db_path(conn) -> str:
    for row in conn.execute("PRAGMA database_list"):
        if row[1] == "main":
            return row[2]
    return ""


def archive_dir(conn) -> str:
    """ARCHIVE_DIR from config.py (optional), else archive/ next to the DB."""
    d = None
    try:
        from config import Config
        d = getattr(Config, "ARCHIVE_DIR", None)
    except Exception:
        pass
    if not d:
        d = os.path.join(os.path.dirname(os.path.abspath(_main_db_path(conn) or ".")), "archive")
    return os.path.abspath(d)


def is_enabled(conn) -> bool:
    row = conn.execute("SELECT value FROM maintenance_config WHERE key = 'archive_enabled'").fetchone()
    return bool(row and row[0] == "1")


def set_enabled(conn, enabled: bool) -> None:
    conn.execute("INSERT OR REPLACE INTO maintenance_config (key, value) VALUES ('archive_enabled', ?)",
                 ("1" if enabled else "0",))
    conn.commit()


def _set_meta(conn, key: str, value: str | None) -> None:
    try:
        if value is None:
            conn.execute("DELETE FROM maintenance_config WHERE key = ?", (key,))
        else:
            conn.execute("INSERT OR REPLACE INTO maintenance_config (key, value) VALUES (?, ?)", (key, value))
        conn.commit()
    except sqlite3.Error:
        pass


def get_status(conn) -> dict:
    cfg = {r[0]: r[1] for r in conn.execute(
        "SELECT key, value FROM maintenance_config WHERE key LIKE 'archive_%'")}
    d = archive_dir(conn)
    try:
        free_mb = round(shutil.disk_usage(d if os.path.isdir(d) else os.path.dirname(d)).free / 1e6)
    except OSError:
        free_mb = None
    return {
        "enabled":    cfg.get("archive_enabled") == "1",
        "dir":        d,
        "free_mb":    free_mb,
        "last_run":   cfg.get("archive_last_run"),
        "last_rows":  cfg.get("archive_last_rows"),
        "last_error": cfg.get("archive_last_error"),
        "snapshot":   dict(_snapshot_state),
    }


# ── Archiving ────────────────────────────────────────────────────────────────

def _month_path(d: str, ts: float) -> str:
    t = datetime.datetime.fromtimestamp(ts, datetime.timezone.utc)
    return os.path.join(d, f"{ARCHIVE_PREFIX}{t.year:04d}-{t.month:02d}.db")


def _columns(conn, schema: str, table: str) -> list[tuple[str, str]]:
    return [(r[1], r[2]) for r in conn.execute(f"PRAGMA {schema}.table_info({table})")]


def _ensure_table(conn, table: str) -> list[str]:
    """Create `table` in the attached archive (same definition as in the
    running DB) or add the columns it lacks.  Returns the column list."""
    main_cols = _columns(conn, "main", table)
    if not main_cols:
        raise ArchiveError(f"table {table} missing in the database")
    arc_cols = _columns(conn, "arc", table)
    if not arc_cols:
        sql = conn.execute("SELECT sql FROM main.sqlite_master WHERE type='table' AND name=?",
                           (table,)).fetchone()[0]
        sql = re.sub(r"^\s*CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?\"?" + table + r"\"?",
                     f"CREATE TABLE IF NOT EXISTS arc.{table}", sql, count=1, flags=re.I)
        conn.execute(sql)
        ts_col = ARCHIVABLE.get(table)
        if ts_col:
            conn.execute(f"CREATE INDEX IF NOT EXISTS arc.idx_{table}_ts ON {table}({ts_col})")
        if table == "flights":
            conn.execute("CREATE INDEX IF NOT EXISTS arc.idx_flights_icao ON flights(icao)")
    else:
        have = {c for c, _ in arc_cols}
        for c, typ in main_cols:
            if c not in have:
                conn.execute(f"ALTER TABLE arc.{table} ADD COLUMN {c} {typ or ''}")
    return [c for c, _ in main_cols]


def _attach(conn, path: str) -> None:
    conn.commit()
    conn.execute("ATTACH DATABASE ? AS arc", (path,))


def _detach(conn) -> None:
    try:
        conn.commit()
        conn.execute("DETACH DATABASE arc")
    except sqlite3.Error:
        pass


def archive_range(conn, t0: float, t1: float, tables=("observations",)) -> dict:
    """Copy the rows of `tables` with t0 <= ts < t1 into the monthly archive
    files and verify them.  Raises ArchiveError on any problem (the caller
    must then not delete).  Returns {table: rows archived}."""
    d = archive_dir(conn)
    os.makedirs(d, exist_ok=True)
    out = {}
    # Free-space check for the whole job
    need = 0
    for table in tables:
        ts_col = ARCHIVABLE[table]
        try:
            n = conn.execute(f"SELECT COUNT(*) FROM {table} WHERE {ts_col} >= ? AND {ts_col} < ?",
                             (t0, t1)).fetchone()[0]
        except sqlite3.OperationalError:
            n = 0                                  # table not present (older DB)
        need += n * (BYTES_PER_ROW if table == "observations" else 3000)
    free = shutil.disk_usage(d).free
    if free - need < FREE_MARGIN_MB * 1e6:
        raise ArchiveError(f"not enough free space in {d}: {free / 1e6:.0f} MB free, "
                           f"~{need / 1e6:.0f} MB needed + {FREE_MARGIN_MB} MB margin")

    for table in tables:
        ts_col = ARCHIVABLE[table]
        try:
            row = conn.execute(f"SELECT MIN({ts_col}) FROM {table} WHERE {ts_col} >= ? AND {ts_col} < ?",
                               (t0, t1)).fetchone()
        except sqlite3.OperationalError:
            continue
        if not row or row[0] is None:
            out[table] = 0
            continue
        day = (row[0] // DAY) * DAY
        total = 0
        cur_path = None
        try:
            while day < t1:
                a, b = max(day, t0), min(day + DAY, t1)
                path = _month_path(d, a)
                if path != cur_path:
                    if cur_path:
                        _detach(conn)
                    _attach(conn, path)
                    cur_path = path
                    cols = _ensure_table(conn, table)
                    fcols = _ensure_table(conn, "flights") if table == "observations" else None
                    conn.commit()
                clist = ", ".join(cols)
                if table == "observations":
                    fl = ", ".join(fcols)
                    conn.execute(
                        f"INSERT OR IGNORE INTO arc.flights ({fl}) SELECT {fl} FROM main.flights "
                        f"WHERE id IN (SELECT DISTINCT flight_id FROM main.observations "
                        f"WHERE ts >= ? AND ts < ? AND flight_id IS NOT NULL) ORDER BY id", (a, b))
                n = conn.execute(
                    f"INSERT OR IGNORE INTO arc.{table} ({clist}) SELECT {clist} FROM main.{table} "
                    f"WHERE {ts_col} >= ? AND {ts_col} < ? ORDER BY rowid", (a, b)).rowcount
                # (ORDER BY rowid: appending in key order keeps the archive's
                # pages full — in ts order they were half empty)
                conn.commit()
                missing = conn.execute(
                    f"SELECT COUNT(*) FROM main.{table} m WHERE m.{ts_col} >= ? AND m.{ts_col} < ? "
                    f"AND NOT EXISTS (SELECT 1 FROM arc.{table} x WHERE x.rowid = m.rowid)",
                    (a, b)).fetchone()[0]
                if missing:
                    raise ArchiveError(f"{missing} {table} rows of "
                                       f"{datetime.datetime.fromtimestamp(a, datetime.timezone.utc):%Y-%m-%d} not in {os.path.basename(path)}")
                total += max(n, 0)
                day += DAY
                time.sleep(0.02)                  # let the collector's writer in
        except ArchiveError:
            raise
        except Exception as exc:
            raise ArchiveError(f"{table}: {exc}") from exc
        finally:
            if cur_path:
                _detach(conn)
        out[table] = total
    return out


def archive_before_delete(conn, t0: float, t1: float, tables=("observations",)) -> dict | None:
    """If archiving is enabled, archive the rows about to be deleted.
    Returns the counts (None when disabled).  Raises ArchiveError on failure
    after recording it for the Maintenance page."""
    if not is_enabled(conn):
        return None
    try:
        res = archive_range(conn, t0, t1, tables)
    except ArchiveError as exc:
        log.error("Archive failed — purge skipped: %s", exc)
        _set_meta(conn, "archive_last_error",
                  f"{datetime.datetime.now(datetime.timezone.utc):%Y-%m-%d %H:%M} UTC: {exc}")
        raise
    _set_meta(conn, "archive_last_error", None)
    _set_meta(conn, "archive_last_run", str(time.time()))
    _set_meta(conn, "archive_last_rows", ", ".join(f"{k} {v}" for k, v in res.items()))
    log.info("Archive: %s", res)
    return res


# ── Listing ──────────────────────────────────────────────────────────────────
_list_cache: dict[str, tuple[float, dict]] = {}


def list_archives(conn) -> list[dict]:
    d = archive_dir(conn)
    out = []
    for path in sorted(glob.glob(os.path.join(d, "modes_meteo_*.db"))):
        name = os.path.basename(path)
        st = os.stat(path)
        info = {"file": name, "size_mb": round(st.st_size / 1e6, 1),
                "kind": "snapshot" if name.startswith(SNAPSHOT_PREFIX) else "archive",
                "modified": st.st_mtime}
        cached = _list_cache.get(path)
        if cached and cached[0] == st.st_mtime:
            info.update(cached[1])
        else:
            extra = {}
            try:
                c = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2)
                try:
                    r = c.execute("SELECT COUNT(*), MIN(ts), MAX(ts) FROM observations").fetchone()
                    extra.update(obs_rows=r[0], first=r[1], last=r[2])
                except sqlite3.Error:
                    pass
                for t in ("approach_series", "departure_profiles", "height_series"):
                    try:
                        extra[t] = c.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                    except sqlite3.Error:
                        pass
                c.close()
            except sqlite3.Error as exc:
                extra["error"] = str(exc)
            _list_cache[path] = (st.st_mtime, extra)
            info.update(extra)
        out.append(info)
    return out


# ── Snapshot (VACUUM INTO) ───────────────────────────────────────────────────
_snapshot_state: dict = {"running": False, "file": None, "started": None,
                         "finished": None, "error": None, "size_mb": None}
_snapshot_lock = threading.Lock()


def create_snapshot(db_path: str) -> dict:
    """Start a compact copy of the whole database in a background thread."""
    with _snapshot_lock:
        if _snapshot_state["running"]:
            return dict(_snapshot_state)
        c0 = sqlite3.connect(db_path)
        d = archive_dir(c0)
        c0.close()
        os.makedirs(d, exist_ok=True)
        need = os.path.getsize(db_path)
        free = shutil.disk_usage(d).free
        if free - need < FREE_MARGIN_MB * 1e6:
            _snapshot_state.update(error=f"not enough free space: {free / 1e6:.0f} MB free, "
                                         f"up to {need / 1e6:.0f} MB needed")
            return dict(_snapshot_state)
        name = f"{SNAPSHOT_PREFIX}{datetime.datetime.now(datetime.timezone.utc):%Y%m%d_%H%M}.db"
        _snapshot_state.update(running=True, file=name, started=time.time(),
                               finished=None, error=None, size_mb=None)

    def _run():
        path = os.path.join(d, name)
        try:
            c = sqlite3.connect(db_path, timeout=30)
            c.execute("VACUUM INTO ?", (path,))
            c.close()
            _snapshot_state.update(size_mb=round(os.path.getsize(path) / 1e6, 1))
            log.info("Snapshot written: %s (%.0f MB)", path, os.path.getsize(path) / 1e6)
        except Exception as exc:
            _snapshot_state.update(error=str(exc))
            log.error("Snapshot failed: %s", exc)
            try:
                if os.path.exists(path):
                    os.remove(path)
            except OSError:
                pass
        finally:
            _snapshot_state.update(running=False, finished=time.time())

    threading.Thread(target=_run, name="db_snapshot", daemon=True).start()
    return dict(_snapshot_state)
