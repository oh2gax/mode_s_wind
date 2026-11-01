"""
collector/special_traffic.py

Military / government visit log (from 2026-11-01) — research data for the
GNSS interference study, shown only on the Maintenance page (never on the
public pages).

Every aircraft heard by the receiver itself is classified from the
reference data of the daily aircraft database update
(collector/aircraft_db.classify(): plane-alert-db's #CMPG class Mil / Gov /
Pol, otherwise tar1090-db's military flag).  For each military, government
or police aircraft one row per *visit* (continuous presence; a gap of
VISIT_GAP_SEC ends it) is written to special_visits:

  callsign, class, source of the class, operator, ICAO type, description,
  registration, country of the ICAO address block, first / last heard,
  closest distance to the airport (and that position, 0.01°), altitude
  range, sweeps, sweeps with the aircraft's own ADS-B position, sweeps with
  a GNSS degradation signal of the GPS quality tracker, lowest NACp.

Aircraft that tar1090-db marks with a privacy flag (PIA / LADD) are never
logged.  The rows are written at most every FLUSH_SEC in one small commit
(and at shutdown), so the logging adds practically no writes.  Rows older
than mil_log_days (Maintenance page, default 365) are deleted once a day.

Settings (maintenance_config): mil_log_enabled ("1" default), mil_log_days.
"""

from __future__ import annotations

import logging
import math
import threading
import time

from collector import aircraft_db

log = logging.getLogger("modes.special")

VISIT_GAP_SEC = 600.0       # a visit ends after this long without hearing the aircraft
FLUSH_SEC     = 600.0       # closed visits are written at most this often
HEARD_SEC     = 60.0        # only aircraft heard by the own receiver this recently
SETTINGS_SEC  = 300.0
BUF_MAX       = 5_000

_INSERT = """INSERT OR IGNORE INTO special_visits
    (icao, callsign, cls, src, operator, ac_type, descr, registration, country,
     t_first, t_last, min_dist_nm, cl_lat, cl_lon, min_alt, max_alt,
     sweeps, pos_sweeps, deg_sweeps, min_nacp)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"""

# ICAO 24-bit address blocks (ICAO Annex 10 Vol III) — the countries that
# matter around the Baltic, plus the large operators seen over the region.
_BLOCKS = [
    (0xA00000, 0xAFFFFF, "US"), (0x140000, 0x15FFFF, "RU"), (0x400000, 0x43FFFF, "GB"),
    (0x3C0000, 0x3FFFFF, "DE"), (0x380000, 0x3BFFFF, "FR"), (0x300000, 0x33FFFF, "IT"),
    (0x340000, 0x37FFFF, "ES"), (0x440000, 0x447FFF, "AT"), (0x448000, 0x44FFFF, "BE"),
    (0x458000, 0x45FFFF, "DK"), (0x460000, 0x467FFF, "FI"), (0x468000, 0x46FFFF, "GR"),
    (0x470000, 0x477FFF, "HU"), (0x478000, 0x47FFFF, "NO"), (0x480000, 0x487FFF, "NL"),
    (0x488000, 0x48FFFF, "PL"), (0x490000, 0x497FFF, "PT"), (0x498000, 0x49FFFF, "CZ"),
    (0x4A0000, 0x4A7FFF, "RO"), (0x4A8000, 0x4AFFFF, "SE"), (0x4B0000, 0x4B7FFF, "CH"),
    (0x4B8000, 0x4BFFFF, "TR"), (0x4C0000, 0x4C7FFF, "RS"), (0x4CA000, 0x4CAFFF, "IE"),
    (0x4CC000, 0x4CCFFF, "IS"), (0x4D0000, 0x4D03FF, "LU"), (0x500000, 0x5003FF, "SM"),
    (0x502C00, 0x502FFF, "LV"), (0x503C00, 0x503FFF, "LT"), (0x508000, 0x50FFFF, "UA"),
    (0x510000, 0x5103FF, "BY"), (0x511000, 0x5113FF, "EE"), (0x780000, 0x7BFFFF, "CN"),
    (0x840000, 0x87FFFF, "JP"), (0xC00000, 0xC3FFFF, "CA"), (0x7C0000, 0x7FFFFF, "AU"),
    (0x010000, 0x017FFF, "EG"), (0x710000, 0x717FFF, "SA"), (0x896000, 0x896FFF, "AE"),
    (0x06A000, 0x06A3FF, "QA"), (0x738000, 0x73FFFF, "IL"), (0x4C8000, 0x4C83FF, "CY"),
]


def icao_country(icao: str) -> str | None:
    try:
        v = int(icao, 16)
    except (TypeError, ValueError):
        return None
    for lo, hi, cc in _BLOCKS:
        if lo <= v <= hi:
            return cc
    return None


def _dist_nm(lat1, lon1, lat2, lon2) -> float:
    r = math.radians
    a = (math.sin(r(lat2 - lat1) / 2) ** 2
         + math.cos(r(lat1)) * math.cos(r(lat2)) * math.sin(r(lon2 - lon1) / 2) ** 2)
    return 3440.065 * 2 * math.asin(min(1.0, math.sqrt(a)))


def get_settings(conn) -> dict:
    c = {r[0]: r[1] for r in conn.execute(
        "SELECT key, value FROM maintenance_config WHERE key LIKE 'mil_log_%'").fetchall()}
    try:
        days = max(1, min(3650, int(c.get("mil_log_days") or 365)))
    except ValueError:
        days = 365
    return {"enabled": c.get("mil_log_enabled", "1") == "1", "days": days}


def set_settings(conn, enabled: bool | None = None, days: int | None = None) -> dict:
    if enabled is not None:
        conn.execute("INSERT OR REPLACE INTO maintenance_config (key, value) VALUES ('mil_log_enabled', ?)",
                     ("1" if enabled else "0",))
    if days is not None:
        conn.execute("INSERT OR REPLACE INTO maintenance_config (key, value) VALUES ('mil_log_days', ?)",
                     (str(max(1, min(3650, int(days)))),))
    conn.commit()
    return get_settings(conn)


class SpecialTrafficTracker:
    def __init__(self, get_db, airport_lat: float | None, airport_lon: float | None):
        self._get_db = get_db
        self._apt = (airport_lat, airport_lon)
        self._open: dict[str, dict] = {}
        self._buf: list[tuple] = []
        self._lock = threading.Lock()
        self._last_flush = time.time()
        self._last_purge = 0.0
        self._settings = {"enabled": True, "days": 365}
        self._settings_ts = 0.0

    def _refresh_settings(self, now: float) -> None:
        if now - self._settings_ts < SETTINGS_SEC:
            return
        self._settings_ts = now
        try:
            self._settings = get_settings(self._get_db())
        except Exception:
            pass

    def update(self, ac: dict, flags: list[str] | None = None) -> None:
        """One aircraft of the GPS sweep (every 5 s)."""
        now = time.time()
        self._refresh_settings(now)
        if not self._settings["enabled"]:
            return
        icao = (ac.get("icao") or "").upper()
        last_rx = ac.get("last_rx_ts")
        if not icao or last_rx is None or now - last_rx > HEARD_SEC:
            return
        info = aircraft_db.classify(icao)
        if not info or info.get("private") or not info.get("cls"):
            return
        lat, lon, alt = ac.get("lat"), ac.get("lon"), ac.get("altitude")
        dist = None
        if lat is not None and lon is not None and self._apt[0] is not None:
            dist = _dist_nm(self._apt[0], self._apt[1], lat, lon)
        own_pos = (ac.get("last_adsb_pos_ts") or 0) >= now - 10
        nacp = ac.get("nac_p")
        with self._lock:
            v = self._open.get(icao)
            if v is not None and now - v["t_last"] > VISIT_GAP_SEC:
                self._close(icao)
                v = None
            if v is None:
                v = self._open[icao] = {
                    "icao": icao, "cs": None, "cls": info["cls"], "src": info["src"],
                    "op": info.get("operator"), "type": ac.get("aircraft_type") or info.get("type"),
                    "descr": info.get("descr"), "reg": ac.get("registration") or info.get("reg"),
                    "cc": icao_country(icao), "t_first": now, "t_last": now,
                    "dist": None, "cl": (None, None), "amin": None, "amax": None,
                    "n": 0, "npos": 0, "ndeg": 0, "nacp": None}
            v["t_last"] = now
            v["n"] += 1
            cs = (ac.get("callsign") or "").strip()
            if cs and not v["cs"]:
                v["cs"] = cs
            if own_pos:
                v["npos"] += 1
            if flags:
                v["ndeg"] += 1
            if isinstance(nacp, int):
                v["nacp"] = nacp if v["nacp"] is None else min(v["nacp"], nacp)
            if isinstance(alt, (int, float)):
                v["amin"] = alt if v["amin"] is None else min(v["amin"], alt)
                v["amax"] = alt if v["amax"] is None else max(v["amax"], alt)
            if dist is not None and (v["dist"] is None or dist < v["dist"]):
                v["dist"] = dist
                v["cl"] = (round(lat, 2), round(lon, 2))

    def _close(self, icao: str) -> None:
        v = self._open.pop(icao, None)
        if not v:
            return
        self._buf.append((
            v["icao"], v["cs"], v["cls"], v["src"], v["op"], v["type"], v["descr"], v["reg"], v["cc"],
            int(v["t_first"]), int(v["t_last"]),
            round(v["dist"], 1) if v["dist"] is not None else None, v["cl"][0], v["cl"][1],
            int(v["amin"]) if v["amin"] is not None else None,
            int(v["amax"]) if v["amax"] is not None else None,
            v["n"], v["npos"], v["ndeg"], v["nacp"]))
        if len(self._buf) > BUF_MAX:
            del self._buf[:len(self._buf) - BUF_MAX]

    def flush(self, force: bool = False) -> None:
        """Called after every GPS sweep: ends visits not heard for
        VISIT_GAP_SEC and writes the closed ones (at most every FLUSH_SEC;
        force at shutdown closes every open visit as well)."""
        now = time.time()
        with self._lock:
            for icao in [i for i, v in self._open.items()
                         if force or now - v["t_last"] > VISIT_GAP_SEC]:
                self._close(icao)
            if not force and now - self._last_flush < FLUSH_SEC:
                return
            self._last_flush = now
            rows, self._buf = self._buf, []
        purge = now - self._last_purge > 86400
        if not rows and not purge:
            return
        try:
            conn = self._get_db()
            if rows:
                conn.executemany(_INSERT, rows)
            if purge:
                self._last_purge = now
                conn.execute("DELETE FROM special_visits WHERE t_first < ?",
                             (now - self._settings["days"] * 86400,))
            conn.commit()
        except Exception as exc:
            log.warning("Military / government visit log: write failed: %s", exc)
            with self._lock:
                self._buf[:0] = rows

    def open_count(self) -> int:
        return len(self._open)


def summary(conn, days: int = 14, recent: int = 20) -> dict:
    """Daily summary and the most recent visits for the Maintenance page."""
    since = time.time() - days * 86400
    rows = conn.execute("""
        SELECT date(t_first, 'unixepoch') AS d, COUNT(*),
               SUM(cls = 'mil'), SUM(cls IN ('gov', 'pol')),
               MIN(min_dist_nm), SUM(deg_sweeps > 0), COUNT(DISTINCT icao)
        FROM special_visits WHERE t_first >= ? GROUP BY d ORDER BY d DESC""", (since,)).fetchall()
    days_out = [{"day": r[0], "visits": r[1], "mil": r[2] or 0, "gov": r[3] or 0,
                 "closest": r[4], "deg": r[5] or 0, "aircraft": r[6]} for r in rows]
    rec = conn.execute("""
        SELECT t_first, t_last, callsign, cls, src, operator, ac_type, descr, registration, country,
               min_dist_nm, min_alt, max_alt, sweeps, pos_sweeps, deg_sweeps, min_nacp
        FROM special_visits ORDER BY t_first DESC LIMIT ?""", (recent,)).fetchall()
    keys = ("t_first", "t_last", "callsign", "cls", "src", "operator", "ac_type", "descr",
            "registration", "country", "min_dist_nm", "min_alt", "max_alt", "sweeps",
            "pos_sweeps", "deg_sweeps", "min_nacp")
    tot = conn.execute("SELECT COUNT(*), MIN(t_first) FROM special_visits").fetchone()
    return {"days": days_out, "recent": [dict(zip(keys, r)) for r in rec],
            "total": tot[0], "since": tot[1]}


_tracker: SpecialTrafficTracker | None = None


def init(get_db, airport_lat, airport_lon) -> SpecialTrafficTracker:
    global _tracker
    _tracker = SpecialTrafficTracker(get_db, airport_lat, airport_lon)
    return _tracker


def get() -> SpecialTrafficTracker | None:
    return _tracker
