"""
MODE-S Wind — meteorological data system — main entry point.

Usage (on RPi):
    cd /home/rspi22/modes_wind
    python3 run.py

Or in the background:
    nohup python3 run.py > logs/modes_wind.log 2>&1 &

Press Ctrl-C to stop.
"""

import json
import logging
import os
import queue
import sys
import threading
import time

# ── Configure logging before any imports ─────────────────────────────────
LOG_FORMAT = "%(asctime)s  %(levelname)-8s  %(name)-20s  %(message)s"
logging.basicConfig(
    level=logging.INFO,
    format=LOG_FORMAT,
    handlers=[
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("modes.main")

# ── Project root on sys.path ──────────────────────────────────────────────
ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from config import Config
from database.db import init_db
from collector.receiver import run_collector
from collector.radarcape_json import run_json_poller
from collector.windshear import WindshearTracker
from collector.gps_quality import GpsQualityTracker
from web.app import create_app


def _gps_quality_sweep(
    live_state: dict,
    live_lock: threading.RLock,
    tracker: GpsQualityTracker,
    sweep_sec: float = 5.0,
) -> None:
    """
    Background daemon: sweeps live_state every sweep_sec seconds, feeds
    each aircraft into the GPS quality tracker, then rebuilds the live
    degraded-aircraft list.
    """
    while True:
        try:
            with live_lock:
                snapshot = list(live_state.values())
            now = time.time()
            recent = [ac for ac in snapshot if now - ac.get("last_seen", 0) < 60]
            for ac in recent:
                tracker.update(ac)
            tracker.prune_stale()
            tracker.rebuild_live(recent)
        except Exception as exc:
            log.debug("GPS quality sweep error: %s", exc)
        time.sleep(sweep_sec)


def _windshear_sweep(
    live_state: dict,
    live_lock: threading.RLock,
    tracker: WindshearTracker,
) -> None:
    """
    Background daemon: sweeps live_state every 3 seconds, feeds each
    aircraft into the windshear tracker, then prunes stale entries.
    Runs independently of the SSE endpoint so the approach history is
    always current even when no browser tab is open.
    """
    while True:
        try:
            with live_lock:
                snapshot = list(live_state.values())
            now = time.time()
            for ac in snapshot:
                if now - ac.get("last_seen", 0) < 30:   # windshear tracker drops stale ac fast
                    tracker.update(ac)
            tracker.prune_stale()
        except Exception as exc:
            log.debug("Windshear sweep error: %s", exc)
        time.sleep(3)


def _on_approach_committed(record: dict) -> None:
    """
    Callback wired into WindshearTracker.on_approach_committed.

    Called from the ws_sweep thread each time an APPROACHING aircraft goes
    stale (assumed landed).  Writes the approach record to the persistent
    approach_history table using the sweep thread's own thread-local DB
    connection (get_db() is thread-local so this is safe).
    """
    from database.db import get_db
    db   = get_db()
    ts   = record.get("ts", time.time())
    t    = time.gmtime(ts)
    date = f"{t.tm_year:04d}-{t.tm_mon:02d}-{t.tm_mday:02d}"
    try:
        db.execute(
            """INSERT INTO approach_history
               (ts, date_utc, time_utc, icao, callsign, registration,
                aircraft_type, runway, rwy_heading, bands_json)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (
                ts,
                date,
                record.get("time_utc", ""),
                record.get("icao", ""),
                record.get("callsign"),
                record.get("registration"),
                record.get("aircraft_type"),
                record.get("runway", "?"),
                record.get("rwy_heading"),
                json.dumps(record.get("bands", {})),
            ),
        )
        db.commit()
    except Exception as exc:
        log.warning("approach_history DB write failed: %s", exc)


def _preload_approach_history(ws_tracker, db_path: str, hours: int = 24) -> None:
    """
    Load the last `hours` of approach records from the DB into the tracker's
    RAM list on startup.  Called once from main() before the sweep thread
    starts so the RAM list is immediately populated (no wait for first landing).
    """
    from database.db import get_db
    cutoff = time.time() - hours * 3600
    try:
        db   = get_db()
        rows = db.execute(
            """SELECT ts, time_utc, icao, callsign, registration,
                      aircraft_type, runway, rwy_heading, bands_json
               FROM approach_history
               WHERE ts > ?
               ORDER BY ts DESC
               LIMIT 500""",
            (cutoff,),
        ).fetchall()
        records = [
            {
                "ts":           row["ts"],
                "time_utc":     row["time_utc"],
                "icao":         row["icao"],
                "callsign":     row["callsign"],
                "registration": row["registration"],
                "aircraft_type": row["aircraft_type"],
                "runway":       row["runway"],
                "rwy_heading":  row["rwy_heading"],
                "bands":        json.loads(row["bands_json"]),
            }
            for row in rows
        ]
        ws_tracker.preload_approach_history(records)
    except Exception as exc:
        log.warning("approach_history preload failed: %s", exc)


def main() -> None:
    cfg = Config()

    # ── Ensure data directory exists ──────────────────────────────────────
    os.makedirs(os.path.dirname(cfg.DB_PATH), exist_ok=True)

    # Optionally log to file as well
    log_dir = os.path.join(ROOT, "logs")
    os.makedirs(log_dir, exist_ok=True)
    fh = logging.FileHandler(os.path.join(log_dir, "modes_meteo.log"))
    fh.setFormatter(logging.Formatter(LOG_FORMAT))
    logging.getLogger().addHandler(fh)

    log.info("=" * 60)
    log.info("MODE-S Wind System starting")
    log.info("  Database    : %s", cfg.DB_PATH)
    log.info("  Radarcape   : %s:%d", cfg.RADARCAPE_HOST, cfg.RADARCAPE_PORT)
    log.info("  Web         : http://%s:%d", cfg.WEB_HOST, cfg.WEB_PORT)
    log.info("  Source mode : %s", cfg.METEO_SOURCE_MODE)
    log.info("  Storage mode: %s", cfg.STORAGE_MODE)
    log.info("=" * 60)

    # ── Initialise database ───────────────────────────────────────────────
    init_db(cfg.DB_PATH)

    # ── Shared live state ─────────────────────────────────────────────────
    live_state: dict = {}
    live_lock = threading.RLock()
    sse_queue: queue.Queue = queue.Queue(maxsize=500)

    # ── Start collector thread ────────────────────────────────────────────
    collector_thread = threading.Thread(
        target=run_collector,
        args=(cfg, live_state, live_lock, sse_queue),
        name="collector",
        daemon=True,
    )
    collector_thread.start()
    log.info("Collector thread started")

    # ── Start Radarcape JSON poller thread ────────────────────────────────
    json_thread = threading.Thread(
        target=run_json_poller,
        args=(cfg.RADARCAPE_JSON_URL, live_state, live_lock, cfg.METEO_SOURCE_MODE, cfg.BLOCKED_ICAO_PREFIXES, cfg.BLOCKED_REG_PREFIXES),
        name="json_poller",
        daemon=True,
    )
    json_thread.start()
    log.info("JSON poller thread started — %s", cfg.RADARCAPE_JSON_URL)

    # ── Start Windshear approach tracker ─────────────────────────────────
    ws_tracker = WindshearTracker(
        airport_lat           = cfg.WINDSHEAR_AIRPORT_LAT,
        airport_lon           = cfg.WINDSHEAR_AIRPORT_LON,
        max_dist_nm           = cfg.WINDSHEAR_RADIUS_NM,
        max_alt_ft            = cfg.WINDSHEAR_MAX_ALT_FT,
        corridor_half_width   = cfg.WINDSHEAR_CORRIDOR_HALF_WIDTH_NM,
        max_ils_nm            = cfg.WINDSHEAR_MAX_ILS_NM,
        thr_elevation_ft      = cfg.WINDSHEAR_THR_ELEVATION_FT,
        max_track_dev         = cfg.WINDSHEAR_MAX_TRACK_DEV_DEG,
        ga_min_descent_polls  = cfg.WINDSHEAR_GA_MIN_DESCENT_POLLS,
        ga_min_climb_polls    = cfg.WINDSHEAR_GA_MIN_CLIMB_POLLS,
        ga_min_alt_gain_ft    = cfg.WINDSHEAR_GA_MIN_ALT_GAIN_FT,
        ga_climb_fpm          = cfg.WINDSHEAR_GA_CLIMB_FPM,
        ga_max_alt_ft         = cfg.WINDSHEAR_GA_MAX_ALT_FT,
        ga_flash_sec          = cfg.WINDSHEAR_GA_FLASH_SEC,
        blocked_reg_prefixes  = cfg.BLOCKED_REG_PREFIXES,
        on_approach_committed = _on_approach_committed,
    )

    # Pre-populate RAM approach history from the last 24 h of DB records so
    # the list is immediately available without waiting for the first landing.
    _preload_approach_history(ws_tracker, cfg.DB_PATH, hours=24)

    ws_thread = threading.Thread(
        target=_windshear_sweep,
        args=(live_state, live_lock, ws_tracker),
        name="ws_sweep",
        daemon=True,
    )
    ws_thread.start()
    log.info("Windshear sweep thread started (radius=%.0f NM, max_alt=%.0f ft)",
             cfg.WINDSHEAR_RADIUS_NM, cfg.WINDSHEAR_MAX_ALT_FT)

    # ── Start GPS Quality monitor ─────────────────────────────────────────
    gps_tracker = GpsQualityTracker(
        nacp_threshold = cfg.GPS_NACP_THRESHOLD,
        freeze_polls   = cfg.GPS_FREEZE_POLLS,
        gap_sec        = cfg.GPS_GAP_SEC,
        min_gs_kt      = cfg.GPS_MIN_GS_KT,
        min_alt_ft     = cfg.GPS_MIN_ALT_FT,
        db_path        = cfg.DB_PATH,
        airport_lat    = cfg.WINDSHEAR_AIRPORT_LAT,
        airport_lon    = cfg.WINDSHEAR_AIRPORT_LON,
    )
    gps_thread = threading.Thread(
        target=_gps_quality_sweep,
        args=(live_state, live_lock, gps_tracker, cfg.GPS_SWEEP_SEC),
        name="gps_sweep",
        daemon=True,
    )
    gps_thread.start()
    log.info("GPS quality sweep thread started (NACp threshold=%d, sweep=%.0f s)",
             cfg.GPS_NACP_THRESHOLD, cfg.GPS_SWEEP_SEC)

    # Give the collector a moment to connect before Flask starts accepting
    time.sleep(1)

    # ── Create Flask app ──────────────────────────────────────────────────
    app = create_app(cfg, live_state, live_lock, ws_tracker, gps_tracker)

    log.info("Web interface starting on http://0.0.0.0:%d", cfg.WEB_PORT)
    log.info("Access at  http://192.168.0.114:%d  (local network)", cfg.WEB_PORT)
    log.info("Username: %s  Password: %s", cfg.WEB_USER, cfg.WEB_PASS)

    try:
        # use_reloader=False is essential — reloader forks the process and
        # would start a second collector thread.
        app.run(
            host=cfg.WEB_HOST,
            port=cfg.WEB_PORT,
            debug=False,
            use_reloader=False,
            threaded=True,
        )
    except KeyboardInterrupt:
        log.info("Shutting down…")


if __name__ == "__main__":
    main()
