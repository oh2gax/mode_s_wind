"""
Database connection and initialisation helpers.

All modules that need the database import `get_db()` which returns a
thread-local connection.  The collector thread gets its own connection;
Flask workers each get their own connection.  SQLite WAL mode allows
concurrent reads while the collector is writing.
"""

import logging
import os
import sqlite3
import threading

log = logging.getLogger("modes.db")

# Thread-local storage so each thread keeps its own connection.
_local = threading.local()
_db_path: str = ""   # set once by init_db()


def init_db(db_path: str) -> None:
    """Create the database file and apply the schema.

    Called once at startup (from run.py) before any threads start.
    """
    global _db_path
    _db_path = db_path

    os.makedirs(os.path.dirname(db_path), exist_ok=True)

    schema_path = os.path.join(os.path.dirname(__file__), "schema.sql")
    with open(schema_path) as f:
        schema = f.read()

    conn = sqlite3.connect(db_path)
    conn.executescript(schema)

    # ── Migrations: add columns that did not exist in earlier schema versions ──
    # SQLite does not support ALTER TABLE … ADD COLUMN IF NOT EXISTS, so we
    # attempt each ALTER and silently ignore "duplicate column" errors.
    _migrations = [
        "ALTER TABLE gps_quality_hours ADD COLUMN nacp_events        INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE gps_quality_hours ADD COLUMN freeze_events      INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE gps_quality_hours ADD COLUMN gap_events         INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE gps_quality_hours ADD COLUMN adsb_loss_events   INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE gps_quality_zone_hours ADD COLUMN adsb_loss_events INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE approach_history ADD COLUMN go_arounds INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE approach_history ADD COLUMN qnh_hpa REAL",
        "ALTER TABLE observations ADD COLUMN tas_source TEXT",
        "ALTER TABLE observations ADD COLUMN mag_decl REAL",
        "ALTER TABLE gps_quality_hours ADD COLUMN method INTEGER",
        "ALTER TABLE gps_quality_zone_hours ADD COLUMN method INTEGER",
        "ALTER TABLE gps_quality_hours ADD COLUMN nic_events INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE gps_quality_zone_hours ADD COLUMN nic_events INTEGER NOT NULL DEFAULT 0",
    ]
    for sql in _migrations:
        try:
            conn.execute(sql)
        except sqlite3.OperationalError:
            pass   # column already exists — normal after first migration

    # GPS quality counting-method version for rows written before the column
    # existed (only touches NULLs, so it runs once):
    #   1 — up to 2026-09-25 11:00 UTC: live_state never pruned, so returning
    #       aircraft carried stale ADS-B/position state from earlier visits
    #   2 — from 2026-09-25 11:00 UTC: live_state pruned after 10 min
    # New rows carry the current version from collector/gps_quality.py.
    for table in ("gps_quality_hours", "gps_quality_zone_hours"):
        conn.execute(
            f"UPDATE {table} SET method = CASE WHEN ts >= 1790334000 THEN 2 ELSE 1 END "
            f"WHERE method IS NULL"
        )

    conn.commit()
    conn.close()
    log.info("Database initialised at %s", db_path)


def get_db() -> sqlite3.Connection:
    """Return the thread-local SQLite connection, creating it if needed."""
    if not hasattr(_local, "conn") or _local.conn is None:
        # timeout: wait up to 15 s for another writer's lock (default 5 s)
        # before raising "database is locked" — maintenance purges now commit
        # in small batches, so waits are normally far shorter.
        conn = sqlite3.connect(_db_path, check_same_thread=False, timeout=15.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous  = NORMAL")
        conn.execute("PRAGMA foreign_keys = ON")
        _local.conn = conn
    return _local.conn


def close_db() -> None:
    """Close the thread-local connection (call from thread cleanup)."""
    conn = getattr(_local, "conn", None)
    if conn:
        conn.close()
        _local.conn = None
