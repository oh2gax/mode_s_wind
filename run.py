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
from collector.receiver import run_collector, prune_bds_cache, get_bds_samples
from collector.radarcape_json import run_json_poller
from collector.windshear import WindshearTracker
from collector.gps_quality import GpsQualityTracker
from database import maintenance as maint
from collector import aircraft_db
from collector import heading_cal
from web.app import create_app, start_wx_poll_thread


def _autopurge_thread(db_path: str, interval_sec: float = 3_600.0) -> None:
    """
    Background daemon: checks autopurge configuration once per hour and
    runs flight/observation data purge when it is due (at most once per day).
    Approach history and GPS quality data are never auto-purged.
    """
    import time as _time
    from database.db import get_db as _get_db
    log = logging.getLogger("modes.autopurge")
    while True:
        try:
            conn = _get_db()
            maint.run_autopurge_if_needed(conn, db_path)
        except Exception as exc:
            log.warning("Autopurge error: %s", exc)
        _time.sleep(interval_sec)


LIVE_STATE_MAX_AGE_SEC = 600.0   # drop aircraft unseen for 10 min (map window is 5 min)


def _housekeeping_thread(
    live_state: dict,
    live_lock: threading.RLock,
    interval_sec: float = 60.0,
    max_age_sec: float = LIVE_STATE_MAX_AGE_SEC,
) -> None:
    """
    Background daemon: removes aircraft from live_state that have not been
    seen for max_age_sec, and prunes the BDS 5,0 / 6,0 pairing caches.

    Without this, every aircraft ever received stays in RAM for the life of the
    process.  max_age_sec (10 min) is longer than every consumer window —
    map/API 300 s, GPS sweep 60 s, windshear sweep 30 s — so nothing that is
    displayed or analysed is affected.  An aircraft that reappears later is
    simply re-created from its next message, exactly like a new aircraft.
    """
    hk_log = logging.getLogger("modes.housekeeping")
    while True:
        time.sleep(interval_sec)
        try:
            cutoff = time.time() - max_age_sec
            with live_lock:
                stale = [k for k, v in live_state.items()
                         if v.get("last_seen", 0) < cutoff]
                for k in stale:
                    del live_state[k]
                remaining = len(live_state)
            n_bds = prune_bds_cache()
            if stale or n_bds:
                hk_log.debug("Pruned %d live_state entries (%d remain), %d BDS cache entries",
                             len(stale), remaining, n_bds)
        except Exception as exc:
            hk_log.warning("Housekeeping error: %s", exc)


def _hourly_jobs_thread(cfg) -> None:
    """
    Background daemon for once-per-hour jobs (from 2026-10-09):

      • Hourly atmospheric profile archive (profile_hours): a few minutes
        after each hour change the area profile (wind + Mach/TAS temperature
        per altitude layer) of the hour that ended is computed from the
        observations and stored — one read query and one INSERT.  At startup
        hours missing within the observations still in the database are
        back-filled (slowly, in the background).
      • Approach series retention: approach_series rows older than
        APPROACH_SERIES_DAYS (default 90) are deleted once a day.
      • Heading calibration (from 2026-10-10): the per-airframe heading
        offsets that changed during the hour are written to heading_cal.
    """
    from database.db import get_db as _get_db
    from collector.atmos import store_missing_profile_hours
    hj_log = logging.getLogger("modes.hourly")
    series_days = float(getattr(cfg, "APPROACH_SERIES_DAYS", 90))
    last_purge = 0.0
    first = True
    while True:
        try:
            db = _get_db()
            n = store_missing_profile_hours(
                db, cfg.RECEIVER_LAT, cfg.RECEIVER_LON, cfg.SOUNDING_RADIUS_KM,
                max_hours=31 * 24 if first else 48, pause_sec=0.2 if first else 0.0)
            if n:
                hj_log.info("Hourly profile archive: stored %d hour(s)", n)
            first = False
            _hc = heading_cal.get()
            if _hc is not None and _hc.enabled:
                n_hc = _hc.save(db)
                if n_hc:
                    hj_log.info("Heading calibration: saved %d airframe(s)", n_hc)
            if time.time() - last_purge > 86_400 and series_days > 0:
                cur = db.execute("DELETE FROM approach_series WHERE ts < ?",
                                 (time.time() - series_days * 86_400,))
                db.commit()
                last_purge = time.time()
                if cur.rowcount:
                    hj_log.info("Approach series: deleted %d rows older than %g days",
                                cur.rowcount, series_days)
        except Exception as exc:
            hj_log.warning("Hourly jobs error: %s", exc)
        # wake up 3 minutes after the next hour change
        now = time.time()
        time.sleep(max(60.0, (now // 3600 + 1) * 3600 + 180 - now))


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
                aircraft_type, runway, rwy_heading, bands_json, go_arounds, qnh_hpa,
                gnss_json, rough_json, prof_json)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
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
                record.get("go_arounds", 0),
                record.get("qnh_hpa"),
                (json.dumps(record["gnss"], separators=(",", ":"))
                 if record.get("gnss") else None),
                (json.dumps(record["rough"], separators=(",", ":"))
                 if record.get("rough") else None),
                (json.dumps(record["prof"], separators=(",", ":"))
                 if record.get("prof") else None),
            ),
        )
        # Raw reply series (research data, retention APPROACH_SERIES_DAYS) —
        # same transaction, so no extra commit
        if record.get("series"):
            db.execute(
                "INSERT INTO approach_series (ts, icao, runway, data) VALUES (?,?,?,?)",
                (ts, record.get("icao", ""), record.get("runway"), record["series"]))
        db.commit()
    except Exception as exc:
        log.warning("approach_history DB write failed: %s", exc)


def _heading_cal_bootstrap(hc) -> None:
    """One-off: learn the heading offsets from the stored observations of the
    last HEADING_CAL_BOOTSTRAP_DAYS when the heading_cal table is empty
    (first start with the feature), then save them."""
    from database.db import get_db as _get_db
    hc_log = logging.getLogger("modes.heading_cal")
    try:
        t0 = time.time()
        time.sleep(20)                      # let the collector start first
        db = _get_db()
        n = hc.bootstrap(db, typ_fn=lambda icao: aircraft_db.lookup(icao)[1])
        hc.save(db)
        s = hc.summary(include_airframes=False)
        hc_log.info("Heading calibration bootstrap: %d airframe(s) from the last %g days "
                    "(%d calibrated, %d excluded, fleet median %s°) in %.0f s",
                    n, hc.bootstrap_days, s["calibrated"], s["excluded"],
                    s["fleet_median_deg"], time.time() - t0 - 20)
    except Exception as exc:
        hc_log.warning("Heading calibration bootstrap failed: %s", exc)


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
                      aircraft_type, runway, rwy_heading, bands_json, go_arounds,
                      gnss_json, rough_json, prof_json
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
                "go_arounds":   row["go_arounds"] if row["go_arounds"] is not None else 0,
                "gnss":         json.loads(row["gnss_json"]) if row["gnss_json"] else None,
                "rough":        json.loads(row["rough_json"]) if row["rough_json"] else None,
                "prof":         json.loads(row["prof_json"]) if row["prof_json"] else None,
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

    # Optional BaseStation.sqb aircraft database (registrations / types for
    # aircraft the Radarcape JSON feed has none for) — default: next to the
    # main database (data/BaseStation.sqb); used only if the file exists.
    aircraft_db.init(getattr(cfg, "BASESTATION_DB_PATH", None)
                     or os.path.join(os.path.dirname(os.path.abspath(cfg.DB_PATH)), "BaseStation.sqb"))

    # ── Per-airframe heading calibration (collector/heading_cal.py) ───────
    hc = heading_cal.init(cfg)
    if hc.enabled:
        from database.db import get_db as _get_db
        try:
            n_loaded = hc.load(_get_db())
            log.info("Heading calibration: mode %s, %d airframe(s) loaded", hc.mode, n_loaded)
            if n_loaded == 0 and hc.bootstrap_days > 0:
                threading.Thread(target=_heading_cal_bootstrap, args=(hc,),
                                 name="heading_cal_boot", daemon=True).start()
        except Exception as exc:
            log.warning("Heading calibration load failed: %s", exc)
    else:
        log.info("Heading calibration: off")

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
        bds_sample_fn         = get_bds_samples,
        mag_declination       = cfg.MAG_DECLINATION,
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
        nic_threshold  = getattr(cfg, "GPS_NIC_THRESHOLD", 6),
        freeze_polls   = cfg.GPS_FREEZE_POLLS,
        gap_sec        = cfg.GPS_GAP_SEC,
        min_gs_kt      = cfg.GPS_MIN_GS_KT,
        min_alt_ft     = cfg.GPS_MIN_ALT_FT,
        db_path        = cfg.DB_PATH,
        airport_lat    = cfg.WINDSHEAR_AIRPORT_LAT,
        airport_lon    = cfg.WINDSHEAR_AIRPORT_LON,
        episode_radius_nm = getattr(cfg, "GPS_EPISODE_RADIUS_NM", 100.0),
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

    # ── Housekeeping thread (live_state + BDS cache pruning) ──────────────
    hk_thread = threading.Thread(
        target=_housekeeping_thread,
        args=(live_state, live_lock),
        name="housekeeping",
        daemon=True,
    )
    hk_thread.start()
    log.info("Housekeeping thread started (live_state max age %.0f s)", LIVE_STATE_MAX_AGE_SEC)

    # ── Hourly jobs (profile archive, approach series retention) ─────────
    hourly_thread = threading.Thread(
        target=_hourly_jobs_thread,
        args=(cfg,),
        name="hourly_jobs",
        daemon=True,
    )
    hourly_thread.start()
    log.info("Hourly jobs thread started (profile archive, approach series %g days)",
             float(getattr(cfg, "APPROACH_SERIES_DAYS", 90)))

    # ── Autopurge background thread ───────────────────────────────────────
    autopurge_thread = threading.Thread(
        target=_autopurge_thread,
        args=(cfg.DB_PATH,),
        name="autopurge",
        daemon=True,
    )
    autopurge_thread.start()
    log.info("Autopurge thread started (checks every hour)")

    # Give the collector a moment to connect before Flask starts accepting
    time.sleep(1)

    # ── Create Flask app ──────────────────────────────────────────────────
    app = create_app(cfg, live_state, live_lock, ws_tracker, gps_tracker)

    # ── Start background WX (METAR / TAF) polling thread ─────────────────
    start_wx_poll_thread(cfg.AIRPORT_ICAO.upper(), on_qnh=ws_tracker.set_qnh,
                         on_metar=ws_tracker.set_metar)
    log.info("WX poll thread started (ICAO=%s, interval=600s, retries=3)",
             cfg.AIRPORT_ICAO.upper())

    log.info("Web interface starting on http://0.0.0.0:%d", cfg.WEB_PORT)
    log.info("Access at  http://192.168.0.114:%d  (local network)", cfg.WEB_PORT)
    log.info("Username: %s  Password: %s", cfg.WEB_USER, cfg.WEB_PASS)


    # systemd / kill send SIGTERM: turn it into a normal exit so the final
    # checkpoint below runs (Ctrl+C arrives as KeyboardInterrupt)
    import signal

    def _on_sigterm(signum, frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, _on_sigterm)

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
    finally:
        # Save the hour in progress, the open GPS episodes and the closed
        # episodes not yet written, so a restart loses nothing of them
        try:
            gps_tracker.checkpoint(force=True)
            log.info("GPS quality: final checkpoint written")
        except Exception as exc:
            log.warning("GPS quality: final checkpoint failed: %s", exc)
        try:
            if hc.enabled:
                from database.db import get_db as _get_db
                n_hc = hc.save(_get_db())
                log.info("Heading calibration: %d airframe(s) saved at shutdown", n_hc)
        except Exception as exc:
            log.warning("Heading calibration: final save failed: %s", exc)


if __name__ == "__main__":
    main()
