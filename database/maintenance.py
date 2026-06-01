"""
database/maintenance.py

Database maintenance helpers for the Maintenance page.

Provides:
  - get_stats()                 — row counts, date ranges, DB file size
  - preview_flight_purge()      — counts what would be deleted (observations + flights)
  - purge_flight_data()         — deletes observations + flights older than N days
  - preview_gps_purge()         — counts GPS quality rows to be deleted
  - purge_gps_data()            — deletes GPS quality rows older than N days
  - get_autopurge_config()      — reads autopurge settings from maintenance_config
  - set_autopurge_config()      — writes autopurge settings
  - run_autopurge_if_needed()   — called by background thread; runs purge when due

Approach history is NEVER modified by any function in this module.
"""

import logging
import os
import time
import datetime

log = logging.getLogger("modes.maintenance")


# ── Statistics ────────────────────────────────────────────────────────────────

def get_stats(conn, db_path: str) -> dict:
    """
    Return a snapshot of all table sizes, date ranges and DB file size.
    Safe to call at any time — read-only queries.
    """

    def _fmt_ts(ts) -> str | None:
        if ts is None:
            return None
        return datetime.datetime.utcfromtimestamp(float(ts)).strftime("%Y-%m-%d %H:%M UTC")

    def _table_stats(table: str, ts_col: str, days_expr: str | None = None) -> dict:
        row = conn.execute(
            f"SELECT COUNT(*), MIN({ts_col}), MAX({ts_col}) FROM {table}"
        ).fetchone()
        days = None
        if days_expr:
            d = conn.execute(f"SELECT COUNT(DISTINCT {days_expr}) FROM {table}").fetchone()
            days = d[0] if d else None
        return {
            "rows":   row[0] or 0,
            "days":   days,
            "oldest": _fmt_ts(row[1]),
            "newest": _fmt_ts(row[2]),
        }

    obs = _table_stats("observations",     "ts",        "date(ts, 'unixepoch')")
    flt = _table_stats("flights",          "last_seen", "date(last_seen, 'unixepoch')")
    aph = _table_stats("approach_history", "ts",        "date_utc")
    gps = _table_stats("gps_quality_hours", "ts",       "date(ts, 'unixepoch')")
    gpsz_r = conn.execute(
        "SELECT COUNT(*), MIN(ts), MAX(ts) FROM gps_quality_zone_hours"
    ).fetchone()
    gpsz_days = conn.execute(
        "SELECT COUNT(DISTINCT date(ts, 'unixepoch')) FROM gps_quality_zone_hours"
    ).fetchone()
    gpsz = {
        "rows":   gpsz_r[0] or 0,
        "days":   gpsz_days[0] if gpsz_days else None,
        "oldest": _fmt_ts(gpsz_r[1]),
        "newest": _fmt_ts(gpsz_r[2]),
    }

    try:
        db_size_mb = round(os.path.getsize(db_path) / (1024 * 1024), 2)
    except OSError:
        db_size_mb = None

    return {
        "observations":          obs,
        "flights":               flt,
        "approach_history":      aph,
        "gps_quality_hours":     gps,
        "gps_quality_zone_hours": gpsz,
        "db_size_mb":            db_size_mb,
    }


# ── Flight / observation purge ────────────────────────────────────────────────

def _flight_cutoff(days: int) -> float:
    return time.time() - days * 86_400


def preview_flight_purge(conn, days: int) -> dict:
    """Return counts of observations and flights that would be deleted."""
    cutoff = _flight_cutoff(days)
    obs_count = conn.execute(
        "SELECT COUNT(*) FROM observations WHERE ts < ?", (cutoff,)
    ).fetchone()[0]
    flt_count = conn.execute(
        "SELECT COUNT(*) FROM flights WHERE last_seen < ?", (cutoff,)
    ).fetchone()[0]
    oldest_obs = conn.execute(
        "SELECT MIN(ts) FROM observations WHERE ts < ?", (cutoff,)
    ).fetchone()[0]
    newest_obs = conn.execute(
        "SELECT MAX(ts) FROM observations WHERE ts < ?", (cutoff,)
    ).fetchone()[0]

    def _fmt(ts):
        if ts is None:
            return None
        return datetime.datetime.utcfromtimestamp(float(ts)).strftime("%Y-%m-%d %H:%M UTC")

    return {
        "observations": obs_count,
        "flights":      flt_count,
        "range_oldest": _fmt(oldest_obs),
        "range_newest": _fmt(newest_obs),
        "cutoff_date":  datetime.datetime.utcfromtimestamp(cutoff).strftime("%Y-%m-%d %H:%M UTC"),
    }


def purge_flight_data(conn, days: int) -> dict:
    """
    Delete observations and flights older than N days.
    Approach history is never touched.
    Returns counts of deleted rows.
    """
    cutoff = _flight_cutoff(days)
    log.info("Maintenance: purging flight data older than %d days (cutoff %s)",
             days, datetime.datetime.utcfromtimestamp(cutoff).isoformat())

    # Delete observations first (FK references flights)
    obs_del = conn.execute(
        "DELETE FROM observations WHERE ts < ?", (cutoff,)
    ).rowcount

    # Delete flights whose last_seen is before the cutoff
    # (all their observations have been removed above)
    flt_del = conn.execute(
        "DELETE FROM flights WHERE last_seen < ?", (cutoff,)
    ).rowcount

    conn.commit()
    log.info("Maintenance: deleted %d observations, %d flights", obs_del, flt_del)
    return {"observations_deleted": obs_del, "flights_deleted": flt_del}


# ── GPS quality purge ─────────────────────────────────────────────────────────

def preview_gps_purge(conn, days: int) -> dict:
    """Return counts of GPS quality rows that would be deleted."""
    cutoff = int(time.time() - days * 86_400)
    hours_count = conn.execute(
        "SELECT COUNT(*) FROM gps_quality_hours WHERE ts < ?", (cutoff,)
    ).fetchone()[0]
    zone_count = conn.execute(
        "SELECT COUNT(*) FROM gps_quality_zone_hours WHERE ts < ?", (cutoff,)
    ).fetchone()[0]
    cutoff_date = datetime.datetime.utcfromtimestamp(cutoff).strftime("%Y-%m-%d %H:%M UTC")
    return {
        "gps_quality_hours":      hours_count,
        "gps_quality_zone_hours": zone_count,
        "cutoff_date":            cutoff_date,
    }


def purge_gps_data(conn, days: int) -> dict:
    """Delete GPS quality hourly buckets older than N days."""
    cutoff = int(time.time() - days * 86_400)
    log.info("Maintenance: purging GPS quality data older than %d days", days)
    h_del = conn.execute(
        "DELETE FROM gps_quality_hours WHERE ts < ?", (cutoff,)
    ).rowcount
    z_del = conn.execute(
        "DELETE FROM gps_quality_zone_hours WHERE ts < ?", (cutoff,)
    ).rowcount
    conn.commit()
    log.info("Maintenance: deleted %d gps_quality_hours, %d gps_quality_zone_hours rows",
             h_del, z_del)
    return {"gps_quality_hours_deleted": h_del, "gps_quality_zone_hours_deleted": z_del}


# ── Autopurge configuration ───────────────────────────────────────────────────

def get_autopurge_config(conn) -> dict:
    """Read autopurge settings from maintenance_config table."""
    rows = conn.execute(
        "SELECT key, value FROM maintenance_config WHERE key LIKE 'autopurge_%'"
    ).fetchall()
    cfg = {r["key"]: r["value"] for r in rows}
    return {
        "enabled": cfg.get("autopurge_flight_enabled", "0") == "1",
        "days":    int(cfg.get("autopurge_flight_days", "30")),
        "last_run": cfg.get("autopurge_last_run"),
    }


def set_autopurge_config(conn, enabled: bool, days: int) -> None:
    """Write autopurge settings to maintenance_config table."""
    conn.execute(
        "INSERT OR REPLACE INTO maintenance_config (key, value) VALUES (?, ?)",
        ("autopurge_flight_enabled", "1" if enabled else "0"),
    )
    conn.execute(
        "INSERT OR REPLACE INTO maintenance_config (key, value) VALUES (?, ?)",
        ("autopurge_flight_days", str(max(1, days))),
    )
    conn.commit()


def run_autopurge_if_needed(conn, db_path: str) -> None:
    """
    Check autopurge config and run flight data purge if it is due.
    Called hourly by the background thread in run.py.
    Approach history and GPS quality data are never auto-purged.
    """
    cfg = get_autopurge_config(conn)
    if not cfg["enabled"]:
        return

    # Run at most once per day — check last_run timestamp
    last_run_str = cfg.get("last_run")
    if last_run_str:
        try:
            last_run = float(last_run_str)
            if (time.time() - last_run) < 86_400:
                return   # Already ran today
        except ValueError:
            pass

    days = cfg["days"]
    log.info("Autopurge: running flight data purge (threshold %d days)", days)
    result = purge_flight_data(conn, days)
    log.info("Autopurge: %s", result)

    # Record last run time
    conn.execute(
        "INSERT OR REPLACE INTO maintenance_config (key, value) VALUES (?, ?)",
        ("autopurge_last_run", str(time.time())),
    )
    conn.commit()
