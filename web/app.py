"""
Flask application factory and SSE live-stream endpoint.

Basic HTTP authentication is enforced on every request via a before_request
hook.  Credentials come from Config.WEB_USER / WEB_PASS.
"""

import json
import logging
import queue
import threading
import time
from functools import wraps

from flask import (
    Flask, Response, g, render_template, request,
    jsonify, stream_with_context,
)

from config import Config
from database.db import get_db

log = logging.getLogger("modes.web")


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
                               receiver_lon=cfg.RECEIVER_LON)

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

        result = build_windmap(get_db(), fl, tolerance, start_ts, end_ts, grid)
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

    return app
