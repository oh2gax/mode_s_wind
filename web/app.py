"""
Flask application factory and SSE live-stream endpoint.

Basic HTTP authentication is enforced on every request via a before_request
hook.  Credentials come from Config.WEB_USER / WEB_PASS.
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
    jsonify, stream_with_context, send_from_directory,
)

from config import Config
from database.db import get_db

log = logging.getLogger("modes.web")

# ── QNH cache ─────────────────────────────────────────────────────────────
# Populated each time /api/wx is called; shared between requests.
# Falls back to ISA standard (1013.25 hPa) if no METAR has been fetched yet.
_qnh_cache: dict = {"hpa": 1013.25, "station": None, "updated": 0.0}


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

    Returns None if no recognisable wind group is found.
    """
    import re
    # Variable wind: VRBssKT
    m = re.search(r"\bVRB(\d{2,3})KT\b", metar_text)
    if m:
        return {"dir": None, "spd": int(m.group(1)), "variable": True}
    # Calm: 00000KT
    m = re.search(r"\b00000KT\b", metar_text)
    if m:
        return {"dir": 0, "spd": 0, "variable": False}
    # Normal: DDDssKT or DDDssGggKT (gusts ignored)
    m = re.search(r"\b(\d{3})(\d{2,3})(?:G\d+)?KT\b", metar_text)
    if m:
        return {"dir": int(m.group(1)), "spd": int(m.group(2)), "variable": False}
    return None


def _check_auth(username: str, password: str, cfg: Config) -> bool:
    return username == cfg.WEB_USER and password == cfg.WEB_PASS


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
        return {
            "meteo_source_mode": cfg.METEO_SOURCE_MODE,
            "storage_mode":      cfg.STORAGE_MODE,
        }

    # ── Authentication ────────────────────────────────────────────────────

    @app.before_request
    def require_login():
        auth = request.authorization
        if not auth or not _check_auth(auth.username, auth.password, cfg):
            return _require_auth()

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
                               nacp_threshold=cfg.GPS_NACP_THRESHOLD)

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

        rows = db.execute(
            """SELECT ts, altitude, lat, lon, best_wind_spd, best_wind_dir, best_temp
               FROM observations
               WHERE flight_id = ?
                 AND altitude IS NOT NULL
                 AND (best_wind_spd IS NOT NULL OR best_temp IS NOT NULL)
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

        rows = db.execute(
            f"""SELECT id, icao, callsign,
                       datetime(first_seen, 'unixepoch') AS first_seen,
                       datetime(last_seen,  'unixepoch') AS last_seen,
                       max_altitude, min_altitude, obs_count, meteo_count
                FROM flights WHERE {where_sql}
                ORDER BY last_seen DESC
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
        time window and grid resolution.

        Query params:
          fl        — flight level (e.g. 350 for FL350), default 350
          tolerance — ±ft band around FL centre altitude, default 1000
          grid      — grid cell size in degrees, default 0.5
          window    — minutes back from now (mutually exclusive with start/end)
          start     — period start as Unix timestamp
          end       — period end   as Unix timestamp
        """
        from web.api.windmap import build_windmap

        fl        = int(request.args.get("fl",        350))
        tolerance = int(request.args.get("tolerance", 1000))
        grid      = float(request.args.get("grid",    0.5))

        now = time.time()
        if "start" in request.args and "end" in request.args:
            start_ts = float(request.args["start"])
            end_ts   = float(request.args["end"])
        else:
            window_min = int(request.args.get("window", 60))
            end_ts     = now
            start_ts   = now - window_min * 60

        # Pass current QNH for low-altitude pressure-altitude correction.
        # The cache is populated by /api/wx; falls back to ISA 1013.25 hPa
        # until the first METAR fetch completes.
        qnh = _qnh_cache["hpa"]
        result = build_windmap(get_db(), fl, tolerance, start_ts, end_ts, grid,
                               qnh_hpa=qnh)
        return jsonify(result)

    # ── Sounding API ──────────────────────────────────────────────────────

    @app.route("/api/sounding")
    def sounding_api():
        """
        Aggregate meteo observations within SOUNDING_RADIUS_KM of receiver
        over the last SOUNDING_WINDOW_MIN minutes, binned by pressure level.
        """
        from web.api.sounding import build_sounding
        result = build_sounding(cfg, get_db())
        return jsonify(result)

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
               ORDER BY last_seen DESC
               LIMIT 200"""
        ).fetchall()
        return jsonify([dict(r) for r in rows])

    # ── Stats API ─────────────────────────────────────────────────────────

    @app.route("/api/stats")
    def stats_api():
        """Quick summary counters for the dashboard header."""
        db = get_db()
        now = time.time()
        one_hour_ago = now - 3600

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

        total_flights = db.execute("SELECT COUNT(*) FROM flights").fetchone()[0]
        total_obs     = db.execute("SELECT COUNT(*) FROM observations").fetchone()[0]
        meteo_obs_1h  = db.execute(
            "SELECT COUNT(*) FROM observations WHERE ts > ? AND meteo_source != 'NONE'",
            (one_hour_ago,),
        ).fetchone()[0]

        return jsonify({
            "live_aircraft":    n_live,
            "live_with_meteo":  n_meteo_live,
            "total_flights":    total_flights,
            "total_obs":        total_obs,
            "meteo_obs_last_hour": meteo_obs_1h,
        })

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

        Optional query parameter:
          window — time window in seconds (e.g. 10800 for 3 h).
                   When present the response is sourced from the persistent
                   approach_history DB table so data survives server restarts.
                   When absent the in-RAM list is returned (backward compat).

        Each entry contains: ts, time_utc, callsign, icao, registration,
        aircraft_type, runway, rwy_heading, and a bands dict keyed by altitude
        (ft as string) with {dir, spd} values or null when no wind was captured.
        """
        window = request.args.get("window", type=int)
        if window is not None:
            import json as _json
            cutoff = time.time() - window
            db     = get_db()
            rows   = db.execute(
                """SELECT ts, time_utc, icao, callsign, registration,
                          aircraft_type, runway, rwy_heading, bands_json
                   FROM approach_history
                   WHERE ts > ?
                   ORDER BY ts DESC""",
                (cutoff,),
            ).fetchall()
            result = []
            for row in rows:
                r = dict(row)
                r["bands"] = _json.loads(r.pop("bands_json"))
                result.append(r)
            return jsonify(result)
        # No window param — serve from RAM (backward compat / internal use)
        if ws_tracker is None:
            return jsonify([])
        return jsonify(ws_tracker.get_approach_history())

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

    @app.route("/api/gps/state")
    def gps_state_api():
        """
        Return GPS quality monitoring data as JSON.

        Data is maintained in RAM by the background GPS quality sweep thread.
        No database access required.  Returns:
          live        — aircraft currently showing degraded GPS
          time_series — last 24 hourly event buckets
          heatmap     — up to 7 days of hourly buckets with FL-band breakdown
          fl_bands    — ordered FL band labels
          stats       — 24-hour summary counts
        """
        if gps_tracker is None:
            return jsonify({
                "live": [], "time_series": [], "heatmap": [],
                "fl_bands": [], "stats": {},
            })
        return jsonify(gps_tracker.get_state())

    # ── Weather (METAR / TAF) proxy ───────────────────────────────────────

    @app.route("/api/wx")
    def wx_api():
        """Fetch METAR and TAF for the configured airport from NOAA and return
        as JSON.  Runs server-side to avoid browser CORS restrictions."""
        icao = cfg.AIRPORT_ICAO.upper()
        result: dict = {"station": icao, "metar": None, "taf": None}

        sources = {
            "metar": f"https://tgftp.nws.noaa.gov/data/observations/metar/stations/{icao}.TXT",
            "taf":   f"https://tgftp.nws.noaa.gov/data/forecasts/taf/stations/{icao}.TXT",
        }
        for key, url in sources.items():
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "MODE-S-Wind/1.0"})
                with urllib.request.urlopen(req, timeout=6) as resp:
                    raw = resp.read().decode("utf-8", errors="replace").strip()
                # NOAA files: first line is a date/time stamp — skip it
                lines = raw.splitlines()
                result[key] = "\n".join(lines[1:]).strip() if len(lines) > 1 else raw
            except Exception as exc:
                log.warning("WX fetch failed (%s %s): %s", key.upper(), icao, exc)
                result[key] = "[unavailable]"

        # Extract QNH from the METAR and update the module-level cache
        if result.get("metar") and result["metar"] != "[unavailable]":
            qnh = _parse_qnh(result["metar"])
            if qnh is not None:
                _qnh_cache["hpa"]     = qnh
                _qnh_cache["station"] = icao
                _qnh_cache["updated"] = time.time()
                log.debug("QNH cache updated: %.1f hPa from %s METAR", qnh, icao)

        # Include QNH in the response so the windshear page can display it
        result["qnh_hpa"] = _qnh_cache["hpa"] if _qnh_cache["updated"] > 0 else None

        # Parse surface wind from METAR for the Windrose widget
        result["metar_wind"] = None
        if result.get("metar") and result["metar"] != "[unavailable]":
            result["metar_wind"] = _parse_metar_wind(result["metar"])

        return jsonify(result)

    return app
