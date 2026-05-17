"""
MODE-S Wind — meteorological data system — main entry point.

Usage (on RPi):
    cd /home/rspi22/modes_wind
    python3 run.py

Or in the background:
    nohup python3 run.py > logs/modes_wind.log 2>&1 &

Press Ctrl-C to stop.
"""

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
from web.app import create_app


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
        args=(cfg.RADARCAPE_JSON_URL, live_state, live_lock, cfg.METEO_SOURCE_MODE),
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
        ga_climb_fpm          = cfg.WINDSHEAR_GA_CLIMB_FPM,
        ga_max_alt_ft         = cfg.WINDSHEAR_GA_MAX_ALT_FT,
        ga_flash_sec          = cfg.WINDSHEAR_GA_FLASH_SEC,
    )
    ws_thread = threading.Thread(
        target=_windshear_sweep,
        args=(live_state, live_lock, ws_tracker),
        name="ws_sweep",
        daemon=True,
    )
    ws_thread.start()
    log.info("Windshear sweep thread started (radius=%.0f NM, max_alt=%.0f ft)",
             cfg.WINDSHEAR_RADIUS_NM, cfg.WINDSHEAR_MAX_ALT_FT)

    # Give the collector a moment to connect before Flask starts accepting
    time.sleep(1)

    # ── Create Flask app ──────────────────────────────────────────────────
    app = create_app(cfg, live_state, live_lock, ws_tracker)

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
