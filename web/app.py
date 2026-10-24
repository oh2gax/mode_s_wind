"""
Flask application factory and SSE live-stream endpoint.

Basic HTTP authentication is enforced on every request via a before_request
hook.  Users: Config.WEB_USER / WEB_PASS, the maintenance user and the users
file managed on the Maintenance page (web/users.py).  Logins, refused
requests and misuse are written to logs/access.log (web/access_log.py).
"""

import json
import logging
import os
import queue
import threading
import time
import urllib.request
from functools import wraps

from flask import (
    Flask, Response, g, render_template, request,
    jsonify, stream_with_context, send_from_directory, abort,
)

from config import Config
from database.db import get_db
from database import maintenance as maint
from collector.approach_cond import approach_index
from web import access_log
from web import users as web_users

log = logging.getLogger("modes.web")

# ── QNH cache ─────────────────────────────────────────────────────────────
# Populated each time /api/wx is called; shared between requests.
# Falls back to ISA standard (1013.25 hPa) if no METAR has been fetched yet.
_qnh_cache: dict = {"hpa": 1013.25, "station": None, "updated": 0.0}

# ── Weather cache (METAR / TAF) ───────────────────────────────────────────
# Populated by the background wx_poll thread; served directly by /api/wx.
# Keys are None until the first successful fetch (never "[unavailable]" here —
# that sentinel is added at response time for JS backward-compatibility).
_wx_cache: dict = {
    "station":    None,
    "metar":      None,
    "taf":        None,
    "fetched_at": 0.0,    # epoch of last successful fetch
    "qnh_hpa":    None,
    "metar_wind": None,
}
_wx_cache_lock = threading.Lock()

_WX_POLL_INTERVAL_SEC  = 600  # fetch every 10 minutes
_WX_FETCH_RETRIES      = 3    # attempts per source before giving up
_WX_FETCH_RETRY_DELAY  = 5    # seconds between retries
_WX_FETCH_TIMEOUT      = 8    # HTTP request timeout in seconds


def _wx_fetch_once(icao: str) -> dict:
    """Fetch METAR and TAF from NOAA with per-source retry.

    Returns a dict with keys 'metar' and 'taf'.  A key is None when all
    retries failed for that source so the caller can decide to keep the
    previously cached value instead of overwriting it with None.
    """
    sources = {
        "metar": f"https://tgftp.nws.noaa.gov/data/observations/metar/stations/{icao}.TXT",
        "taf":   f"https://tgftp.nws.noaa.gov/data/forecasts/taf/stations/{icao}.TXT",
    }
    result: dict = {"metar": None, "taf": None}
    for key, url in sources.items():
        for attempt in range(1, _WX_FETCH_RETRIES + 1):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "MODE-S-Wind/1.0"})
                with urllib.request.urlopen(req, timeout=_WX_FETCH_TIMEOUT) as resp:
                    raw = resp.read().decode("utf-8", errors="replace").strip()
                lines = raw.splitlines()
                result[key] = "\n".join(lines[1:]).strip() if len(lines) > 1 else raw
                break  # success — stop retrying this source
            except Exception as exc:
                if attempt < _WX_FETCH_RETRIES:
                    log.debug(
                        "WX fetch attempt %d/%d failed (%s %s): %s — retrying in %ds",
                        attempt, _WX_FETCH_RETRIES, key.upper(), icao, exc,
                        _WX_FETCH_RETRY_DELAY,
                    )
                    time.sleep(_WX_FETCH_RETRY_DELAY)
                else:
                    log.warning(
                        "WX fetch failed after %d attempts (%s %s): %s",
                        _WX_FETCH_RETRIES, key.upper(), icao, exc,
                    )
    return result


def _wx_poll_loop(icao: str, interval_sec: float, on_qnh=None, on_metar=None) -> None:
    """Background daemon: fetch METAR and TAF on a fixed interval.

    On success updates _wx_cache in place (including QNH and surface wind).
    On failure for a source the existing cached value for that source is
    preserved, so a brief NOAA outage never shows [unavailable] to the user.
    """
    _log = logging.getLogger("modes.wx")
    time.sleep(3)   # let Flask finish its startup sequence
    while True:
        fetched = _wx_fetch_once(icao)
        with _wx_cache_lock:
            any_success = False
            for key in ("metar", "taf"):
                if fetched[key] is not None:
                    _wx_cache[key] = fetched[key]
                    any_success = True
            _wx_cache["station"] = icao
            if any_success:
                _wx_cache["fetched_at"] = time.time()
                if _wx_cache.get("metar"):
                    qnh = _parse_qnh(_wx_cache["metar"])
                    if qnh is not None:
                        _wx_cache["qnh_hpa"] = qnh
                        _qnh_cache["hpa"]     = qnh
                        _qnh_cache["station"] = icao
                        _qnh_cache["updated"] = time.time()
                        _log.debug("QNH updated: %.1f hPa from %s METAR", qnh, icao)
                        # Push QNH to server-side consumers (windshear tracker)
                        if on_qnh is not None:
                            try:
                                on_qnh(qnh)
                            except Exception as exc:
                                _log.warning("QNH callback failed: %s", exc)
                if _wx_cache.get("metar"):
                    _wx_cache["metar_wind"] = _parse_metar_wind(_wx_cache["metar"])
                    # Push the raw METAR to server-side consumers (windshear
                    # tracker stores the surface wind / gust with each landing)
                    if on_metar is not None:
                        try:
                            on_metar(_wx_cache["metar"])
                        except Exception as exc:
                            _log.warning("METAR callback failed: %s", exc)
                _log.debug("WX cache refreshed for %s", icao)
        time.sleep(interval_sec)


def start_wx_poll_thread(
    icao: str,
    interval_sec: float = _WX_POLL_INTERVAL_SEC,
    on_qnh=None,
    on_metar=None,
) -> threading.Thread:
    """Start the background WX polling daemon.  Call once from run.py.

    on_qnh: optional callable(qnh_hpa) invoked each time a METAR QNH is parsed
    (used to keep the windshear tracker's pressure-altitude correction current).
    on_metar: optional callable(metar_text) invoked after each METAR refresh
    (the windshear tracker stores the surface wind / gust with each landing).
    """
    t = threading.Thread(
        target=_wx_poll_loop,
        args=(icao, interval_sec, on_qnh, on_metar),
        name="wx_poll",
        daemon=True,
    )
    t.start()
    return t




def _parse_qnh(metar_text: str) -> float | None:
    """Extract QNH from a decoded METAR string.

    Handles both hPa (Q-group, e.g. ``Q1013``) and inHg (A-group,
    e.g. ``A2992``).  Returns hPa as a float, or None if not found.
    """
    import re
    # Q-group: metric hPa (European standard)
    m = re.search(r"\bQ(\d{3,4})\b", metar_text)
    if m:
        return float(m.group(1))
    # A-group: hundredths of inches of mercury (US/Canada)
    m = re.search(r"\bA(\d{4})\b", metar_text)
    if m:
        inhg = float(m.group(1)) / 100.0
        return round(inhg * 33.8639, 1)
    return None


def _parse_metar_wind(metar_text: str) -> dict | None:
    """Extract surface wind from a METAR string.

    Returns a dict with keys:
      'dir'      — integer degrees (0–360), or None for variable direction
      'spd'      — integer knots
      'variable' — True when direction is variable (VRB group)
      'gust'     — integer knots of the gust group (Gxx), or None

    Returns None if no recognisable wind group is found.
    """
    import re
    # Variable wind: VRBssKT
    m = re.search(r"\bVRB(\d{2,3})(?:G(\d{2,3}))?KT\b", metar_text)
    if m:
        return {"dir": None, "spd": int(m.group(1)), "variable": True,
                "gust": int(m.group(2)) if m.group(2) else None}
    # Calm: 00000KT
    m = re.search(r"\b00000KT\b", metar_text)
    if m:
        return {"dir": 0, "spd": 0, "variable": False, "gust": None}
    # Normal: DDDssKT or DDDssGggKT
    m = re.search(r"\b(\d{3})(\d{2,3})(?:G(\d{2,3}))?KT\b", metar_text)
    if m:
        return {"dir": int(m.group(1)), "spd": int(m.group(2)), "variable": False,
                "gust": int(m.group(3)) if m.group(3) else None}
    return None


def _check_auth(username: str, password: str, cfg: Config) -> bool:
    # config.py user, maintenance user or a user of the users file (web/users.py;
    # constant-time comparisons, hashed passwords)
    try:
        return web_users.check_web(cfg, username, password)
    except Exception as exc:                       # noqa: BLE001
        log.warning("User check failed: %s", exc)
        return False


def _require_auth():
    return Response(
        "Authentication required.",
        401,
        {"WWW-Authenticate": 'Basic realm="MODE-S Meteo"'},
    )


def create_app(
    cfg: Config,
    live_state: dict,
    live_lock: threading.RLock,
    ws_tracker=None,
    gps_tracker=None,
) -> Flask:
    """
    Build and return the Flask application.

    Args:
        cfg        : Config instance
        live_state : shared dict maintained by the collector thread
        live_lock  : RLock protecting live_state
    """
    app = Flask(
        __name__,
        template_folder="../web/templates",
        static_folder="../static",
    )
    app.config["SECRET_KEY"] = "modes-meteo-secret"

    # ── Template globals — config badges shown in every page's navbar ─────

    @app.context_processor
    def inject_config_modes():
        from web import whats_new
        return {
            "meteo_source_mode": cfg.METEO_SOURCE_MODE,
            "storage_mode":      cfg.STORAGE_MODE,
            "carto_api_key":     cfg.CARTO_API_KEY,
            "app_version":       whats_new.version(),    # v.DDMMYYYY (doc/whats_new.md, CHANGELOG.md)
            "guide_links":       whats_new.guide_links(), # ? buttons -> user guide PDFs
        }

    # ── Authentication ────────────────────────────────────────────────────

    @app.before_request
    def require_login():
        tr = access_log.tracker
        if tr is not None and tr.is_blocked(request.remote_addr or ""):
            g.auth_state = "blocked"
            return Response("Too many failed logins — try again later.", 429,
                            {"Retry-After": str(int(tr.lock_sec))})
        auth = request.authorization
        if not auth:
            g.auth_state = "none"
            return _require_auth()
        if not _check_auth(auth.username, auth.password, cfg):
            g.auth_state, g.auth_user = "bad", auth.username
            return _require_auth()
        g.auth_state, g.auth_user = "ok", auth.username

    # Compact access / misuse log (logs/access.log, see web/access_log.py)
    access_log.init_app(app)

    # ── Page routes ───────────────────────────────────────────────────────

    @app.route("/")
    def index():
        return render_template("live.html",
                               receiver_lat=cfg.RECEIVER_LAT,
                               receiver_lon=cfg.RECEIVER_LON,
                               airport_icao=cfg.AIRPORT_ICAO)

    @app.route("/flights")
    def flights_page():
        return render_template("flights.html")

    @app.route("/sounding")
    def sounding_page():
        return render_template("sounding.html",
                               receiver_lat=cfg.RECEIVER_LAT,
                               receiver_lon=cfg.RECEIVER_LON,
                               sounding_radius=cfg.SOUNDING_RADIUS_KM,
                               sounding_window=cfg.SOUNDING_WINDOW_MIN)

    @app.route("/windmap")
    def windmap_page():
        return render_template("windmap.html",
                               receiver_lat=cfg.RECEIVER_LAT,
                               receiver_lon=cfg.RECEIVER_LON)

    @app.route("/weather")
    def weather_page():
        return render_template("weather.html",
                               receiver_lat=cfg.RECEIVER_LAT,
                               receiver_lon=cfg.RECEIVER_LON)

    @app.route("/windshear")
    def windshear_page():
        return render_template("windshear.html",
                               receiver_lat=cfg.RECEIVER_LAT,
                               receiver_lon=cfg.RECEIVER_LON,
                               airport_icao=cfg.AIRPORT_ICAO,
                               airport_lat=cfg.WINDSHEAR_AIRPORT_LAT,
                               airport_lon=cfg.WINDSHEAR_AIRPORT_LON,
                               radius_nm=cfg.WINDSHEAR_RADIUS_NM,
                               thr_elevation_ft=cfg.WINDSHEAR_THR_ELEVATION_FT,
                               gs_offset_ft=cfg.WINDSHEAR_GS_OFFSET_FT)

    @app.route("/gps")
    def gps_page():
        return render_template("gps_quality.html",
                               airport_icao=cfg.AIRPORT_ICAO,
                               nacp_threshold=cfg.GPS_NACP_THRESHOLD,
                               nic_threshold=getattr(cfg, "GPS_NIC_THRESHOLD", 6))

    @app.route("/gps-episodes")
    def gps_episodes_page():
        return render_template("gps_episodes.html",
                               airport_icao=cfg.AIRPORT_ICAO,
                               airport_lat=cfg.WINDSHEAR_AIRPORT_LAT,
                               airport_lon=cfg.WINDSHEAR_AIRPORT_LON,
                               receiver_lat=cfg.RECEIVER_LAT,
                               receiver_lon=cfg.RECEIVER_LON,
                               episode_radius_nm=getattr(cfg, "GPS_EPISODE_RADIUS_NM", 100.0),
                               coverage_edge_nm=getattr(cfg, "GPS_EPISODE_EDGE_NM", 130.0))

    # ── Overlay file server ────────────────────────────────────────────────
    # Serves GeoJSON files from the project-level overlays/ directory.
    # Used by the windshear map to load ILS centrelines and airport outlines.

    _OVERLAYS_DIR = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "overlays",
    )

    @app.route("/overlays/<path:filename>")
    def overlay_file(filename):
        return send_from_directory(_OVERLAYS_DIR, filename)

    # ── Live state API ────────────────────────────────────────────────────

    @app.route("/api/live/state")
    def live_state_api():
        """Return a snapshot of all currently tracked aircraft as JSON."""
        with live_lock:
            data = list(live_state.values())
        # Age-filter: only include aircraft seen in last 5 minutes
        now = time.time()
        data = [d for d in data if now - d.get("last_seen", 0) < 300]
        return jsonify(data)

    @app.route("/api/live/stream")
    def live_stream():
        """
        Server-Sent Events endpoint.
        Pushes the full aircraft list every 3 seconds.
        """
        wind_max_age = float(getattr(cfg, "WIND_MAX_AGE_SEC", 6.0))

        def generate():
            while True:
                try:
                    with live_lock:
                        data = list(live_state.values())
                    now = time.time()
                    data = [d for d in data if now - d.get("last_seen", 0) < 300]

                    # Slim down payload — only fields needed by the map
                    slim = []
                    for ac in data:
                        slim.append({
                            "icao":     ac.get("icao"),
                            "callsign": ac.get("callsign"),
                            "registration":  ac.get("registration"),
                            "aircraft_type": ac.get("aircraft_type"),
                            "lat":      ac.get("lat"),
                            "lon":      ac.get("lon"),
                            "altitude": ac.get("altitude"),
                            "groundspeed": ac.get("groundspeed"),
                            "track":    ac.get("track"),
                            "vert_rate": ac.get("vert_rate"),
                            "meteo_source": ac.get("meteo_source", "NONE"),
                            "best_wind_spd":  ac.get("best_wind_spd"),
                            "best_wind_dir":  ac.get("best_wind_dir"),
                            "best_temp":      ac.get("best_temp"),
                            "best_pressure":  ac.get("best_pressure"),
                            "mrar_fom":       ac.get("mrar_fom"),
                            "mrar_humidity":   ac.get("mrar_humidity"),
                            "mrar_turbulence": ac.get("mrar_turbulence"),
                            "hdg_off":        ac.get("hdg_off"),
                            "hdg_src":        ac.get("hdg_src"),
                            # computed wind from replies older than
                            # WIND_MAX_AGE_SEC (measured higher / lower up):
                            # not added to the aircraft's Skew-T profile
                            "wind_stale": bool(ac.get("meteo_source") == "COMPUTED"
                                               and ac.get("wind_ts") is not None
                                               and now - ac["wind_ts"] > wind_max_age),
                            "last_seen": ac.get("last_seen"),
                        })

                    yield f"data: {json.dumps(slim)}\n\n"
                    time.sleep(3)
                except GeneratorExit:
                    break
                except Exception as exc:
                    log.debug("SSE error: %s", exc)
                    break

        return Response(
            stream_with_context(generate()),
            mimetype="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )

    # ── Aircraft detail API ───────────────────────────────────────────────

    @app.route("/api/live/aircraft/<icao>")
    def aircraft_detail(icao: str):
        """Recent observations for one aircraft (last 30 minutes, live)."""
        icao = icao.upper()
        db = get_db()
        cutoff = time.time() - 1800
        rows = db.execute(
            """SELECT ts, lat, lon, altitude, groundspeed, track, vert_rate,
                      meteo_source, best_wind_spd, best_wind_dir,
                      best_temp, best_pressure,
                      mrar_wind_spd, mrar_wind_dir, mrar_temp, mrar_pressure,
                      mrar_humidity, mrar_turbulence, mrar_fom,
                      wind_spd, wind_dir, wind_qual
               FROM observations
               WHERE icao = ? AND ts > ?
               ORDER BY ts DESC LIMIT 500""",
            (icao, cutoff),
        ).fetchall()
        return jsonify([dict(r) for r in rows])

    @app.route("/api/aircraft/<icao>/wind_history")
    def aircraft_wind_history(icao: str):
        """
        Wind + temp profile for the aircraft's current flight session.
        Used by the live map to pre-seed the mini Skew-T when an aircraft
        is selected, so the profile is immediately populated from the DB
        rather than building from scratch in real-time.
        Returns rows ordered oldest→newest (ascending ts).
        """
        icao = icao.upper()
        db   = get_db()

        # Find the most recent flight session for this ICAO
        flight = db.execute(
            "SELECT id FROM flights WHERE icao = ? ORDER BY last_seen DESC LIMIT 1",
            (icao,),
        ).fetchone()
        if not flight:
            return jsonify([])

        # Temperature: Mach/TAS temperature also for rows stored before it was
        # recorded (computed from their TAS and Mach), see collector/atmos.py
        from collector.atmos import TEMP_SQL
        rows = db.execute(
            f"""SELECT ts, altitude, lat, lon, best_wind_spd, best_wind_dir,
                       {TEMP_SQL} AS best_temp
                FROM observations
                WHERE flight_id = ?
                  AND altitude IS NOT NULL
                  AND (best_wind_spd IS NOT NULL OR {TEMP_SQL} IS NOT NULL)
                ORDER BY ts ASC""",
            (flight["id"],),
        ).fetchall()
        return jsonify([dict(r) for r in rows])

    # ── Flights browser API ───────────────────────────────────────────────

    @app.route("/api/flights")
    def flights_api():
        """Paginated flight list with optional filters."""
        db   = get_db()
        page = max(1, int(request.args.get("page", 1)))
        per  = min(100, int(request.args.get("per", 50)))
        icao = request.args.get("icao", "").upper().strip()
        call = request.args.get("callsign", "").upper().strip()
        only_meteo = request.args.get("meteo", "0") == "1"

        where = ["1=1"]
        params: list = []

        if icao:
            where.append("icao LIKE ?")
            params.append(f"%{icao}%")
        if call:
            where.append("callsign LIKE ?")
            params.append(f"%{call}%")
        if only_meteo:
            where.append("meteo_count > 0")

        where_sql = " AND ".join(where)
        offset     = (page - 1) * per

        total = db.execute(
            f"SELECT COUNT(*) FROM flights WHERE {where_sql}", params
        ).fetchone()[0]

        # ORDER BY flights.last_seen: a bare last_seen would mean the text
        # alias below, which cannot use the index (every flight sorted)
        rows = db.execute(
            f"""SELECT id, icao, callsign,
                       datetime(first_seen, 'unixepoch') AS first_seen,
                       datetime(last_seen,  'unixepoch') AS last_seen,
                       max_altitude, min_altitude, obs_count, meteo_count
                FROM flights WHERE {where_sql}
                ORDER BY flights.last_seen DESC
                LIMIT ? OFFSET ?""",
            params + [per, offset],
        ).fetchall()

        return jsonify({
            "total": total,
            "page":  page,
            "per":   per,
            "flights": [dict(r) for r in rows],
        })

    @app.route("/api/flights/<int:flight_id>")
    def flight_detail(flight_id: int):
        """Full observation track for one historical flight."""
        db = get_db()
        flight = db.execute(
            "SELECT * FROM flights WHERE id = ?", (flight_id,)
        ).fetchone()
        if not flight:
            return jsonify({"error": "not found"}), 404

        obs = db.execute(
            """SELECT ts, lat, lon, altitude, groundspeed, track, vert_rate,
                      meteo_source, best_wind_spd, best_wind_dir,
                      best_temp, best_pressure,
                      mrar_wind_spd, mrar_wind_dir, mrar_temp, mrar_pressure,
                      mrar_turbulence, mrar_fom,
                      wind_spd, wind_dir, wind_qual
               FROM observations WHERE flight_id = ?
               ORDER BY ts ASC""",
            (flight_id,),
        ).fetchall()

        return jsonify({
            "flight":       dict(flight),
            "observations": [dict(r) for r in obs],
        })

    # ── Wind map API ─────────────────────────────────────────────────────

    @app.route("/api/windmap")
    def windmap_api():
        """
        Gridded wind map for a chosen flight level, altitude tolerance,
        time window and grid cell size (web/api/windmap.py).

        Query params:
          fl        — flight level (e.g. 350 for FL350), default 350
          tolerance — ±ft band around FL centre altitude, default 1000
          cell      — grid cell size in km (5–300), default 50
                      (old param grid = degrees of latitude, converted)
          window    — minutes back from now (mutually exclusive with start/end)
          start     — period start as Unix timestamp
          end       — period end   as Unix timestamp
          gnss_ok   — 1: leave out rows inside GPS degradation episodes
          meps      — 1: add the MEPS model at the level, averaged into the
                      same cells ("meps", collector/meps.py map_cells)
        """
        from web.api.windmap import build_windmap, period_qnh, KM_PER_DEG_LAT

        fl        = int(request.args.get("fl",        350))
        tolerance = max(100, min(5000, int(request.args.get("tolerance", 1000))))
        if "cell" in request.args:
            cell_km = float(request.args["cell"])
        elif "grid" in request.args:
            cell_km = float(request.args["grid"]) * KM_PER_DEG_LAT
        else:
            cell_km = 50.0
        cell_km = max(5.0, min(300.0, cell_km))
        gnss_ok = request.args.get("gnss_ok", "0") in ("1", "true", "yes")

        now = time.time()
        if "start" in request.args and "end" in request.args:
            start_ts = float(request.args["start"])
            end_ts   = float(request.args["end"])
        else:
            window_min = int(request.args.get("window", 60))
            end_ts     = now
            start_ts   = now - window_min * 60

        # QNH for the low-altitude pressure-altitude correction: the current
        # METAR (cache filled by the wx thread) for a recent period, else the
        # METAR stored with the hourly profile archive nearest to its middle
        db = get_db()
        qnh, qnh_src = period_qnh(db, start_ts, end_ts, now, _qnh_cache["hpa"],
                                  _qnh_cache["updated"] > 0)
        result = build_windmap(db, fl, tolerance, start_ts, end_ts, cell_km,
                               qnh_hpa=qnh, qnh_source=qnh_src,
                               center_lat=cfg.RECEIVER_LAT, center_lon=cfg.RECEIVER_LON,
                               gnss_ok=gnss_ok)
        if request.args.get("meps", "0") in ("1", "true", "yes"):
            _add_meps(db, [result], cell_km)
        return jsonify(result)

    def _add_meps(db, maps, cell_km):
        """MEPS model cells for each Wind Map (frame) answer."""
        from collector import meps as _meps
        for m in maps:
            try:
                m["meps"] = _meps.map_cells(db, m["alt_query_ft"], m["start_ts"], m["end_ts"], cell_km,
                                            cfg.RECEIVER_LAT, cfg.RECEIVER_LON)
            except Exception as exc:                 # noqa: BLE001
                log.warning("MEPS map cells failed: %s", exc)
                m["meps"] = None

    @app.route("/api/windmap/frames")
    def windmap_frames_api():
        """
        All frames of the Wind Map time slider in one request: n maps of the
        same period length, the newest ending at `end`, each an hour earlier
        than the next (web/api/windmap.py build_windmap_frames — one query;
        each frame is identical to /api/windmap for its period).

        Query params: fl, tolerance, cell, gnss_ok as /api/windmap;
          end     — end of the newest frame (Unix timestamp)
          period  — period length in seconds (60 … 86 400)
          n       — number of frames (1 … 48)
          meps    — 1: each frame with the MEPS model cells (as /api/windmap)
        The answer is gzip-compressed when the browser accepts it.
        """
        import gzip as _gzip
        from web.api.windmap import (build_windmap_frames, period_qnh,
                                     FRAMES_MAX, FRAMES_MAX_PERIOD_S)

        fl        = int(request.args.get("fl", 350))
        tolerance = max(100, min(5000, int(request.args.get("tolerance", 1000))))
        cell_km   = max(5.0, min(300.0, float(request.args.get("cell", 50.0))))
        gnss_ok   = request.args.get("gnss_ok", "0") in ("1", "true", "yes")
        now       = time.time()
        end_ts    = float(request.args.get("end", now))
        period_s  = max(60.0, min(float(FRAMES_MAX_PERIOD_S),
                                  float(request.args.get("period", 3 * 3600))))
        n         = max(1, min(FRAMES_MAX, int(request.args.get("n", 24))))
        db = get_db()
        qcur, qok = _qnh_cache["hpa"], _qnh_cache["updated"] > 0
        result = build_windmap_frames(
            db, fl, tolerance, end_ts, period_s, n, cell_km,
            qnh_of=lambda s, e: period_qnh(db, s, e, now, qcur, qok),
            center_lat=cfg.RECEIVER_LAT, center_lon=cfg.RECEIVER_LON, gnss_ok=gnss_ok)
        if request.args.get("meps", "0") in ("1", "true", "yes"):
            _add_meps(db, result["frames"], cell_km)
        resp = jsonify(result)
        if "gzip" in (request.headers.get("Accept-Encoding") or "").lower():
            resp.set_data(_gzip.compress(resp.get_data(), compresslevel=5))
            resp.headers["Content-Encoding"] = "gzip"
            resp.headers["Vary"] = "Accept-Encoding"
        return resp

    # ── Weather page: MEPS surface maps (web/api/weather.py) ──────────────

    @app.route("/api/weather/index")
    def weather_index_api():
        """The stored weather-map hours [[ts, run, lead], …] and their grid."""
        from web.api import weather as _wx
        return jsonify(_wx.index(get_db()))

    @app.route("/api/weather/frames")
    def weather_frames_api():
        """The fields of the hours ?ts=t1,t2,… (at most 96) on the grid
        ?step=1 (10 km), 2 (20 km, default) or 4 (40 km), ?fields=p,r,s,…
        (default p,r,s,c); gzip-compressed when the browser accepts it."""
        import gzip as _gzip
        from web.api import weather as _wx
        try:
            ts = [int(float(t)) for t in (request.args.get("ts") or "").split(",") if t.strip()]
            step = int(request.args.get("step", 2))
        except ValueError:
            return jsonify({"error": "bad ts or step"}), 400
        fields = [f for f in (request.args.get("fields") or "").split(",") if f] or None
        resp = jsonify(_wx.frames(get_db(), ts, step, fields))
        if "gzip" in (request.headers.get("Accept-Encoding") or "").lower():
            resp.set_data(_gzip.compress(resp.get_data(), compresslevel=5))
            resp.headers["Content-Encoding"] = "gzip"
            resp.headers["Vary"] = "Accept-Encoding"
        return resp

    @app.route("/api/radar/latest")
    def radar_latest_api():
        """The newest FMI radar composite (rain rate, web/api/radar.py): fetched
        on demand at most every 5 min and shared by all viewers; rainy cells
        only ("rs" = [index, mm/h × 100, …]) on its ETRS-TM35FIN grid."""
        import gzip as _gzip
        from web.api import radar as _radar
        resp = jsonify(_radar.latest())
        if "gzip" in (request.headers.get("Accept-Encoding") or "").lower():
            resp.set_data(_gzip.compress(resp.get_data(), compresslevel=5))
            resp.headers["Content-Encoding"] = "gzip"
            resp.headers["Vary"] = "Accept-Encoding"
        return resp

    # ── What's new (top bar window) ───────────────────────────────────────

    @app.route("/api/whatsnew")
    def whatsnew_api():
        """Version (v.DDMMYYYY), the user notes of the newest versions from
        doc/whats_new.md and the user guides of doc/guides.md (web/whats_new.py):
        {"version", "entries": [{"version", "date", "title", "lines"}],
         "guides": [{"title", "file", "url", "version", "date", "pages", "size", "lines", "open"}]}."""
        from web import whats_new
        return jsonify({"version": whats_new.version(), "entries": whats_new.entries(),
                        "guides": whats_new.guides()})

    @app.route("/doc/<name>")
    def guide_pdf(name):
        """A user guide PDF — only the files listed in doc/guides.md."""
        from web import whats_new
        path = whats_new.guide_file(name)
        if not path:
            abort(404)
        return send_from_directory(os.path.dirname(path), os.path.basename(path),
                                   mimetype="application/pdf")

    # ── Sounding API ──────────────────────────────────────────────────────

    @app.route("/api/sounding")
    def sounding_api():
        """
        Aggregate meteo observations within SOUNDING_RADIUS_KM of receiver
        over the last SOUNDING_WINDOW_MIN minutes (or ?minutes=, 10–360),
        in altitude layers with the Mach/TAS temperature; ?moist=1 adds the
        trial moisture indicator ("moisture").
        """
        from web.api.sounding import build_sounding
        minutes = request.args.get("minutes", type=int)
        result = build_sounding(cfg, get_db(), minutes,
                                moist=request.args.get("moist") == "1")
        return jsonify(result)

    @app.route("/api/lowlevel")
    def lowlevel_api():
        """Airport low-level profile: the 200 ft band profiles of the landings
        and departures of the last ?minutes= (10–360, default 60) pooled
        (web/api/lowlevel.py); ?end=<Unix s> ends the window at that time
        instead of now (Sounding page: hourly archive / flight)."""
        from web.api.lowlevel import lowlevel_profile
        end = request.args.get("end", type=float)
        if end is not None and not (0 < end <= time.time() + 3600):
            end = None
        return jsonify(lowlevel_profile(get_db(), request.args.get("minutes", 60, type=int), now=end))

    @app.route("/api/sondes")
    def sondes_api():
        """Stored radiosonde soundings (collector/sondes.py, FMI open data):
        {station, fetch, last_fetch, items: [{key, nominal, launch, min_p, n, …}]}
        newest first."""
        from collector import sondes as _sondes
        st = _sondes.get()
        if st is None:
            return jsonify({"station": None, "fetch": False, "items": []})
        lf = st.last_fetch
        return jsonify({"station": st.place, "fetch": st.enabled, "keep_days": st.keep_days,
                        "last_fetch": {"ts": lf[0], "result": lf[1]} if lf else None,
                        "items": st.items()})

    @app.route("/api/sonde")
    def sonde_api():
        """One radiosonde sounding for the Skew-T: ?key=YYYYMMDDHH, or ?at=<Unix s>
        (newest launched at or before that time, at most ?max_age_h=36 h older),
        default the latest.  {found: false} when there is none.  With
        ?have=KEY:N_RAW and that copy still current: {found, unchanged, key}."""
        from collector import sondes as _sondes
        st = _sondes.get()
        if st is None:
            return jsonify({"found": False})
        key = request.args.get("key")
        if not key:
            at = request.args.get("at", type=float)
            key = st.find(at, request.args.get("max_age_h", 36.0, type=float))
        # ?have=KEY:N_RAW — the client already shows this copy: answer briefly
        # when it is still the one to show (light polling from the Live Map)
        have = request.args.get("have")
        if key and have:
            meta = next((m for m in st.items() if m["key"] == key), None)
            if meta and have == f"{key}:{meta.get('n_raw')}":
                return jsonify({"found": True, "unchanged": True, "key": key})
        rec = st.load(key) if key else None
        if rec is None:
            return jsonify({"found": False, "station": st.place})
        return jsonify({"found": True, "key": rec["key"], "src": rec.get("src"),
                        "station": rec.get("station") or st.place, "wmo": rec.get("wmo"),
                        "nominal": rec.get("nominal"), "launch": rec.get("launch"),
                        "end": rec.get("end"), "min_p": rec.get("min_p"),
                        "n_raw": rec.get("n_raw"), "lat": rec.get("lat"), "lon": rec.get("lon"),
                        "qc": (rec.get("qc") or {}).get("reason"),
                        "levels": _sondes.levels_for_chart(rec)})

    @app.route("/api/windmap/xsection")
    def windmap_xsection_api():
        """Vertical cross-section along a line (web/api/windmap.py
        build_xsection): ?lat1&lon1&lat2&lon2&start&end, optional width (km,
        default 50), step (km, default 25), gnss_ok=1."""
        from web.api.windmap import build_xsection
        a = request.args
        try:
            lat1, lon1, lat2, lon2 = (float(a[k]) for k in ("lat1", "lon1", "lat2", "lon2"))
            start, end = float(a["start"]), float(a["end"])
        except (KeyError, ValueError):
            return jsonify({"error": "lat1, lon1, lat2, lon2, start and end are required"}), 400
        if end <= start or end - start > 7 * 86400:
            return jsonify({"error": "bad period"}), 400
        width = max(10.0, min(150.0, a.get("width", 50.0, type=float)))
        step = max(10.0, min(100.0, a.get("step", 25.0, type=float)))
        return jsonify(build_xsection(get_db(), lat1, lon1, lat2, lon2, start, end, width, step,
                                      a.get("gnss_ok", "0") in ("1", "true"), cfg.RECEIVER_LAT))

    @app.route("/api/gnss/calibration")
    def gnss_calibration_api():
        """Current calibration of the GNSS heights of the pressure surfaces
        (collector/gnss_heights.py): fleet correction per 5 000 ft band,
        soundings / pairs used, per-airframe offsets (airframe_list with
        registration / type, by_type)."""
        from collector import gnss_heights as _gh
        from collector import aircraft_db as _adb
        db = get_db()
        try:
            typ = {r[0]: r[1] for r in db.execute("SELECT icao, typ FROM heading_cal")}
        except Exception:                                # noqa: BLE001
            typ = {}

        def info(icao):
            reg, t = _adb.lookup(icao)
            return reg, t or typ.get(icao)
        return jsonify(_gh.summary(_gh.current(db, max_age=0), info))

    # ── MEPS model profiles (collector/meps.py, MET Norway open data) ─────────

    @app.route("/api/meps/profile")
    def meps_profile_api():
        """MEPS area-mean profile for the Skew-T at ?at=<Unix s> (default now),
        linear in time between the stored hours: {found, run, lead, provisional,
        levels: [{pressure, temp, dewpoint, wind_dir, wind_spd, z_m, rh}], …}."""
        from collector import meps as _meps
        import time as _t
        at = request.args.get("at", type=float) or _t.time()
        return jsonify(_meps.profile(get_db(), at))

    @app.route("/api/meps/check")
    def meps_check_api():
        """Mode S minus MEPS over the last ?days= (1–90, default 7), every hour
        by pressure level, and the distance check at the soundings; ?busy=N
        only hours with at least N aircraft (default 0)."""
        from collector import meps as _meps
        from collector import sondes as _sondes
        days = max(1.0, min(90.0, request.args.get("days", 7, type=float)))
        busy = max(0, min(100, request.args.get("busy", 0, type=int)))
        return jsonify(_meps.check(get_db(), days, cfg.RECEIVER_LAT, cfg.RECEIVER_LON,
                                   cfg.SOUNDING_RADIUS_KM, busy=busy, store=_sondes.get()))

    @app.route("/api/sonde/verification")
    def sonde_verification_api():
        """Mode S area profile vs radiosonde (collector/sonde_verif.py) over the
        last ?days= (1–366, default 30): pooled launch statistics, per band,
        difference vs sounding age, and the list of verified launches."""
        from collector import sonde_verif as _sv
        days = max(1.0, min(366.0, request.args.get("days", 30, type=float)))
        return jsonify(_sv.summary(get_db(), days))

    @app.route("/api/sounding/hours")
    def sounding_hours_api():
        """Hours stored in the hourly profile archive (profile_hours) for a
        UTC date: ?date=YYYY-MM-DD → [{ts, n}, …]."""
        import re as _re
        from web.api.sounding import list_profile_hours
        date = request.args.get("date", "")
        if not _re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            return jsonify({"error": "date must be YYYY-MM-DD"}), 400
        return jsonify(list_profile_hours(get_db(), date))

    @app.route("/api/sounding/hour")
    def sounding_hour_api():
        """Area sounding of one completed UTC hour from profile_hours:
        ?ts=<hour start, Unix epoch>; ?moist=1 adds the trial moisture
        indicator of the hour ("moisture")."""
        from web.api.sounding import build_hour_sounding
        ts = request.args.get("ts", type=int)
        if ts is None:
            return jsonify({"error": "ts required"}), 400
        result = build_hour_sounding(
            get_db(), ts,
            moist_at=((cfg.RECEIVER_LAT, cfg.RECEIVER_LON, cfg.SOUNDING_RADIUS_KM)
                      if request.args.get("moist") == "1" else None))
        return jsonify(result), (404 if "error" in result else 200)

    @app.route("/api/sounding/timeheight")
    def sounding_timeheight_api():
        """Time–height cross-section from the hourly profile archive:
        ?hours=72 (6–336) &end=<Unix s, default now> → one column per UTC hour
        (web/api/sounding.py build_time_height)."""
        from web.api.sounding import build_time_height
        now = time.time()
        end = request.args.get("end", type=float) or now
        hours = request.args.get("hours", 72, type=int)
        return jsonify(build_time_height(get_db(), min(end, now + 3600), hours,
                                         cfg.RECEIVER_LAT, cfg.RECEIVER_LON,
                                         cfg.SOUNDING_RADIUS_KM, now=now,
                                         kin_radius_km=float(getattr(cfg, "KINEMATICS_RADIUS_KM", 200))))

    @app.route("/api/flights/<int:flight_id>/sounding")
    def flight_sounding_api(flight_id: int):
        """Skew-T profile for a single flight, binned by altitude."""
        try:
            from web.api.sounding import build_flight_sounding
            result = build_flight_sounding(flight_id, get_db())
            if "error" in result:
                return jsonify(result), 404
            return jsonify(result)
        except Exception as exc:
            log.exception("Error building flight sounding for flight %d", flight_id)
            return jsonify({"error": str(exc)}), 500

    @app.route("/api/flights/suitable_soundings")
    def suitable_soundings_api():
        """
        Flights suitable for a per-flight sounding:
        meteo_count > 0 AND altitude range > 5 000 ft.
        """
        db = get_db()
        rows = db.execute(
            """SELECT id, icao, callsign,
                      datetime(first_seen, 'unixepoch') AS first_seen,
                      datetime(last_seen,  'unixepoch') AS last_seen,
                      max_altitude, min_altitude, meteo_count
               FROM flights
               WHERE meteo_count > 0
                 AND max_altitude IS NOT NULL
                 AND min_altitude IS NOT NULL
                 AND (max_altitude - min_altitude) > 5000
               ORDER BY flights.last_seen DESC
               LIMIT 200"""
        ).fetchall()
        return jsonify([dict(r) for r in rows])

    # ── Stats API ─────────────────────────────────────────────────────────

    @app.route("/api/stats")
    def stats_api():
        """Live aircraft counters for the navbar (polled every 15 s per tab).

        RAM-only.  The former database totals (total_flights, total_obs,
        meteo_obs_last_hour) were never displayed but cost a full COUNT(*)
        scan of the observations table on every poll; the Maintenance page
        shows table sizes when needed.
        """
        now = time.time()

        with live_lock:
            n_live = sum(
                1 for d in live_state.values()
                if now - d.get("last_seen", 0) < 300
            )
            n_meteo_live = sum(
                1 for d in live_state.values()
                if now - d.get("last_seen", 0) < 300
                and d.get("meteo_source", "NONE") != "NONE"
            )

        return jsonify({
            "live_aircraft":    n_live,
            "live_with_meteo":  n_meteo_live,
        })

    # ── Heading calibration API (collector/heading_cal.py) ──────────────────

    @app.route("/api/heading_cal")
    def heading_cal_api():
        """Per-airframe heading offsets learnt from the data: mode, counts,
        fleet and aircraft-type medians, and (unless ?airframes=0) one entry
        per airframe (offset °, flights, samples, status A / X / learning).
        RAM only."""
        from collector import heading_cal
        hc = heading_cal.get()
        if hc is None:
            return jsonify({"mode": "off"})
        inc = request.args.get("airframes", "1") not in ("0", "false", "no")
        return jsonify(hc.summary(include_airframes=inc))

    # ── Windshear approach state API ──────────────────────────────────────

    @app.route("/api/windshear/state")
    def windshear_state_api():
        """
        Return all aircraft currently tracked as being on approach within
        WINDSHEAR_RADIUS_NM of the configured airport and below
        WINDSHEAR_MAX_ALT_FT.

        Data is maintained in RAM by the background windshear sweep thread
        and requires no database access.  Includes a rolling 10-minute
        position history for each aircraft (used by the ILS profile graph).
        """
        if ws_tracker is None:
            return jsonify([])
        return jsonify(ws_tracker.get_state())

    @app.route("/api/windshear/approach-history")
    def windshear_approach_history_api():
        """
        Return landed approach history as a JSON list, newest first.

        Optional query parameters (mutually exclusive; window takes precedence):
          window — time window in seconds (e.g. 10800 for 3 h).
                   When present the response is sourced from the persistent
                   approach_history DB table so data survives server restarts.
                   When absent the in-RAM list is returned (backward compat).
          date   — calendar date in YYYY-MM-DD format (UTC).
                   Returns all approaches whose date_utc matches exactly.
                   Ignored when window is also supplied.

        Each entry contains: ts, time_utc, callsign, icao, registration,
        aircraft_type, runway, rwy_heading, and a bands dict keyed by altitude
        (ft as string) with {dir, spd} values or null when no wind was captured.
        DB-sourced entries also carry "gnss" (GNSS quality on final per band,
        see collector/windshear.py _capture_gnss) and "rough" (approach
        roughness per altitude segment + METAR wind, see _rough_record), or
        null for older rows, and "cond" — the provisional approach-conditions
        index computed from "rough" (collector/approach_cond.py; null when
        there is not enough data), and "prof" (from 2026-10-09: per 200-ft
        band averaged wind with n / SD, headwind component and Mach/TAS
        temperature; null for older rows), and "shear" (from 2026-10-24: the
        windshear report of the landing, collector/shear.py; null when the
        landing had too few replies or no raw series is left).
        """
        import json as _json
        window = request.args.get("window", type=int)
        date   = request.args.get("date", type=str)   # YYYY-MM-DD or None
        if window is not None:
            # The panel asks for at most 1 d; cap so a hand-typed URL cannot
            # pull years of rows (with their JSON columns) into one response
            window = max(60, min(window, 31 * 86400))
            cutoff = time.time() - window
            db     = get_db()
            rows   = db.execute(
                """SELECT ts, time_utc, icao, callsign, registration,
                          aircraft_type, runway, rwy_heading, bands_json, go_arounds,
                          gnss_json, rough_json, prof_json, shear_json
                   FROM approach_history
                   WHERE ts > ?
                   ORDER BY ts DESC""",
                (cutoff,),
            ).fetchall()
            result = []
            for row in rows:
                r = dict(row)
                r["bands"] = _json.loads(r.pop("bands_json"))
                g_txt = r.pop("gnss_json", None)
                r["gnss"] = _json.loads(g_txt) if g_txt else None
                rg_txt = r.pop("rough_json", None)
                r["rough"] = _json.loads(rg_txt) if rg_txt else None
                pf_txt = r.pop("prof_json", None)
                r["prof"]  = _json.loads(pf_txt) if pf_txt else None
                sh_txt = r.pop("shear_json", None)
                r["shear"] = _json.loads(sh_txt) if sh_txt else None
                r["cond"]  = approach_index(r["rough"], r.get("aircraft_type"))
                r.setdefault("go_arounds", 0)
                result.append(r)
            return jsonify(result)
        if date is not None:
            # Validate format loosely: expect YYYY-MM-DD
            import re as _re
            if not _re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
                return jsonify({"error": "date must be YYYY-MM-DD"}), 400
            db   = get_db()
            rows = db.execute(
                """SELECT ts, time_utc, icao, callsign, registration,
                          aircraft_type, runway, rwy_heading, bands_json, go_arounds,
                          gnss_json, rough_json, prof_json, shear_json
                   FROM approach_history
                   WHERE date_utc = ?
                   ORDER BY ts DESC""",
                (date,),
            ).fetchall()
            result = []
            for row in rows:
                r = dict(row)
                r["bands"] = _json.loads(r.pop("bands_json"))
                g_txt = r.pop("gnss_json", None)
                r["gnss"] = _json.loads(g_txt) if g_txt else None
                rg_txt = r.pop("rough_json", None)
                r["rough"] = _json.loads(rg_txt) if rg_txt else None
                pf_txt = r.pop("prof_json", None)
                r["prof"]  = _json.loads(pf_txt) if pf_txt else None
                sh_txt = r.pop("shear_json", None)
                r["shear"] = _json.loads(sh_txt) if sh_txt else None
                r["cond"]  = approach_index(r["rough"], r.get("aircraft_type"))
                r.setdefault("go_arounds", 0)
                result.append(r)
            return jsonify(result)
        # No window or date param — serve from RAM (backward compat / internal use)
        if ws_tracker is None:
            return jsonify([])
        return jsonify([
            {**e, "cond": approach_index(e.get("rough"), e.get("aircraft_type"))}
            for e in ws_tracker.get_approach_history()
        ])

    @app.route("/api/windshear/approach-history/clear", methods=["POST"])
    def windshear_approach_history_clear_api():
        """
        Clear the landed approach history.

        Clears both the in-RAM list and the persistent DB table so that
        the panel stays empty on a page refresh after clearing.
        """
        if ws_tracker is not None:
            ws_tracker.clear_approach_history()
        db = get_db()
        db.execute("DELETE FROM approach_history")
        db.execute("DELETE FROM approach_series")
        db.commit()
        return jsonify({"ok": True})

    @app.route("/api/windshear/windrose-obs")
    def windshear_windrose_obs_api():
        """
        Return the rolling 30-minute windrose observation buffer as a JSON list.

        Each entry is a low-altitude wind observation harvested from a recently
        landed approach (alt ≤ 2 000 ft, valid non-NONE meteo source).  Used
        by the windshear page on initial load to pre-populate the windrose widget
        with data from approaches that occurred before the browser session started.

        Returns a list of dicts with keys:
          ts   — Unix timestamp (float seconds since epoch) of harvest
          dir  — wind direction (°)
          spd  — wind speed (kt)
          alt  — altitude at observation (ft)

        Data is RAM-only; cleared on server restart.
        """
        if ws_tracker is None:
            return jsonify([])
        return jsonify(ws_tracker.get_windrose_obs())

    @app.route("/api/gps/episodes")
    def gps_episodes_api():
        """GPS degradation episodes (gps_episodes table) for the GPS Episodes page.

        Query params (one of):
          window — seconds back from now (default 86400, max 31 days)
          date   — UTC calendar day YYYY-MM-DD (episodes starting that day)
        Each episode carries all table columns plus two derived fields:
          end_class   — end_reason, except "lost" at or beyond the receiver
                        coverage edge (end_dist_nm ≥ GPS_EPISODE_EDGE_NM,
                        default 130 NM) → "edge" (left coverage while
                        degraded, not necessarily a GPS loss)
          start_edge  — true when the episode started within 3 NM of the
                        episode radius, i.e. the aircraft was most likely
                        already degraded when it entered the radius
        """
        import re as _re
        radius = float(getattr(cfg, "GPS_EPISODE_RADIUS_NM", 100.0))
        edge   = float(getattr(cfg, "GPS_EPISODE_EDGE_NM", 130.0))
        date   = request.args.get("date", type=str)
        if date:
            if not _re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
                return jsonify({"error": "date must be YYYY-MM-DD"}), 400
            import calendar as _cal
            y, m, d = (int(x) for x in date.split("-"))
            t0 = _cal.timegm((y, m, d, 0, 0, 0))
            t1 = t0 + 86400
        else:
            window = request.args.get("window", default=86400, type=int)
            window = max(600, min(window, 31 * 86400))
            t1 = time.time() + 60
            t0 = time.time() - window
        db = get_db()
        try:
            rows = db.execute(
                """SELECT * FROM gps_episodes
                   WHERE t_start >= ? AND t_start < ?
                   ORDER BY t_start DESC LIMIT 5000""",
                (t0, t1),
            ).fetchall()
        except Exception as exc:          # table missing on a very old DB
            log.warning("gps_episodes query failed: %s", exc)
            rows = []
        out = []
        for row in rows:
            e = dict(row)
            ec = e.get("end_reason")
            if ec == "lost" and (e.get("end_dist_nm") or 0) >= edge:
                ec = "edge"
            e["end_class"]  = ec
            e["start_edge"] = (e.get("start_dist_nm") or 0) >= radius - 3.0
            out.append(e)
        return jsonify({"episodes": out, "radius_nm": radius, "edge_nm": edge,
                        "t0": t0, "t1": t1})

    @app.route("/api/gps/state")
    def gps_state_api():
        """
        Return GPS quality monitoring data as JSON.

        Data is maintained in RAM by the background GPS quality sweep thread.
        No database access required.  Returns:
          live        — aircraft currently showing degraded GPS
          time_series — hourly event buckets, up to 6 months (range selector)
          heatmap     — most recent 31 days of hourly buckets with FL-band
                        breakdown (canvas only ever renders the last 14 days)
          fl_bands    — ordered FL band labels
          stats       — 24-hour summary counts
        """
        if gps_tracker is None:
            return jsonify({
                "live": [], "time_series": [], "heatmap": [],
                "fl_bands": [], "stats": {}, "zone": "all",
            })
        zone = request.args.get("zone", "all")
        if zone not in ("all", "50nm", "20nm"):
            zone = "all"
        return jsonify(gps_tracker.get_state(zone=zone))

    @app.route("/api/gps/detail")
    def gps_detail_api():
        """10-minute slots, severity split and spoofing indicators for the
        GPS Quality page (recorded since 2026-10-09).

        ?zone=all|50nm|20nm (default all), ?hours=N (1 – 744, default 24).
        Completed hours are read from the database once per hour and cached
        in RAM; the hour in progress comes from the live tracker.
        """
        if gps_tracker is None:
            return jsonify({"slots": [], "hours": [], "severity": {}, "spoof": {}, "since": None})
        zone = request.args.get("zone", "all")
        if zone not in ("all", "50nm", "20nm"):
            zone = "all"
        try:
            hours = int(request.args.get("hours", 24))
        except ValueError:
            hours = 24
        return jsonify(gps_tracker.get_detail(zone=zone, hours=hours))

    # ── Weather (METAR / TAF) proxy ───────────────────────────────────────

    @app.route("/api/wx")
    def wx_api():
        """Return cached METAR and TAF served by the background wx_poll thread.

        The response is instantaneous — no live NOAA fetch on each request.
        If a source has never been fetched (server just started) the
        "[unavailable]" sentinel is used for backward-compatibility with the
        existing JS display logic.  Once the first fetch succeeds, transient
        NOAA failures are invisible: the last good value stays cached.
        """
        with _wx_cache_lock:
            data = dict(_wx_cache)

        # Substitute [unavailable] for any source that has never been fetched.
        if data["metar"] is None:
            data["metar"] = "[unavailable]"
        if data["taf"] is None:
            data["taf"] = "[unavailable]"

        # Add cache age so callers can detect very stale data if needed.
        age = time.time() - data["fetched_at"] if data["fetched_at"] > 0 else None
        data["cache_age_s"] = round(age) if age is not None else None

        # QNH fallback: use _qnh_cache if wx_cache has not set one yet.
        if data.get("qnh_hpa") is None:
            data["qnh_hpa"] = _qnh_cache["hpa"] if _qnh_cache["updated"] > 0 else None
        # Airport elevation (ft) for the station pressure / ground line of the
        # Live Map Skew-T (threshold elevation, EFHK 179 ft)
        data["elev_ft"] = float(getattr(cfg, "WINDSHEAR_THR_ELEVATION_FT", 179.0))

        return jsonify(data)

    # ── Maintenance page ──────────────────────────────────────────────────

    def _check_maint_auth(username: str, password: str) -> bool:
        """Validate credentials against MAINTENANCE_AUTH_FILE (username:password,
        the password in clear or hashed; web/users.py)."""
        try:
            return web_users.check_maint(cfg, username, password)
        except Exception:                          # noqa: BLE001
            return False

    def _maint_auth_required(data: dict) -> bool:
        return _check_maint_auth(
            data.get("username", ""),
            data.get("password", ""),
        )

    @app.route("/maintenance")
    def maintenance_page():
        return render_template("maintenance.html")

    @app.route("/api/maintenance/stats", methods=["POST"])
    def maintenance_stats():
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        conn = get_db()
        return jsonify(maint.get_stats(conn, cfg.DB_PATH))

    @app.route("/api/maintenance/flight/preview", methods=["POST"])
    def maintenance_flight_preview():
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        days = int(data.get("days", 30))
        return jsonify(maint.preview_flight_purge(get_db(), days))

    @app.route("/api/maintenance/flight/purge", methods=["POST"])
    def maintenance_flight_purge():
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        days = int(data.get("days", 30))
        return jsonify(maint.purge_flight_data(get_db(), days))

    @app.route("/api/maintenance/flight/autopurge", methods=["POST"])
    def maintenance_flight_autopurge():
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        enabled = bool(data.get("enabled", False))
        days    = int(data.get("days", 30))
        maint.set_autopurge_config(get_db(), enabled, days)
        out = {"ok": True, "enabled": enabled, "days": days}
        if "archive" in data:                 # "Archive before purge" (database/archive.py)
            from database import archive as _arc
            _arc.set_enabled(get_db(), bool(data.get("archive")))
            out["archive"] = bool(data.get("archive"))
        return jsonify(out)

    @app.route("/api/maintenance/flight/autopurge-config", methods=["POST"])
    def maintenance_autopurge_config():
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        from database import archive as _arc
        out = maint.get_autopurge_config(get_db())
        out["archive"] = _arc.is_enabled(get_db())
        return jsonify(out)

    # ── Web users (web/users.py; maintenance login only) ──────────────────

    @app.route("/api/maintenance/users/list", methods=["POST"])
    def maintenance_users_list():
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        return jsonify(web_users.list_users(cfg))

    @app.route("/api/maintenance/users/<action>", methods=["POST"])
    def maintenance_users_change(action):
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        target = str(data.get("target", ""))
        pw = data.get("new_password", "")
        try:
            if action == "add":
                web_users.add_user(cfg, target, pw)
                kind = "user"
            elif action == "password":
                kind = web_users.set_password(cfg, target, pw)
            elif action == "remove":
                web_users.remove_user(cfg, target)
                kind = "user"
            else:
                abort(404)
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        except OSError as exc:
            log.warning("Users file not written: %s", exc)
            return jsonify({"ok": False, "error": "the file could not be written (permissions?)"}), 500
        out = web_users.list_users(cfg)
        out.update(ok=True, kind=kind)
        return jsonify(out)

    # ── Archive files and snapshots (database/archive.py) ─────────────────

    @app.route("/api/maintenance/archive/list", methods=["POST"])
    def maintenance_archive_list():
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        from database import archive as _arc
        db = get_db()
        return jsonify({"status": _arc.get_status(db), "files": _arc.list_archives(db)})

    @app.route("/api/maintenance/archive/snapshot", methods=["POST"])
    def maintenance_archive_snapshot():
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        from database import archive as _arc
        return jsonify(_arc.create_snapshot(cfg.DB_PATH))

    @app.route("/api/maintenance/gps/preview", methods=["POST"])
    def maintenance_gps_preview():
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        days = int(data.get("days", 90))
        return jsonify(maint.preview_gps_purge(get_db(), days))

    @app.route("/api/maintenance/gps/purge", methods=["POST"])
    def maintenance_gps_purge():
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        days   = int(data.get("days", 90))
        result = maint.purge_gps_data(get_db(), days)
        # Reload in-RAM cache so the GPS Quality page reflects the purge immediately
        if gps_tracker is not None:
            gps_tracker.reload_from_db()
        return jsonify(result)

    # ── Date-range purge routes ───────────────────────────────────────────

    @app.route("/api/maintenance/flight/date-preview", methods=["POST"])
    def maintenance_flight_date_preview():
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        try:
            return jsonify(maint.preview_flight_date_purge(
                get_db(), data.get("date_from", ""), data.get("date_to", "")
            ))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

    @app.route("/api/maintenance/flight/date-purge", methods=["POST"])
    def maintenance_flight_date_purge():
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        try:
            return jsonify(maint.purge_flight_date_range(
                get_db(), data.get("date_from", ""), data.get("date_to", "")
            ))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

    @app.route("/api/maintenance/gps/date-preview", methods=["POST"])
    def maintenance_gps_date_preview():
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        try:
            return jsonify(maint.preview_gps_date_purge(
                get_db(), data.get("date_from", ""), data.get("date_to", "")
            ))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

    @app.route("/api/maintenance/gps/date-purge", methods=["POST"])
    def maintenance_gps_date_purge():
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        try:
            result = maint.purge_gps_date_range(
                get_db(), data.get("date_from", ""), data.get("date_to", "")
            )
            if gps_tracker is not None:
                gps_tracker.reload_from_db()
            return jsonify(result)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

    # ── Approach history purge routes ─────────────────────────────────────

    @app.route("/api/maintenance/approach/preview", methods=["POST"])
    def maintenance_approach_preview():
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        days = int(data.get("days", 90))
        return jsonify(maint.preview_approach_purge(get_db(), days))

    @app.route("/api/maintenance/approach/purge", methods=["POST"])
    def maintenance_approach_purge():
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        days   = int(data.get("days", 90))
        result = maint.purge_approach_data(get_db(), days)
        if ws_tracker is not None:
            ws_tracker.clear_approach_history()
        return jsonify(result)

    @app.route("/api/maintenance/approach/date-preview", methods=["POST"])
    def maintenance_approach_date_preview():
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        try:
            return jsonify(maint.preview_approach_date_purge(
                get_db(), data.get("date_from", ""), data.get("date_to", "")
            ))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

    @app.route("/api/maintenance/approach/date-purge", methods=["POST"])
    def maintenance_approach_date_purge():
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        try:
            result = maint.purge_approach_date_range(
                get_db(), data.get("date_from", ""), data.get("date_to", "")
            )
            if ws_tracker is not None:
                ws_tracker.clear_approach_history()
            return jsonify(result)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

    # ── GPS degradation episode log purge routes ─────────────────────────

    @app.route("/api/maintenance/episodes/preview", methods=["POST"])
    def maintenance_episodes_preview():
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        days = int(data.get("days", 365))
        return jsonify(maint.preview_episode_purge(get_db(), days))

    @app.route("/api/maintenance/episodes/purge", methods=["POST"])
    def maintenance_episodes_purge():
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        days = int(data.get("days", 365))
        return jsonify(maint.purge_episode_data(get_db(), days))

    @app.route("/api/maintenance/episodes/date-preview", methods=["POST"])
    def maintenance_episodes_date_preview():
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        try:
            return jsonify(maint.preview_episode_date_purge(
                get_db(), data.get("date_from", ""), data.get("date_to", "")
            ))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

    @app.route("/api/maintenance/episodes/date-purge", methods=["POST"])
    def maintenance_episodes_date_purge():
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        try:
            return jsonify(maint.purge_episode_date_range(
                get_db(), data.get("date_from", ""), data.get("date_to", "")
            ))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

    return app
