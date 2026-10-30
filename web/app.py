"""
Flask application factory and SSE live-stream endpoint.

Basic HTTP authentication is enforced on every request via a before_request
hook; after a login a signed cookie remembers it for 30 days (from 2026-10-28,
web/session_cookie.py), since a phone's browser forgets Basic credentials.  Users: Config.WEB_USER / WEB_PASS, the maintenance user and the users
file managed on the Maintenance page (web/users.py).  Logins, refused
requests and misuse are written to logs/access.log (web/access_log.py).
"""

import ipaddress
import json
import logging
import os
import queue
import secrets
import threading
import time
import urllib.request
from functools import wraps

from flask import (
    Flask, Response, g, render_template, request, url_for,
    jsonify, stream_with_context, send_from_directory, abort, redirect,
    send_file,
)

from config import Config
from database.db import get_db
from database import maintenance as maint
from collector.approach_cond import approach_index
from web import access_log
from web import users as web_users
from web import shared_login
from web import session_cookie
from collector import traffic as _traffic

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

# ── /api/windshear/state: gzip and the ?lite=1 answer (from 2026-10-26) ───
# Fields of an aircraft that the mobile ILS view (static/js/app.js,
# static/js/ils_profile.js) uses; ?lite=1 sends only these.
_WS_LITE_KEYS = ("icao", "callsign", "aircraft_type", "altitude", "vert_rate",
                 "best_wind_spd", "best_wind_dir", "meteo_source", "ap",
                 "in_corridor", "approach_runway", "dist_thr_nm", "last_seen",
                 "barbs", "barbs_hi", "none_hist", "sel_alt")   # sel_alt: MCP / FCU selected altitude (2026-10-30)
# ?lite=1&map=1 (the map of the mobile ILS view, from 2026-10-28): also the
# position and track and a short trail (the last TRAIL_SEC, every 2nd point);
# &near=1 also the other aircraft within WINDSHEAR_RADIUS_NM and below
# WINDSHEAR_MAX_ALT_FT with the fields of their map square and label only —
# from 2026-10-30 taken from live_state (all traffic), not from the windshear
# tracker, which never takes in an aircraft first seen climbing (its entry
# gate) and so had almost no departures.
_WS_MAP_KEYS = ("lat", "lon", "track", "groundspeed")      # groundspeed: speed vectors (2026-10-29)
_WS_NEAR_KEYS = ("icao", "callsign", "aircraft_type", "altitude", "meteo_source",
                 "in_corridor", "lat", "lon", "track", "groundspeed", "last_seen",
                 "dep", "dep_rwy",          # dep: a departure (climb-out), from 2026-10-29
                 "vert_rate", "sel_alt")    # the selected-altitude label (2026-10-30)
_WS_TRAIL_SEC = 120
_WS_NEAR_POS_SEC = 30      # a position older than this is not drawn (e.g. a landed aircraft
                           # still heard on the ground at its last airborne position)
_GZIP_MIN_BYTES = 1024


def _gzip_json(obj):
    """jsonify(obj), gzip-compressed (level 5) when the browser accepts it
    and the body is at least _GZIP_MIN_BYTES."""
    import gzip as _gzip
    resp = jsonify(obj)
    resp.headers["Vary"] = "Accept-Encoding"
    if "gzip" in (request.headers.get("Accept-Encoding") or "").lower():
        body = resp.get_data()
        if len(body) >= _GZIP_MIN_BYTES:
            resp.set_data(_gzip.compress(body, compresslevel=5))
            resp.headers["Content-Encoding"] = "gzip"
    return resp

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

    # ── "MODE-S Wind has moved" (from 2026-10-27) ─────────────────────────
    # SITE_MOVED_URL (config_local.py of the old server, e.g. the home Raspberry
    # Pi): every page and the mobile view /app show a notice pointing to the new
    # address, closable for the day.  SITE_MOVED_HIDE_LAN (default True): not
    # for visitors from the local network (the station's own users at home).
    # SITE_MOVED_REDIRECT (default False): visitors from outside the local
    # network are sent straight to the same page on the new server (pages
    # only — API, static files and the guides answer as before).
    _moved_url = str(getattr(cfg, "SITE_MOVED_URL", "") or "").strip().rstrip("/")
    _moved_host = _moved_url.split("://", 1)[-1]

    def _home_addr(ip: str) -> bool:
        try:
            a = ipaddress.ip_address(ip or "")
            return a.is_private or a.is_loopback or a.is_link_local
        except ValueError:
            return False

    def _site_moved():
        if not _moved_url:
            return None
        if getattr(cfg, "SITE_MOVED_HIDE_LAN", True) and _home_addr(request.remote_addr):
            return None
        return {"url": _moved_url, "host": _moved_host}

    @app.before_request
    def site_moved_redirect():
        if (not _moved_url or not getattr(cfg, "SITE_MOVED_REDIRECT", False)
                or request.method not in ("GET", "HEAD")
                or request.path.startswith(("/api/", "/static/", "/doc/", "/app/manifest"))
                or _home_addr(request.remote_addr)):
            return None
        return redirect(_moved_url + request.full_path.rstrip("?"), code=302)

    # ── Data transfer counters: bytes served to the users (from 2026-10-27,
    # collector/traffic.py) — the body and the headers of every response with
    # a known length; the Live Map's live stream counts its chunks itself
    @app.after_request
    def _count_served(resp):
        try:
            if request.method != "HEAD" and resp.status_code not in (204, 304):
                n = resp.content_length
                if n is not None:
                    _traffic.add("web", n + 17 + sum(len(k) + len(v) + 4 for k, v in resp.headers.items()))
        except Exception:                             # noqa: BLE001
            pass
        return resp

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
            # the shared test login is being phased out (web/shared_login.py):
            # its state for the navbar chip / notice, None for everyone else
            "shared_login":      g.get("shared_state"),
            # SITE_MOVED_URL: the "moved to …" notice, None when not shown
            "site_moved":        _site_moved(),
        }

    # ── Authentication ────────────────────────────────────────────────────

    @app.before_request
    def require_login():
        tr = access_log.tracker
        if tr is not None and tr.is_blocked(request.remote_addr or ""):
            g.auth_state = "blocked"
            return Response("Too many failed logins — try again later.", 429,
                            {"Retry-After": str(int(tr.lock_sec))})
        # The mobile view's home-screen icon and web-app manifest (from
        # 2026-10-26) load without a login: the phone fetches them on its own
        # when "Add to Home Screen" is used; they hold only the name and icon
        if request.endpoint == "app_manifest" or (
                request.endpoint == "static"
                and (request.view_args or {}).get("filename", "") in _PUBLIC_STATIC):
            g.auth_state = "public"
            return None
        auth = request.authorization
        ck = request.cookies.get(session_cookie.COOKIE)
        if not auth:
            # the remembered login (from 2026-10-28): a valid cookie lets the
            # browser in without the Basic credentials it may have forgotten
            cu = session_cookie.check(cfg, ck) if ck else None
            if cu:
                g.auth_state, g.auth_user = "ok", cu[0]
                if session_cookie.needs_renewal(cu[1]):
                    g.login_cookie = cu[0]
                return None
            if ck:
                g.login_cookie_drop = True
            g.auth_state = "none"
            return _require_auth()
        if not _check_auth(auth.username, auth.password, cfg):
            g.auth_state, g.auth_user = "bad", auth.username
            return _require_auth()
        g.auth_state, g.auth_user = "ok", auth.username
        cu = session_cookie.check(cfg, ck) if ck else None
        if not cu or cu[0] != auth.username or session_cookie.needs_renewal(cu[1]):
            g.login_cookie = auth.username              # set / renewed in _login_cookie (users-file users only)
        # The shared test login (config.py WEB_USER) is phased out: a notice
        # during the grace period, no data after the end date
        if shared_login.is_shared(cfg, auth.username):
            st = shared_login.state(cfg)
            g.shared_state = st if st["phase"] != "none" else None
            if st["phase"] == "ended":
                if request.endpoint in ("static", "shared_login_page", "switch_user"):
                    return None
                g.auth_state = "shared_ended"
                if request.endpoint in _PAGE_ENDPOINTS:
                    return render_template("shared_ended.html", st=st), 403
                return jsonify({"error": "the shared test login has ended"}), 403
            if request.method == "GET" and request.endpoint in _PAGE_ENDPOINTS:
                try:
                    shared_login.note_page(cfg)
                except Exception as exc:                  # noqa: BLE001
                    log.debug("shared login usage: %s", exc)

    @app.after_request
    def _login_cookie(resp):
        """Sets or renews the remembered-login cookie (web/session_cookie.py)."""
        try:
            user = g.get("login_cookie")
            if user:
                val = session_cookie.issue(cfg, user)
                if val:
                    resp.set_cookie(session_cookie.COOKIE, val, max_age=session_cookie.MAX_AGE, path="/",
                                    httponly=True, samesite="Lax", secure=request.is_secure)
            elif g.get("login_cookie_drop"):
                resp.delete_cookie(session_cookie.COOKIE, path="/", httponly=True, samesite="Lax",
                                   secure=request.is_secure)
        except Exception as exc:                      # noqa: BLE001
            log.debug("login cookie: %s", exc)
        return resp

    _PAGE_ENDPOINTS = {"index", "flights_page", "sounding_page", "windmap_page", "weather_page",
                       "windshear_page", "gps_page", "gps_episodes_page", "msgstats_page",
                       "maintenance_page", "app_page"}
    _PUBLIC_STATIC = {"icons/app-192.png", "icons/app-512.png", "icons/apple-touch-icon.png"}

    @app.route("/shared-login")
    def shared_login_page():
        """The notice of the shared test login (also after its end)."""
        st = shared_login.state(cfg)
        return render_template("shared_ended.html", st=st), (403 if st["phase"] == "ended" else 200)

    @app.route("/switch-user")
    def switch_user():
        """Makes the browser ask for the login again (basic authentication has
        no logout): the shared login gets 401 until other credentials are
        entered, then the Live Map opens."""
        auth = request.authorization
        if auth is None or shared_login.is_shared(cfg, auth.username):
            return Response("Log in with your personal user name and password.", 401,
                            {"WWW-Authenticate": 'Basic realm="MODE-S Meteo"'})
        from flask import redirect
        return redirect("/")

    # Compact access / misuse log (logs/access.log, see web/access_log.py)
    access_log.init_app(app)

    # ── Page routes ───────────────────────────────────────────────────────

    @app.route("/")
    def index():
        return render_template("live.html",
                               receiver_lat=cfg.RECEIVER_LAT,
                               receiver_lon=cfg.RECEIVER_LON,
                               airport_icao=cfg.AIRPORT_ICAO,
                               # a landed aircraft leaves the map sooner (from 2026-10-29)
                               airport_lat=cfg.WINDSHEAR_AIRPORT_LAT,
                               airport_lon=cfg.WINDSHEAR_AIRPORT_LON)

    @app.route("/flights")
    def flights_page():
        # the airport and the receiver for the flight map (redesigned page, 2026-10-29)
        return render_template("flights.html",
                               airport_icao=cfg.AIRPORT_ICAO,
                               airport_lat=cfg.WINDSHEAR_AIRPORT_LAT,
                               airport_lon=cfg.WINDSHEAR_AIRPORT_LON,
                               receiver_lat=cfg.RECEIVER_LAT,
                               receiver_lon=cfg.RECEIVER_LON)

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

    @app.route("/app")
    def app_page():
        """Mobile view (from 2026-10-26): Skew-T (Area now / hour), Time–height,
        ILS approach and ACI & WS, one at a time, all choices in a ☰ menu
        (static/js/app.js)."""
        from web import whats_new
        return render_template("app.html", receiver_lat=cfg.RECEIVER_LAT,
                               mobile_guide_url=whats_new.guide_url("Mobile_User_Guide.pdf"),
                               airport_lat=cfg.WINDSHEAR_AIRPORT_LAT,
                               airport_lon=cfg.WINDSHEAR_AIRPORT_LON,
                               radius_nm=cfg.WINDSHEAR_RADIUS_NM,
                               thr_elevation_ft=cfg.WINDSHEAR_THR_ELEVATION_FT,
                               gs_offset_ft=cfg.WINDSHEAR_GS_OFFSET_FT)

    @app.route("/app/manifest.webmanifest")
    def app_manifest():
        """Web-app manifest for "Add to Home Screen": opens /app full screen."""
        man = {
            "name": "MODE-S Wind", "short_name": "MODE-S Wind",
            "description": "Aircraft-derived winds and temperatures, Skew-T, time–height and approach conditions",
            "start_url": "/app", "scope": "/app", "display": "standalone", "orientation": "any",
            "background_color": "#0f1923", "theme_color": "#0f1923",
            "icons": [
                {"src": url_for("static", filename="icons/app-192.png"), "sizes": "192x192", "type": "image/png", "purpose": "any maskable"},
                {"src": url_for("static", filename="icons/app-512.png"), "sizes": "512x512", "type": "image/png", "purpose": "any maskable"},
            ],
        }
        return Response(json.dumps(man), mimetype="application/manifest+json")

    @app.route("/stats")
    def msgstats_page():
        """Mode S & ADS-B Statistics page (from 2026-10-25): what the receiver
        hears — downlink formats, ADS-B type codes, Comm-B registers, the reply
        cadence per flight phase, the interrogators (DF11) and the meteo yield."""
        return render_template("stats.html", airport_icao=cfg.AIRPORT_ICAO)

    @app.route("/api/msgstats")
    def msgstats_api():
        """Message statistics of the last `window` minutes (1–60, 1440 for
        24 h or 10080 for 7 d; default 10) plus the 1-h rate series and the
        24-h trend, the signal-level histograms and the range rings
        (collector/msg_stats.py; RAM, and for 7 d also the stored hours of
        msg_stats_hours; the page polls every 10 s).  ?trend=7d adds the 7 d
        chart series per 10 min (trend_week).  gzip-compressed when the
        browser accepts it (from 2026-10-26)."""
        from collector import msg_stats
        try:
            window = int(request.args.get("window", 10))
        except ValueError:
            window = 10
        week_trend = request.args.get("trend") == "7d"
        db = get_db() if (window >= msg_stats.WEEK_MIN or week_trend) else None
        out = msg_stats.get().snapshot(window, db=db, week_trend=week_trend)
        # the Radarcape's own status (systemstatus.json, collector/radarcape_status.py)
        from collector import radarcape_status as _rcs
        rc = _rcs.get()
        out["radarcape"] = rc.public() if rc is not None else None
        return _gzip_json(out)

    @app.route("/api/traffic")
    def traffic_api():
        """Data transfer counters (collector/traffic.py, from 2026-10-27):
        bytes of the Beast stream, the aircraft list, the receiver status, the
        web pages served and the network interface totals — the rate of the
        last minute, today / yesterday / the last 7 days / this month (UTC)
        with a whole-month projection, and the chart bins of ?range=1h (per
        minute), 24h / 7d (per hour) or 30d (per day)."""
        rng = request.args.get("range", "24h")
        if rng not in ("1h", "24h", "7d", "30d"):
            rng = "24h"
        return _gzip_json(_traffic.get().snapshot(rng))

    # System health indicators of the Statistics page (web/api/health.py):
    # evaluated at most every 10 s on request, and every minute in the
    # background so the state changes are recorded while nobody is watching
    from web.api import health as _health

    def _wx_snapshot():
        with _wx_cache_lock:
            return dict(_wx_cache)

    _health.start_thread(cfg, ws_tracker, _wx_snapshot)

    @app.route("/api/health")
    def health_api():
        """System health: 11 indicators (green / amber / red / grey) with a
        plain-language reason and details, and the last 50 state changes."""
        return jsonify(_health.get(cfg, ws_tracker, _wx_snapshot()))

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
                            # the MCP / FCU selected altitude when heard within
                            # 2 min (the Live Map's Full labels, from 2026-10-30)
                            "sel_alt":  (ac.get("sel_alt") if ac.get("sel_alt") is not None
                                         and now - (ac.get("sel_alt_ts") or 0) <= 120 else None),
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
                            # when the position last changed (from 2026-10-29):
                            # a landed aircraft keeps being heard, at its
                            # last position, until its transponder is off
                            "pos_ts":    ac.get("last_pos_update_ts"),
                        })

                    chunk = f"data: {json.dumps(slim)}\n\n"
                    _traffic.add("web", len(chunk.encode("utf-8")) + 8)   # + chunk framing
                    yield chunk
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

    # ── Air traffic for the phone's Weather view (from 2026-10-30) ────────

    @app.route("/api/live/traffic")
    def live_traffic_api():
        """The aircraft heard now with a position, slim and gzip-compressed, for
        the phone's Weather view (polled every 6 s instead of the Live Map's
        stream of the full list every 3 s): {t, ac: [[icao, callsign, type, lat,
        lon, altitude, ground speed, track, vertical rate, selected altitude
        (heard within 2 min, else null), seconds since the position changed]]}.
        Positions older than 60 s are left out."""
        now = time.time()
        with live_lock:
            data = list(live_state.values())
        out = []
        for ac in data:
            lat, lon = ac.get("lat"), ac.get("lon")
            pos_ts = ac.get("last_pos_update_ts") or ac.get("last_seen") or 0
            if lat is None or lon is None or now - pos_ts > 60:
                continue
            sel = ac.get("sel_alt") if (ac.get("sel_alt") is not None
                                        and now - (ac.get("sel_alt_ts") or 0) <= 120) else None
            trk, gs = ac.get("track"), ac.get("groundspeed")
            out.append([ac.get("icao"), ac.get("callsign"), ac.get("aircraft_type"),
                        round(lat, 5), round(lon, 5), ac.get("altitude"),
                        round(gs) if gs is not None else None, round(trk) if trk is not None else None,
                        ac.get("vert_rate"), sel, round(now - pos_ts)])
        return _gzip_json({"t": round(now, 1), "ac": out})

    # ── Hover of the ATC style (from 2026-10-30) ──────────────────────────

    @app.route("/api/live/ac/<icao>")
    def live_ac_hover(icao: str):
        """The latest values heard from one aircraft, for the extended label of
        the ATC style's Hover (Live Map, Windshear map; polled every 2 s only
        while the mouse is on the aircraft).  Read from memory — the live state
        and the receiver's latest Comm-B BDS 5,0 / 6,0 replies — nothing is
        stored.  A register not heard within HOVER_MAX_AGE s is left out (null);
        the selected altitude and the autopilot modes within 2 min."""
        from collector.receiver import get_bds_samples
        from collector.declination import declination as _decl
        HOVER_MAX_AGE = 20.0
        icao = icao.upper()[:6]
        now = time.time()
        with live_lock:
            ac = dict(live_state.get(icao) or {})
        if not ac or now - ac.get("last_seen", 0) > 300:
            return jsonify({"icao": icao, "gone": True}), 404
        b50s, b60s = get_bds_samples(icao, now - HOVER_MAX_AGE)
        r1 = lambda v, n=1: round(v, n) if isinstance(v, (int, float)) else None
        b50 = b60 = None
        if b50s:     # (ts, roll, track_rate, true_track, groundspeed, true_airspeed)
            t, roll, rate, trk, gs, tas = b50s[-1]
            b50 = {"age": r1(now - t), "roll": r1(roll), "rate": r1(rate, 2),
                   "trk": r1(trk), "gs": r1(gs, 0), "tas": r1(tas, 0)}
        if b60s:     # (ts, ias, magnetic_heading, inertial_vr, baro_vr, mach)
            t, ias, mhdg, ivr, bvr, mach = b60s[-1]
            b60 = {"age": r1(now - t), "ias": r1(ias, 0), "mhdg": r1(mhdg),
                   "ivr": r1(ivr, 0), "bvr": r1(bvr, 0), "mach": r1(mach, 3)}
        fresh = lambda k, sec=120.0: now - (ac.get(k) or 0) <= sec
        try:
            decl = _decl(ac.get("lat"), ac.get("lon"), cfg.MAG_DECLINATION)
        except Exception:
            decl = cfg.MAG_DECLINATION
        return jsonify({
            "icao": icao,
            "type": ac.get("aircraft_type"), "reg": ac.get("registration"),
            "sq":   ac.get("squawk"),
            "sel":  ac.get("sel_alt") if fresh("sel_alt_ts") else None,
            "ap":   bool(ac.get("ap")) if fresh("ap_ts") else None,
            "app":  bool(ac.get("ap_app")) if fresh("ap_ts") else None,
            "nacp": ac.get("nac_p") if fresh("nac_p_ts", 30.0) else None,
            "gmb":  ac.get("geo_minus_baro") if fresh("gmb_ts", 30.0) else None,
            "wdir": r1(ac.get("best_wind_dir"), 0), "wspd": r1(ac.get("best_wind_spd"), 0),
            "temp": r1(ac.get("best_temp")),
            "decl": r1(decl),
            "b50": b50, "b60": b60,
        })

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
        """Paginated flight list for the Flights page (redesigned 2026-10-29).

        Query params:
          page, per   — page (1…) and rows per page (≤ 100, default 50)
          q           — one search: callsign, ICAO24 address or registration
                        (registrations from the stored landings / departures
                        and the optional BaseStation.sqb)
          hours       — period back from now (1–720); 0 or missing with no
                        date = all stored flights
          date        — YYYY-MM-DD (UTC day; overrides hours)
          kind        — all · meteo (meteo data) · arr (landed at the airport)
                        · dep (departed) · snd (a climb or descent of over
                        5 000 ft with meteo data: a Skew-T sounding)
          (icao / callsign / meteo=1 of the old page still work)
        Each row has the registration and type when known, and the landing
        ("arr": runway, time, go-arounds, ACI, EDR, windshear level) or the
        departure ("dep") recorded for the flight."""
        import re as _re
        db   = get_db()
        page = max(1, request.args.get("page", 1, type=int) or 1)
        per  = max(10, min(100, request.args.get("per", 50, type=int) or 50))
        q    = (request.args.get("q") or "").upper().strip()[:12]
        kind = request.args.get("kind", "all")
        if request.args.get("meteo") == "1":
            kind = "meteo"
        now  = time.time()

        where: list = []
        params: list = []
        date = request.args.get("date", "")
        hours = request.args.get("hours", 0, type=int) or 0
        if _re.fullmatch(r"\d{4}-\d{2}-\d{2}", date or ""):
            import calendar as _cal
            t0 = _cal.timegm(time.strptime(date, "%Y-%m-%d"))
            where.append("flights.last_seen >= ? AND flights.first_seen < ?")
            params += [t0, t0 + 86400]
        elif hours > 0:
            where.append("flights.last_seen >= ?")
            params.append(now - min(hours, 720) * 3600)

        for key, col in (("icao", "icao"), ("callsign", "callsign")):
            v = (request.args.get(key) or "").upper().strip()[:12]
            if v:
                where.append(f"{col} LIKE ?")
                params.append(f"%{v}%")
        if q:
            # registrations: from the stored landings / departures and BaseStation.sqb
            reg_icaos: set = set()
            if len(q) >= 3:
                for tbl in ("approach_history", "departure_profiles"):
                    for r in db.execute(f"SELECT DISTINCT icao FROM {tbl} WHERE registration LIKE ? LIMIT 50",
                                        (f"%{q}%",)):
                        reg_icaos.add(r[0])
                from collector import aircraft_db
                reg_icaos.update(aircraft_db.icaos_for_reg(q))
            cond = "(callsign LIKE ? OR icao LIKE ?"
            params += [f"%{q}%", f"{q}%"]
            if reg_icaos:
                cond += f" OR icao IN ({','.join('?' * len(reg_icaos))})"
                params += sorted(reg_icaos)
            where.append(cond + ")")

        # the landing: within the flight (its last stored row is 1–3 min
        # before the touchdown); the departure: its climb starts with the flight
        ARR = ("EXISTS (SELECT 1 FROM approach_history a WHERE a.ts BETWEEN flights.first_seen"
               " AND flights.last_seen + 900 AND a.icao = flights.icao)")
        # (d.ts — the climb's top, minutes after its start — for the index)
        DEP = ("EXISTS (SELECT 1 FROM departure_profiles d WHERE d.ts BETWEEN flights.first_seen - 120"
               " AND flights.last_seen + 1800 AND d.t_start BETWEEN flights.first_seen - 120"
               " AND flights.last_seen AND d.icao = flights.icao)")
        SND = "(meteo_count > 0 AND max_altitude - min_altitude > 5000)"
        base_sql = " AND ".join(where) or "1=1"
        cnt = db.execute(
            f"""SELECT COUNT(*), SUM(meteo_count > 0), SUM({ARR}), SUM({DEP}), SUM({SND})
                FROM flights WHERE {base_sql}""", params).fetchone()
        counts = {"all": cnt[0] or 0, "meteo": cnt[1] or 0, "arr": cnt[2] or 0,
                  "dep": cnt[3] or 0, "snd": cnt[4] or 0}
        kind_sql = {"meteo": "meteo_count > 0", "arr": ARR, "dep": DEP, "snd": SND}.get(kind)
        where_sql = base_sql + (f" AND {kind_sql}" if kind_sql else "")
        total = counts.get(kind, counts["all"])

        rows = db.execute(
            f"""SELECT id, icao, callsign, first_seen, last_seen,
                       max_altitude, min_altitude, obs_count, meteo_count
                FROM flights WHERE {where_sql}
                ORDER BY flights.last_seen DESC
                LIMIT ? OFFSET ?""",
            params + [per, (page - 1) * per],
        ).fetchall()
        flights = [_flight_links(db, dict(r)) for r in rows]
        return jsonify({
            "total": total, "page": page, "per": per, "kind": kind,
            "counts": counts, "now": now,
            "flights": flights,
        })

    def _flight_links(db, f: dict, full: bool = False) -> dict:
        """Registration / type and the landing or departure of one flight
        (Flights page, from 2026-10-29)."""
        a = db.execute(
            """SELECT ts, runway, go_arounds, registration, aircraft_type, rough_json,
                      shear_json, edr_json FROM approach_history
               WHERE ts BETWEEN ? AND ? AND icao = ? ORDER BY ts LIMIT 1""",
            (f["first_seen"], f["last_seen"] + 900, f["icao"])).fetchone()
        d = db.execute(
            """SELECT ts, t_start, ga, registration, aircraft_type, shear_json, edr_json
               FROM departure_profiles
               WHERE ts BETWEEN ? AND ? AND t_start BETWEEN ? AND ? AND icao = ?
               ORDER BY t_start LIMIT 1""",
            (f["first_seen"] - 120, f["last_seen"] + 1800, f["first_seen"] - 120, f["last_seen"],
             f["icao"])).fetchone()

        def _j(txt):
            try:
                return json.loads(txt) if txt else None
            except ValueError:
                return None

        def _edr(txt):
            e = _j(txt)
            return round(e["m"], 3) if e and e.get("m") is not None else None

        def _ws(txt):
            sh = _j(txt)
            return sh.get("lvl") if isinstance(sh, dict) else None

        reg = typ = None
        if a:
            cond = approach_index(_j(a["rough_json"]), a["aircraft_type"])
            f["arr"] = {"ts": a["ts"], "rwy": a["runway"], "ga": a["go_arounds"] or 0,
                        "aci": cond.get("idx") if cond else None,
                        "aci_lbl": cond.get("lbl") if cond else None,
                        "edr": _edr(a["edr_json"]), "ws": _ws(a["shear_json"])}
            reg, typ = a["registration"], a["aircraft_type"]
        if d:
            sh = _j(d["shear_json"])
            f["dep"] = {"ts": d["t_start"], "rwy": sh.get("rwy") if isinstance(sh, dict) else None,
                        "ga": d["ga"] or 0, "edr": _edr(d["edr_json"]), "ws": _ws(d["shear_json"])}
            reg, typ = reg or d["registration"], typ or d["aircraft_type"]
        if not reg or not typ:
            from collector import aircraft_db
            r2, t2 = aircraft_db.lookup(f["icao"])
            reg, typ = reg or r2, typ or t2
        f["reg"], f["type"] = reg, typ
        f["snd"] = bool(f.get("meteo_count") and f.get("max_altitude") is not None
                        and f.get("min_altitude") is not None
                        and f["max_altitude"] - f["min_altitude"] > 5000)
        return f

    @app.route("/api/flights/<int:flight_id>")
    def flight_detail(flight_id: int):
        """Full observation track for one historical flight; best_temp is the
        measured or the Mach/TAS temperature (from 2026-10-29, as the other
        pages), with the flight's registration, type and landing / departure."""
        from collector.atmos import TEMP_SQL
        db = get_db()
        flight = db.execute(
            "SELECT * FROM flights WHERE id = ?", (flight_id,)
        ).fetchone()
        if not flight:
            return jsonify({"error": "not found"}), 404

        obs = db.execute(
            f"""SELECT ts, lat, lon, altitude, groundspeed, track, vert_rate,
                      meteo_source, best_wind_spd, best_wind_dir,
                      {TEMP_SQL} AS best_temp, best_pressure,
                      mrar_wind_spd, mrar_wind_dir, mrar_temp, mrar_pressure,
                      mrar_turbulence, mrar_fom,
                      wind_spd, wind_dir, wind_qual,
                      bds50_true_airspeed AS tas, bds60_ias AS ias, bds60_mach AS mach
               FROM observations WHERE flight_id = ?
               ORDER BY ts ASC""",
            (flight_id,),
        ).fetchall()

        return jsonify({
            "flight":       _flight_links(db, dict(flight)),
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
        # ?bbox=lat0,lon0,lat1,lon1 (from 2026-10-30, the phone's Weather view):
        # only the part of the grid over it
        bbox = None
        try:
            b = [float(v) for v in (request.args.get("bbox") or "").split(",") if v.strip()]
            if len(b) == 4 and -90 <= b[0] < b[2] <= 90 and -180 <= b[1] < b[3] <= 180:
                bbox = b
        except ValueError:
            bbox = None
        resp = jsonify(_wx.frames(get_db(), ts, step, fields, bbox))
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
        # no-cache (from 2026-10-28): the browser asks every time whether the
        # PDF has changed (a 304 answer when not) — a new version of a guide is
        # never served from an old cached copy; the links also carry ?v=
        resp = send_from_directory(os.path.dirname(path), os.path.basename(path),
                                   mimetype="application/pdf", max_age=0)
        resp.headers["Cache-Control"] = "no-cache"
        return resp

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
        instead of now (Sounding page: hourly archive / flight).  "bl" (from
        2026-10-29): the airport's boundary layer of that hour — low-level jet
        and surface inversion (collector/boundary.py at()), for the Skew-T marks."""
        from web.api.lowlevel import lowlevel_profile
        end = request.args.get("end", type=float)
        if end is not None and not (0 < end <= time.time() + 3600):
            end = None
        out = lowlevel_profile(get_db(), request.args.get("minutes", 60, type=int), now=end)
        try:
            from collector import boundary as _bl
            out["bl"] = _bl.at(get_db(), end)
        except Exception:                              # noqa: BLE001  (older database)
            out["bl"] = None
        return jsonify(out)

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

    @app.route("/api/meps/winds")
    def meps_winds_api():
        """MEPS wind and temperature at ?fl=<flight level> (10–450) for the
        stored hour nearest to now, on the Wind Map box (± 300 km, 20 km grid),
        for the Live Map weather overlay's wind barbs (collector/meps.py
        level_frame; stored data only, nothing is fetched)."""
        from collector import meps as _meps
        fl = request.args.get("fl", type=int)
        if fl is None or not 10 <= fl <= 450:
            return jsonify({"error": "fl 10–450"}), 400
        return jsonify(_meps.level_frame(get_db(), fl))

    @app.route("/api/meps/check")
    def meps_check_api():
        """Mode S minus MEPS over the last ?days= (1–90, default 7), every hour
        by pressure level, and the distance check at the soundings; ?busy=N
        only hours with at least N aircraft (default 0)."""
        from collector import meps as _meps
        from collector import sondes as _sondes
        from collector import tcorr as _tc
        days = max(1.0, min(90.0, request.args.get("days", 7, type=float)))
        busy = max(0, min(100, request.args.get("busy", 0, type=int)))
        out = dict(_meps.check(get_db(), days, cfg.RECEIVER_LAT, cfg.RECEIVER_LON,
                               cfg.SOUNDING_RADIUS_KM, busy=busy, store=_sondes.get()))
        # the upper-level temperature correction learnt from these differences
        # (collector/tcorr.py; the check itself always compares the raw values)
        out["tcorr"] = _tc.info(_tc.current(get_db()))
        return jsonify(out)

    @app.route("/api/sonde/verification")
    def sonde_verification_api():
        """Mode S area profile vs radiosonde (collector/sonde_verif.py) over the
        last ?days= (1–366, default 30): pooled launch statistics, per band,
        difference vs sounding age, and the list of verified launches."""
        from collector import sonde_verif as _sv
        from collector import tcorr as _tc
        days = max(1.0, min(366.0, request.args.get("days", 30, type=float)))
        out = dict(_sv.summary(get_db(), days))
        # raw Mach/TAS values; the bias the bands would have with the upper-level
        # correction of the Skew-T / time–height (collector/tcorr.py)
        tc = _tc.current(get_db())
        if tc:
            mid = {"20-30k": 25000, "30k+": 36000}
            for b in out.get("bands") or []:
                k = _tc.at_ft(tc, mid.get(b.get("band")))
                if k and b.get("t_bias") is not None:
                    b["t_bias_corr"] = round(b["t_bias"] + k, 2)
            out["tcorr"] = _tc.info(tc)
        return jsonify(out)

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

        From 2026-10-26 the answer is gzip-compressed when the browser accepts
        it (15–60 kB → about a quarter; the Windshear page polls every 3 s,
        the mobile ILS view every 5 s), and ?lite=1 (the mobile ILS view)
        returns only what that view draws: the aircraft in the approach
        corridor with the fields of the strips / profile, their history as
        {ts, altitude, dist_thr} only, and the active alerts (ws_events) —
        no ws_log, ga_events or ws_engine (about 2 kB gzipped with two
        aircraft on the approach).  From 2026-10-28 &map=1 adds each one's
        position, track and `trail` ([lat, lon] of the last 2 min) for the
        mobile view's approach map, and &near=1 the other tracked aircraft
        (within WINDSHEAR_RADIUS_NM) with only the fields of their map square.
        From 2026-10-30 that list is built from live_state — all traffic with a
        position not older than 30 s within WINDSHEAR_RADIUS_NM and below
        WINDSHEAR_MAX_ALT_FT, the departures marked ``dep`` / ``dep_rwy`` from the
        climb-out capture — because the windshear tracker turns away every
        aircraft first seen climbing (its entry gate), so it had almost no
        departures for the map's *Departures: Shown*.
        """
        if ws_tracker is None:
            return jsonify([])
        state = ws_tracker.get_state()
        if request.args.get("lite", "0") in ("1", "true", "yes") and isinstance(state, dict):
            want_map = request.args.get("map") == "1"
            want_near = want_map and request.args.get("near") == "1"
            t_trail = time.time() - _WS_TRAIL_SEC
            acs = []
            for a in state.get("aircraft") or []:
                if not a.get("in_corridor") or a.get("dist_thr_nm") is None:
                    continue
                x = {k: a.get(k) for k in _WS_LITE_KEYS if k in a}
                x["history"] = [{k: h.get(k) for k in ("ts", "altitude", "dist_thr")}
                                for h in a.get("history") or []]
                if want_map:
                    x.update({k: a.get(k) for k in _WS_MAP_KEYS})
                    tr = [h for h in a.get("history") or []
                          if (h.get("ts") or 0) >= t_trail and h.get("lat") is not None]
                    x["trail"] = [[round(h["lat"], 4), round(h["lon"], 4)] for h in tr[::-2][::-1]]
                acs.append(x)
            if want_near:
                acs += _ws_near(set(a["icao"] for a in acs))
            state = {"aircraft": acs, "ws_events": state.get("ws_events") or [], "lite": 1}
        return _gzip_json(state)

    def _ws_near(skip: set) -> list:
        """The other aircraft of the mobile ILS map (from 2026-10-30): all of
        live_state with a fresh position within WINDSHEAR_RADIUS_NM of the
        airport and below WINDSHEAR_MAX_ALT_FT, except those on the approach
        (skip); climb-outs marked dep / dep_rwy (DepartureTracker.following,
        go-arounds excluded)."""
        from collector.windshear import _haversine_nm
        now = time.time()
        lat0, lon0 = cfg.WINDSHEAR_AIRPORT_LAT, cfg.WINDSHEAR_AIRPORT_LON
        r_max = float(cfg.WINDSHEAR_RADIUS_NM)
        alt_max = float(cfg.WINDSHEAR_MAX_ALT_FT)
        deps = {}
        fn = getattr(ws_tracker, "departures_fn", None)
        if fn is not None:
            try:
                deps = fn() or {}
            except Exception:                              # noqa: BLE001
                deps = {}
        with live_lock:
            data = list(live_state.values())
        out = []
        for a in data:
            icao, lat, lon, alt = a.get("icao"), a.get("lat"), a.get("lon"), a.get("altitude")
            if not icao or icao in skip or lat is None or lon is None or alt is None or alt > alt_max:
                continue
            pos_ts = a.get("last_pos_update_ts") or a.get("last_seen") or 0
            if now - pos_ts > _WS_NEAR_POS_SEC or now - (a.get("last_seen") or 0) > _WS_NEAR_POS_SEC:
                continue
            if _haversine_nm(lat0, lon0, lat, lon) > r_max:
                continue
            x = {k: a.get(k) for k in _WS_NEAR_KEYS if k in a and k not in ("dep", "dep_rwy", "sel_alt")}
            if a.get("sel_alt") and now - (a.get("sel_alt_ts") or 0) <= 120:
                x["sel_alt"] = a["sel_alt"]
            x["in_corridor"] = False
            x["meteo_source"] = a.get("meteo_source") or "NONE"
            if icao in deps:
                x["dep"], x["dep_rwy"] = True, deps[icao]
            out.append(x)
        return out

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
        The answer is gzip-compressed when the browser accepts it; ?lite=1
        leaves out gnss / rough / prof and shear.bd (from 2026-10-28).
        A landing after go-arounds carries "ga_ev" (from 2026-10-30): their time,
        runway, altitude and low flag from the go_arounds table (_ga_attach).
        """
        import json as _json

        def _edr_sum(txt):
            """Turbulence (EDR) of the landing without its pieces (from 2026-10-29)."""
            try:
                e = _json.loads(txt) if txt else None
            except ValueError:
                return None
            return {k: e.get(k) for k in ("m", "lo", "hi", "pk", "n", "top")} if e and e.get("m") is not None else None

        def _ga_attach(db, result):
            """The go-arounds before each landing that had any (from 2026-10-30): the
            go_arounds table (from 2026-10-29; run.py _on_go_around) rows of the same
            aircraft in the 2 h before the landing, the newest go_arounds of them, as
            "ga_ev": [{ts, rwy, alt, low}] oldest first — the runway of the go-around
            may differ from the landing runway.  Missing for older landings."""
            for r in result:
                n = r.get("go_arounds") or 0
                if n <= 0:
                    continue
                try:
                    g = db.execute("SELECT ts, runway, alt_ft, low FROM go_arounds "
                                   "WHERE icao = ? AND ts > ? AND ts <= ? ORDER BY ts DESC LIMIT ?",
                                   (r["icao"], r["ts"] - 7200, r["ts"], n)).fetchall()
                except Exception:                      # noqa: BLE001  (older database)
                    return
                if g:
                    r["ga_ev"] = [{"ts": x[0], "rwy": x[1], "alt": x[2], "low": bool(x[3])} for x in reversed(g)]

        def _aph_out(result):
            """gzip-compressed (from 2026-10-28); ?lite=1 (the mobile view /app):
            without the large per-landing details gnss / rough / prof and the
            report's band means — about a third of the size."""
            if request.args.get("lite") == "1":
                for r in result:
                    for k in ("gnss", "rough", "prof"):
                        r.pop(k, None)
                    if isinstance(r.get("shear"), dict):
                        r["shear"] = {k: v for k, v in r["shear"].items() if k != "bd"}
            return _gzip_json(result)

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
                          gnss_json, rough_json, prof_json, shear_json, edr_json
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
                r["edr"]   = _edr_sum(r.pop("edr_json", None))
                r["cond"]  = approach_index(r["rough"], r.get("aircraft_type"))
                r.setdefault("go_arounds", 0)
                result.append(r)
            _ga_attach(db, result)
            return _aph_out(result)
        if date is not None:
            # Validate format loosely: expect YYYY-MM-DD
            import re as _re
            if not _re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
                return jsonify({"error": "date must be YYYY-MM-DD"}), 400
            db   = get_db()
            rows = db.execute(
                """SELECT ts, time_utc, icao, callsign, registration,
                          aircraft_type, runway, rwy_heading, bands_json, go_arounds,
                          gnss_json, rough_json, prof_json, shear_json, edr_json
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
                r["edr"]   = _edr_sum(r.pop("edr_json", None))
                r["cond"]  = approach_index(r["rough"], r.get("aircraft_type"))
                r.setdefault("go_arounds", 0)
                result.append(r)
            _ga_attach(db, result)
            return _aph_out(result)
        # No window or date param — serve from RAM (backward compat / internal use)
        if ws_tracker is None:
            return jsonify([])
        return jsonify([
            {**e, "cond": approach_index(e.get("rough"), e.get("aircraft_type"))}
            for e in ws_tracker.get_approach_history()
        ])

    @app.route("/api/windshear/departures")
    def windshear_departures_api():
        """Departures of the last ?window= seconds (60 s – 1 d, default 3 h) or of
        one UTC ?date=YYYY-MM-DD, with their windshear report (band comparison of
        the climb-out, departure_profiles.shear_json, from 2026-10-24; from
        2026-10-27 also the trial headwind ramps "trial"), newest first:
        [{ts, icao, callsign, aircraft_type, ga, shear: {rwy, hdg, band, lvl,
        trial}}] — for the ACI + WS view of the Windshear page.  ?full=1 (the
        departures view of the Approach History, from 2026-10-27) adds
        registration, time_utc, runway, rwy_heading (the runway direction, else
        the initial track) and the band winds "bands" {ft: {dir, spd, n}} in
        the format of the landings."""
        import json as _json
        import re as _re
        full = request.args.get("full") == "1"
        date = request.args.get("date")
        try:
            if date:
                if not _re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
                    return jsonify({"error": "date must be YYYY-MM-DD"}), 400
                rows = get_db().execute(
                    """SELECT ts, icao, callsign, registration, aircraft_type, ga, track,
                              prof_json, shear_json, edr_json
                       FROM departure_profiles
                       WHERE date(ts, 'unixepoch') = ? ORDER BY ts DESC""", (date,)).fetchall()
            else:
                window = max(60, min(request.args.get("window", 10800, type=int), 86400))
                rows = get_db().execute(
                    """SELECT ts, icao, callsign, registration, aircraft_type, ga, track,
                              prof_json, shear_json, edr_json
                       FROM departure_profiles
                       WHERE ts > ? ORDER BY ts DESC""", (time.time() - window,)).fetchall()
        except Exception:                              # noqa: BLE001  (older database)
            return jsonify([])
        out = []
        for r in rows:
            try:
                sh = _json.loads(r["shear_json"]) if r["shear_json"] else None
            except (TypeError, ValueError):
                sh = None
            try:
                ed = _json.loads(r["edr_json"]) if r["edr_json"] else None
            except (TypeError, ValueError):
                ed = None
            ed = {k: ed.get(k) for k in ("m", "lo", "hi", "pk", "n", "top")} if ed and ed.get("m") is not None else None
            if sh is None and ed is None and not full:
                continue
            e = {"ts": r["ts"], "icao": r["icao"], "callsign": r["callsign"],
                 "aircraft_type": r["aircraft_type"], "ga": r["ga"], "shear": sh, "edr": ed}
            if full:
                try:
                    prof = _json.loads(r["prof_json"]) if r["prof_json"] else {}
                except (TypeError, ValueError):
                    prof = {}
                e.update({
                    "registration": r["registration"],
                    "time_utc": time.strftime("%H:%M", time.gmtime(r["ts"])),
                    "runway": (sh or {}).get("rwy"),
                    "rwy_heading": (sh or {}).get("hdg") if (sh or {}).get("hdg") is not None else r["track"],
                    "bands": {b: {"dir": v["wd"], "spd": v["ws"], "n": v.get("n")}
                              for b, v in (prof or {}).items()
                              if isinstance(v, dict) and v.get("ws") is not None and v.get("wd") is not None},
                })
            out.append(e)
        return _gzip_json(out) if full else jsonify(out)

    @app.route("/api/boundary")
    def boundary_api():
        """The boundary layer at the airport (collector/boundary.py, from
        2026-10-29): the hours of the last ?hours= (1–336, default 24) from
        bl_hours, oldest first, and the hour in progress ("partial": 1) —
        [{ts, w: [[ft, kt, dir, n]], t: [[ft, °C, n]], tt, q, llj, inv}].
        ?end=<Unix s> in the past (Time–height section): the stored hours
        before it only."""
        from collector import boundary as _bl
        try:
            return _gzip_json(_bl.query(get_db(), request.args.get("hours", 24, type=float),
                                        end=request.args.get("end", type=float)))
        except Exception:                              # noqa: BLE001  (older database)
            return jsonify([])

    @app.route("/api/windshear/edr-tracks")
    def windshear_edr_tracks_api():
        """Turbulence (EDR) along the paths of the landings and departures of the
        last ?minutes= (5–180, default 30; from 2026-10-29, collector/edr.py) for
        the mobile ILS map: [{ts, ph ("arr" / "dep"), icao, cs, rwy, m, seg:
        [{e, a: [alt0, alt1], p: [[lat, lon], …]}]}], newest first."""
        import json as _json
        mins = max(5, min(request.args.get("minutes", 30, type=int), 180))
        t0 = time.time() - mins * 60
        out = []
        try:
            db = get_db()
            for ph, sql in (("arr", "SELECT ts, icao, callsign, runway, edr_json FROM approach_history "
                                    "WHERE ts > ? AND edr_json IS NOT NULL"),
                            ("dep", "SELECT ts, icao, callsign, NULL AS runway, edr_json, shear_json "
                                    "FROM departure_profiles WHERE ts > ? AND edr_json IS NOT NULL")):
                for r in db.execute(sql, (t0,)).fetchall():
                    try:
                        e = _json.loads(r["edr_json"])
                    except ValueError:
                        continue
                    if not e or e.get("m") is None:
                        continue
                    rwy = r["runway"]
                    if ph == "dep" and r["shear_json"]:
                        try:
                            rwy = (_json.loads(r["shear_json"]) or {}).get("rwy")
                        except ValueError:
                            pass
                    out.append({"ts": r["ts"], "ph": ph, "icao": r["icao"], "cs": r["callsign"], "rwy": rwy,
                                "m": e.get("m"), "seg": e.get("seg") or []})
        except Exception:                              # noqa: BLE001  (older database)
            return jsonify([])
        out.sort(key=lambda x: -x["ts"])
        return _gzip_json(out)

    @app.route("/api/windshear/spacetime")
    def windshear_spacetime_api():
        """Space–time diagram of the Windshear page (ST view, from 2026-10-27):
        the headwind change of every 200-ft band of every landing and departure
        of the last ?hours= (3 / 6 / 12 / 24, default 12) against the flights of
        the previous 45 min (web/api/spacetime.py); gzip-compressed."""
        from web.api import spacetime as _st
        return _gzip_json(_st.build(get_db(), request.args.get("hours", 12, type=int)))

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
        db.execute("DELETE FROM go_arounds")
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

    @app.route("/api/wx/reports")
    def wx_reports_api():
        """Stored METARs and pilot reports (collector/wx_reports.py, from 2026-10-29).

        ?hours=24 (max 744) or ?date=YYYY-MM-DD (UTC day); ?ws=1 only the METARs
        with a windshear group (with hours=0 and no date: the whole archive);
        ?near=1 only the pilot reports near the airport; ?limit (default 2000).
        """
        import re as _re
        from collector import wx_reports as _wxr
        date = request.args.get("date") or None
        if date and not _re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            return jsonify({"error": "date must be YYYY-MM-DD"}), 400
        try:
            out = _wxr.query(get_db(), (cfg.AIRPORT_ICAO or "").upper(),
                             hours=request.args.get("hours", 24, type=float),
                             date=date, ws_only=request.args.get("ws") == "1",
                             near_only=request.args.get("near") == "1",
                             limit=request.args.get("limit", 2000, type=int))
        except ValueError:
            return jsonify({"error": "bad date"}), 400
        return _gzip_json(out)

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

    @app.route("/api/maintenance/msgstats/purge", methods=["POST"])
    def maintenance_msgstats_purge():
        """Delete the stored Statistics page history (msg_stats_hours)."""
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        return jsonify(maint.purge_msg_stats(get_db()))

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
        out = web_users.list_users(cfg, data.get("password", ""))
        out["shared"] = dict(shared_login.state(cfg), usage=shared_login.usage(cfg))
        return jsonify(out)

    @app.route("/api/maintenance/users/shared", methods=["POST"])
    def maintenance_users_shared():
        """End date of the shared test login: {"expires": "YYYY-MM-DD" | "now" | ""}."""
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        try:
            shared_login.set_expires(cfg, data.get("expires") or None)
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        except OSError as exc:
            log.warning("Shared login file not written: %s", exc)
            return jsonify({"ok": False, "error": "the file could not be written (permissions? MAINTENANCE_AUTH_FILE set?)"}), 500
        out = web_users.list_users(cfg, data.get("password", ""))
        out["shared"] = dict(shared_login.state(cfg), usage=shared_login.usage(cfg))
        out["ok"] = True
        return jsonify(out)

    @app.route("/api/maintenance/users/<action>", methods=["POST"])
    def maintenance_users_change(action):
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        target = str(data.get("target", ""))
        pw = data.get("new_password", "")
        mpw = data.get("password", "")              # the maintenance password: the key of the users' names
        new_mpw = None
        try:
            if action == "add":
                web_users.add_user(cfg, target, pw, data.get("first"), data.get("last"), mpw)
                kind = "user"
            elif action == "password":
                kind = web_users.set_password(cfg, target, pw, mpw)
                if kind == "maintenance":
                    new_mpw = pw
            elif action == "name":
                web_users.set_name(cfg, target, data.get("first"), data.get("last"), mpw)
                kind = "user"
            elif action == "names-reset":
                web_users.reset_names(cfg)
                kind = "user"
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
        out = web_users.list_users(cfg, new_mpw or mpw)
        out["shared"] = dict(shared_login.state(cfg), usage=shared_login.usage(cfg))
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
        return jsonify(_arc.create_snapshot(cfg.DB_PATH, compress=bool(data.get("compress"))))

    # Downloads: the page first asks for a short-lived link with the maintenance
    # login (POST), then the browser fetches the file with a plain GET — the
    # maintenance password never goes into a URL.  The GET still needs the web
    # login (before_request) and comes from the same address.
    _dl_tokens: dict = {}                      # token -> (path, ip, expires)
    _dl_lock = threading.Lock()
    DL_TOKEN_S = 300

    @app.route("/api/maintenance/archive/download-link", methods=["POST"])
    def maintenance_archive_download_link():
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        from database import archive as _arc
        path = _arc.resolve_file(get_db(), data.get("file"))
        if not path:
            return jsonify({"error": "file not found"}), 404
        tok = secrets.token_urlsafe(24)
        now = time.time()
        with _dl_lock:
            for k in [k for k, v in _dl_tokens.items() if v[2] < now]:
                _dl_tokens.pop(k, None)
            _dl_tokens[tok] = (path, request.remote_addr or "", now + DL_TOKEN_S)
        return jsonify({"url": url_for("maintenance_archive_download", token=tok)})

    @app.route("/api/maintenance/archive/download/<token>")
    def maintenance_archive_download(token):
        with _dl_lock:
            ent = _dl_tokens.get(token)
        if not ent or ent[2] < time.time() or ent[1] != (request.remote_addr or ""):
            abort(404)
        path = ent[0]
        if not os.path.isfile(path):
            abort(404)
        log.info("Maintenance download: %s (%.0f MB)",
                 os.path.basename(path), os.path.getsize(path) / 1e6)
        mime = "application/gzip" if path.endswith(".gz") else "application/vnd.sqlite3"
        resp = send_file(path, mimetype=mime, as_attachment=True,
                         download_name=os.path.basename(path), conditional=True,
                         max_age=0)
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.route("/api/maintenance/archive/delete", methods=["POST"])
    def maintenance_archive_delete():
        data = request.get_json(silent=True) or {}
        if not _maint_auth_required(data):
            return jsonify({"error": "Unauthorized"}), 401
        from database import archive as _arc
        return jsonify(_arc.delete_snapshot(get_db(), data.get("file")))

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
