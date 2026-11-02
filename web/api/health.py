"""
web/api/health.py — system health indicators of the Statistics page
(from 2026-10-25).

Thirteen indicators, each green (healthy) / amber (degraded: late, retrying or
on a fallback) / red (fault: stopped, failing or very old) / grey (off):

  feed      Radarcape Beast feed      last frame < 30 s / < 10 min / older
                                      (from 26 Oct 2026: a quiet night has
                                      pauses of several seconds)
  json      Radarcape aircraft list   last good poll < 15 s / failing / > 5 min
  regdb     registration database     BaseStation.sqb (optional, from 29 Oct 2026):
                                      green in use (aircraft, file date, lookups),
                                      grey not installed, amber found but could
                                      not be opened — never red
  rc        Radarcape receiver        its systemstatus.json (every 60 s): GPS
                                      antenna / tracking / 1PPS / timestamp
                                      sync, GPS module temperature (≥ 70 °C
                                      amber, ≥ 85 °C red), receiver settings,
                                      software restart, read ≤ 5 / 15 min
  decode    decoding / meteo          winds while EHS aircraft are heard (judged
                                      only with ≥ DECODE_MIN_EHS of them: at
                                      night 2–4 aircraft are interrogated too
                                      rarely for 5,0 / 6,0 pairs)
  db        database & jobs           batch writes, hourly jobs, purge check,
                                      memory clean-up
  ws        windshear engine          sweep running (every 3 s)
  gps       GPS quality               sweep running
  meps      MEPS model                newest stored run ≤ 9 h and a profile hour
                                      within 1.5 h of now (never red: the
                                      system works without the model)
  sondes    soundings                 newest Jokioinen sounding ≤ 15 h / 30 h
  calib     calibrations              temperature correction learnt from MEPS
                                      within 3 h (else the stored values are in
                                      use), heading calibration; amber when the
                                      magnetic declination model (pygeomag) is
                                      missing or out of date (from 27 Oct 2026)
  metar     METAR / QNH               observation ≤ 75 min / 3 h
  pi        Raspberry Pi / Server     CPU temperature (amber from 72 °C, back
                                      to green below 68 °C), under-voltage /
                                      throttling, free memory, disk, load —
                                      always of the computer this server runs
                                      on: labelled "Pi" on a Raspberry Pi,
                                      "Server" elsewhere (e.g. the cloud
                                      server; from 28 Oct 2026)

Plus: a background thread of the server that has stopped turns its indicator
red.  The reasons are plain language for all users; error details stay in the
log.  Everything is read from RAM or from small, cached queries (the MEPS
newest run and the temperature correction: 60 s); one evaluation takes a few
milliseconds.  The state changes (last 50) are kept in RAM for the detail
panel, evaluated every 60 s by a small thread even when nobody has the page
open, and logged.
"""

from __future__ import annotations

DECODE_MIN_EHS = 8            # EHS aircraft in 10 min before "no / few winds" is judged
PI_HOT_ON, PI_HOT_OFF = 72.0, 68.0     # °C: amber on / off (hysteresis: no flapping at 70 °C)
_pi_hot = {"on": False}

import calendar
import logging
import os
import re
import shutil
import threading
import time

from collector import health as hb
from collector import wx_reports as _wxr

log = logging.getLogger("modes.health")

ORDER = ("feed", "json", "regdb", "rc", "decode", "db", "ws", "gps", "meps", "sondes", "mast", "calib", "metar", "pi")
LABEL = {"feed": "Feed", "json": "Aircraft list", "regdb": "Reg. DB", "rc": "Radarcape", "decode": "Decoding", "db": "Database",
         "ws": "Windshear", "gps": "GPS", "meps": "MEPS", "sondes": "Soundings", "mast": "Mast",
         "calib": "Calibrations", "metar": "METAR", "pi": "Pi"}
TITLE = {"feed": "Radarcape Beast feed (Mode S messages)",
         "json": "Radarcape aircraft list (MLAT positions, registrations)",
         "regdb": "Aircraft registration database BaseStation.sqb (optional: registrations and types "
                  "of the aircraft that the receiver's list has none for)",
         "rc": "Radarcape receiver (GPS, timestamps, GPS module temperature, settings)",
         "decode": "Decoding and wind computation",
         "db": "Database writes and background jobs",
         "ws": "Windshear detection engine",
         "gps": "GPS quality monitor",
         "meps": "MEPS weather model data (optional)",
         "sondes": "Jokioinen radiosoundings",
         "mast": "Kivenlahti mast (FMI open data: wind and temperature up to 327 m every 10 min; optional)",
         "calib": "Calibrations (temperature correction, heading calibration, magnetic declination)",
         "metar": "METAR / QNH of the airport",
         "pi": "Raspberry Pi (temperature, power, memory, disk, load)"}
RANK = {"off": 0, "ok": 1, "warn": 2, "err": 3}

# thread name → indicator (threads started in run.py / web/app.py)
THREADS = {"collector": "feed", "json_poller": "json", "ws_sweep": "ws", "gps_sweep": "gps",
           "housekeeping": "db", "hourly_jobs": "db", "autopurge": "db",
           "sondes": "sondes", "meps": "meps", "wx_poll": "metar", "rc_status": "rc", "mast": "mast",
           "pilot_reports": "metar"}
TASK = {"collector": "Feed reader", "json_poller": "Aircraft list poller", "ws_sweep": "Windshear sweep",
        "gps_sweep": "GPS sweep", "housekeeping": "Memory clean-up", "hourly_jobs": "Hourly jobs",
        "autopurge": "Purge check", "sondes": "Sounding fetcher", "meps": "MEPS fetcher", "mast": "Mast fetcher",
        "wx_poll": "METAR fetcher", "rc_status": "Radarcape status reader",
        "pilot_reports": "Pilot report fetcher"}

_slow: dict = {}             # cached slow readings: key → (time, value)
_last: dict = {}             # indicator → (state, since)
_cache = {"t": 0.0, "val": None}
_lock = threading.Lock()


def _ago(s) -> str:
    if s is None:
        return "—"
    s = max(0.0, s)
    if s < 90:
        return f"{s:.0f} s"
    if s < 5400:
        return f"{s / 60:.0f} min"
    if s < 172800:
        return f"{s / 3600:.1f} h"
    return f"{s / 86400:.0f} d"


def _hm(t) -> str:
    return time.strftime("%H:%M", time.gmtime(t)) + " UTC" if t else "—"


def _cached(key: str, ttl: float, fn):
    now = time.time()
    c = _slow.get(key)
    if c and now - c[0] < ttl:
        return c[1]
    try:
        v = fn()
    except Exception as exc:                          # noqa: BLE001
        log.debug("health %s: %s", key, exc)
        v = None
    _slow[key] = (now, v)
    return v


def _item(key, state, text, detail=None) -> dict:
    text = text[:1].upper() + text[1:] if text else ""
    return {"key": key, "label": LABEL[key], "title": TITLE[key], "state": state,
            "text": text, "detail": detail or []}


# ── Raspberry Pi readings ───────────────────────────────────────────────────

def _read(path: str) -> str | None:
    try:
        with open(path, "r", encoding="ascii", errors="ignore") as f:
            return f.read().strip()
    except OSError:
        return None


# The machine this server runs on: the readings of the "pi" indicator are always
# its own, so it is labelled "Pi" only on a Raspberry Pi (board model from the
# device tree) and "Server" elsewhere — on the cloud server it is not the
# receiving station's Pi (from 28 Oct 2026).
MODEL = (_read("/proc/device-tree/model") or "").strip("\x00 \n")
IS_PI = "raspberry pi" in MODEL.lower()
if not IS_PI:
    LABEL["pi"] = "Server"
    TITLE["pi"] = ("This server — the computer the page runs on, not the receiving station's Pi "
                   "(memory, disk, load; temperature and power when the machine reports them)")


def _cpu_temp():
    v = _read("/sys/class/thermal/thermal_zone0/temp")
    return round(int(v) / 1000.0, 1) if v and v.lstrip("-").isdigit() else None


def _throttled():
    """Raspberry Pi firmware flags (bit 0 under-voltage now, 1 frequency
    capped, 2 throttled, 3 soft temperature limit; +16: has occurred since
    boot), or None."""
    v = _read("/sys/devices/platform/soc/soc:firmware/get_throttled")
    if v is None:
        try:
            import subprocess
            out = subprocess.run(["vcgencmd", "get_throttled"], capture_output=True,
                                 text=True, timeout=2).stdout
            m = re.search(r"0x([0-9a-fA-F]+)", out)
            return int(m.group(1), 16) if m else None
        except Exception:                             # noqa: BLE001
            return None
    try:
        return int(v, 16)
    except ValueError:
        return None


def _meminfo():
    v = _read("/proc/meminfo")
    if not v:
        return None
    out = {}
    for line in v.splitlines():
        k, _, rest = line.partition(":")
        if k in ("MemTotal", "MemAvailable"):
            out[k] = int(rest.split()[0]) / 1024.0          # MB
    return out or None


def _rss_mb():
    v = _read("/proc/self/status")
    m = re.search(r"VmRSS:\s+(\d+)", v or "")
    return round(int(m.group(1)) / 1024.0) if m else None


_thr_first = {"val": None}


def _pi(cfg, now) -> dict:
    st, notes, det = "ok", [], []
    temp = _cpu_temp()
    if temp is not None:
        det.append(f"CPU {temp:.0f} °C")
        _pi_hot["on"] = temp >= (PI_HOT_OFF if _pi_hot["on"] else PI_HOT_ON)
        if temp >= 80:
            st = "err"; notes.append(f"CPU very hot ({temp:.0f} °C)")
        elif _pi_hot["on"]:
            st = "warn"; notes.append(f"CPU hot ({temp:.0f} °C)")
    thr = _cached("throttled", 30, _throttled)
    if thr is not None:
        if _thr_first["val"] is None:
            _thr_first["val"] = thr
        if thr & 0x1:
            st = "err"; notes.append("under-voltage now (check the power supply)")
        elif thr & 0x6:
            st = max(st, "warn", key=RANK.get); notes.append("CPU throttled now")
        elif thr & 0x8:
            st = max(st, "warn", key=RANK.get); notes.append("soft temperature limit active")
        new = thr & ~_thr_first["val"] & 0x70000
        if new & 0x10000:
            st = max(st, "warn", key=RANK.get); notes.append("under-voltage has occurred since the server started")
        elif new & 0x60000:
            st = max(st, "warn", key=RANK.get); notes.append("throttling has occurred since the server started")
        if _thr_first["val"] & 0x10000 and not (thr & 0x1) and not new:
            det.append("under-voltage seen earlier since boot")
        det.append("power OK" if not thr & 0xF else "power / throttle flags set")
    mem = _meminfo()
    if mem and "MemAvailable" in mem:
        av = mem["MemAvailable"]
        det.append(f"memory free {av:.0f} of {mem.get('MemTotal', 0):.0f} MB")
        if av < 100:
            st = "err"; notes.append(f"memory almost full ({av:.0f} MB free)")
        elif av < 300:
            st = max(st, "warn", key=RANK.get); notes.append(f"memory low ({av:.0f} MB free)")
    rss = _rss_mb()
    if rss is not None:
        det.append(f"server process {rss} MB")
    try:
        d = os.path.dirname(os.path.abspath(cfg.DB_PATH))
        free = shutil.disk_usage(d).free / 1e9
        det.append(f"disk free {free:.1f} GB")
        if free < 0.5:
            st = "err"; notes.append(f"disk almost full ({free:.1f} GB free)")
        elif free < 2:
            st = max(st, "warn", key=RANK.get); notes.append(f"disk space low ({free:.1f} GB free)")
    except OSError:
        pass
    try:
        l1, l5, _ = os.getloadavg()
        cores = os.cpu_count() or 4
        det.append(f"load {l1:.2f} / {l5:.2f} ({cores} cores)")
        if l5 > cores * 0.9:
            st = max(st, "warn", key=RANK.get); notes.append(f"CPU load high ({l5:.1f})")
    except (OSError, AttributeError):
        pass
    up = _read("/proc/uptime")
    if up:
        det.append(f"up {_ago(float(up.split()[0]))}, server {_ago(now - hb.STARTED)}")
    if det:
        det.insert(0, MODEL if IS_PI else "this server's own readings (not the receiving station's Pi)")
    if not det:
        return _item("pi", "off", "No system readings on this computer")
    text = "; ".join(notes) if notes else (f"Normal — CPU {temp:.0f} °C" if temp is not None else "Normal")
    return _item("pi", st, text[0].upper() + text[1:], det)


# ── Radarcape receiver ─────────────────────────────────────────────────────

def _rc_item(now: float, up: float) -> dict:
    from collector import radarcape_status as rcs
    rc = rcs.get()
    if rc is None or not rc.enabled:
        return _item("rc", "off", "Off (RADARCAPE_STATUS = False)")
    pub = rc.public(now)
    d = pub["data"]
    if d is None:
        if up < 180:
            return _item("rc", "warn", "Starting")
        return _item("rc", "err", "No answer from the Radarcape status")
    age = now - pub["ok_ts"]
    red, amber = rcs.gps_problems(d.get("gps"))
    det = []
    t = d.get("temp")
    if isinstance(t, (int, float)):
        det.append(f"GPS module {t:.0f} °C, ≈ {t - 20:.0f} °C around it" + (f" (24 h {pub['temp_min']:.0f}–{pub['temp_max']:.0f} °C)"
                                                if pub.get("temp_min") is not None else ""))
        if t >= 85:
            red.append(f"GPS module very hot ({t:.0f} °C)")
        elif t >= 70:
            amber.append(f"GPS module hot ({t:.0f} °C)")
    gt, stt = d.get("gps_time"), d.get("sys_time")
    if isinstance(gt, (int, float)) and isinstance(stt, (int, float)) and abs(gt - stt) > 2:
        amber.append(f"system time {stt - gt:+.0f} s from GPS time")
    if pub.get("restart_ts") and now - pub["restart_ts"] < 3600:
        amber.append(f"receiver software restarted {_ago(now - pub['restart_ts'])} ago")
    diff = rcs.fpga_differences(d.get("fpga"))
    if diff:
        amber.append("receiver setting differs: " + ", ".join(diff))
    if age > 900:
        red.append(f"status not read for {_ago(age)}")
    elif age > 300:
        amber.append(f"status not read for {_ago(age)}")
    if d.get("rcd_uptime") is not None:
        det.append(f"receiver up {_ago(d['rcd_uptime'])}")
    det.append(f"time {d.get('mlat_time_source') or '?'}, NTP {d.get('ntp_source') or '?'}"
               + (f", RMS offset {d['ntp_rms']:g} µs" if d.get("ntp_rms") is not None else ""))
    det.append(f"read {_ago(age)} ago")
    if red:
        return _item("rc", "err", "; ".join(red + amber), det)
    if amber:
        return _item("rc", "warn", "; ".join(amber), det)
    return _item("rc", "ok", "GPS locked, timestamps synchronised" +
                 (f" — GPS module {t:.0f} °C" if isinstance(t, (int, float)) else ""), det)


# ── evaluation ──────────────────────────────────────────────────────────────

REGDB_STALE_DAYS = 3


def _regdb_item(now: float) -> dict:
    """BaseStation.sqb (from 2026-10-29): in use / not installed / unreadable."""
    from collector import aircraft_db
    st = aircraft_db.status()
    path = st.get("path")
    where = None
    if path:
        root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        rel = os.path.relpath(os.path.abspath(path), root)
        where = rel if not rel.startswith("..") else os.path.join(os.path.basename(os.path.dirname(os.path.abspath(path))), os.path.basename(path))
    det = []
    if st["lookups"]:
        det.append(f"{st['lookups']} aircraft without a registration or type in the receiver's list "
                   f"looked up since the start, {st['found']} registrations found"
                   + (f" ({st['found_ref']} from the daily-updated tar1090-db)" if st.get("found_ref") else ""))
    # daily update (collector/regdb_update.py, from 2026-11-01): amber when it
    # is on but has not succeeded for STALE_DAYS — the files in use stay valid
    upd_warn = None
    try:
        from collector import regdb_update
        u = regdb_update.get()
        h = u.health() if u else None
    except Exception:
        h = None
    if h is not None:
        if not h["enabled"]:
            det.append("daily update off (no network requests)")
        else:
            ok_ts = h.get("ok_ts")
            if ok_ts:
                det.append(f"daily update: last success {time.strftime('%Y-%m-%d %H:%M', time.gmtime(ok_ts))} UTC")
            if (ok_ts and now - ok_ts > REGDB_STALE_DAYS * 86400) or \
                    (not ok_ts and now - h.get("started", now) > REGDB_STALE_DAYS * 86400):
                upd_warn = (f"Daily update has not succeeded for over {REGDB_STALE_DAYS} days — "
                            "the existing files stay in use")
                if h.get("error"):
                    det.append(f"last error: {h['error']}")
        if st.get("ref_open") and st.get("ref_aircraft"):
            det.append(f"reference data: tar1090-db {st['ref_aircraft']:,} aircraft".replace(",", " "))
    if st["open"]:
        n = st.get("aircraft")
        txt = f"In use — {n:,} aircraft".replace(",", " ") if n is not None else "In use"
        if st.get("mtime"):
            det.insert(0, f"file of {time.strftime('%Y-%m-%d', time.gmtime(st['mtime']))}")
        if where:
            det.insert(0, where)
        if upd_warn:
            return _item("regdb", "warn", upd_warn, [txt] + det)
        return _item("regdb", "ok", txt, det)
    if st["exists"]:
        return _item("regdb", "warn", "File found but it could not be opened — registrations from the receiver's list only",
                     ([where] if where else []) + ([f"error: {st['error']}"] if st.get("error") else []) + det)
    if not path:
        return _item("regdb", "off", "Not configured (optional)", det)
    return _item("regdb", "off", "Not installed (optional) — registrations from the receiver's list only",
                 [f"expected at {where}" if where else "expected next to the database",
                  "it is looked for every 5 minutes, no restart needed"] + det)


def _short_rx(rx_id: str) -> str:
    """MODES-RX-02 → RX-02 (the dot's label)."""
    return rx_id[6:] if rx_id.upper().startswith("MODES-") else rx_id


def _extra_rx_items(items: dict, now: float, up: float) -> list:
    """Health items of the other receivers (EXTRA_RECEIVERS); [] when none.
    With them the main receiver's dot is labelled with its id as well."""
    from collector import multirx
    if not multirx.active():
        return []
    m = multirx.main_public()
    items["feed"]["label"] = "Feed " + _short_rx(m["id"])
    items["feed"]["title"] = f"{m['id']} {m['name']}: " + TITLE["feed"]
    alive = {t.name for t in threading.enumerate()}
    keys = []
    mrx = multirx.main_rx()
    if mrx is not None:
        # receivers merged: the main receiver's dot from its own reader (the
        # merged statistics stay live while another receiver is heard)
        p = mrx.public(10)
        age = p["feed"]["last_frame_age"]
        others = any(x.last_frame and now - x.last_frame < 60 for x in multirx.extras())
        det = [f"{p['feed']['connects']} connection(s) since the server started"]
        if p["feed"]["connected_ts"]:
            det.insert(0, f"connected {_ago(now - p['feed']['connected_ts'])}")
        ck = p["clock"]
        det.append("GPS time" if ck["state"] == "gps" else
                   f"no GPS time in its stamps ({ck['nogps']} frames) — arrival time used" if ck["state"] == "nogps"
                   else "clock starting")
        if f"rx_{mrx.id}" not in alive and up > 30:
            st, text = "err", "Reader stopped — restart the server"
        elif age is not None and age < 30:
            r = mrx.rate_now()
            st, text = ("ok" if ck["state"] != "nogps" else "warn"), \
                (f"Live — {r:.0f} messages/s" if r is not None else "Live") + \
                ("" if ck["state"] != "nogps" else ", no GPS time")
        elif age is None and up < 60:
            st, text = "warn", "Starting"
        elif others:
            st = "warn"
            text = (f"Silent for {_ago(age)}" if age is not None else (p["feed"]["err"] or "No messages yet")) + \
                " — the weather from the other receivers only"
        elif age is not None and age < 600:
            st, text = "warn", f"Silent for {_ago(age)}"
        else:
            st, text = "err", (f"No messages for {_ago(age)}" if age is not None else
                               (p["feed"]["err"] or "No messages")) + " — receiver or network down?"
        items["feed"] = {"key": "feed", "label": "Feed " + _short_rx(mrx.id),
                         "title": f"{mrx.id} {mrx.name}: Radarcape Beast feed, merged with the other receivers",
                         "state": st, "text": text, "detail": det}
    for xr in multirx.extras():
        key = "rx:" + xr.id
        p = xr.public(10)
        f, ck, cm = p["feed"], p["clock"], p["cmp"]
        age = f["last_frame_age"]
        det = []
        if f["connected_ts"]:
            det.append(f"connected {_ago(now - f['connected_ts'])}, {f['connects']} connection(s) since the server started")
        det.append({"sync": f"clock lined up with {m['id']} ({ck['pairs']} ADS-B pairs)",
                    "own": "own clock (no GPS time from " + m["id"] + " now)",
                    "starting": "clock starting"}.get(ck["state"], ck["state"]))
        if cm["compared"]:
            det.append(f"{100 * cm['only'] / cm['compared']:.1f} % of its replies heard only here (10 min)")
        label = "Feed " + _short_rx(xr.id)
        title = f"{xr.id} {xr.name}: {xr.type} receiver, " + \
            ("merged into the weather" if mrx is not None else "watched (statistics only)")
        if f"rx_{xr.id}" not in alive and up > 30:
            st, text = "err", "Reader stopped — restart the server"
        elif f["down_sec"] is not None and f["down_sec"] > 1800:
            # a station switched off (e.g. the mobile one between deployments): grey, not a warning
            st, text = "off", f"Not connected for {_ago(f['down_sec'])} — station or its tunnel off"
        elif age is None:
            st = "warn"
            text = (f["err"] or "No messages yet") if up > 30 else "Starting"
        elif age < 60:
            r = xr.rate_now()
            st, text = "ok", f"Live — {r:.0f} messages/s" if r is not None else "Live"
        else:
            st, text = "warn", f"Silent for {_ago(age)}" + (f" — {f['err']}" if f["err"] else "")
        text = text[:1].upper() + text[1:]
        items[key] = {"key": key, "label": label, "title": title, "state": st, "text": text, "detail": det}
        keys.append(key)
    return keys


def evaluate(cfg, ws_tracker=None, wx_cache: dict | None = None) -> dict:
    from collector import msg_stats, meps, sondes, tcorr, heading_cal
    from database.db import get_db
    now = time.time()
    items: dict = {}
    snap = msg_stats.get().snapshot(10)
    feed = snap["feed"]
    tot = snap["totals"]
    up = now - hb.STARTED

    # feed
    age = now - feed["last_msg_ts"] if feed["last_msg_ts"] else None
    det = [f"{tot['rate']:.0f} messages/s (10 min)", f"{feed['connects']} connection(s) since the server started"]
    if feed["connected_ts"]:
        det.append(f"connected {_ago(now - feed['connected_ts'])}")
    if age is None:
        items["feed"] = _item("feed", "err" if up > 60 else "warn", "No messages from the receiver yet", det)
    elif age < 30:
        # the newest complete 10-s slot (after a restart the down time is filled with empty slots)
        last10 = next((v for _, v in reversed(snap["ten"] or []) if v is not None), None)
        rate = last10 / 10 if last10 is not None else tot["rate"]
        items["feed"] = _item("feed", "ok", f"Live — {rate:.0f} messages/s", det)
    elif age < 600:
        items["feed"] = _item("feed", "warn", f"Silent for {_ago(age)}", det)
    else:
        items["feed"] = _item("feed", "err", f"No messages for {_ago(age)} — receiver or network down?", det)

    # the other receivers, watched (collector/multirx.py, from 2026-11-02): one
    # dot each; never red (the weather does not depend on them)
    extra_keys = _extra_rx_items(items, now, up)

    # aircraft list (JSON poller)
    j = hb.get("json")
    jok = now - j["ok_ts"] if j.get("ok_ts") else None
    det = [f"{snap['json'].get('entries', 0)} aircraft in the last list",
           f"{snap['json'].get('polls', 0)} polls, {snap['json'].get('errors', 0)} errors since the server started"]
    if jok is not None and jok < 15 and not j.get("consecutive"):
        items["json"] = _item("json", "ok", f"Polled {_ago(jok)} ago — {j.get('entries', 0)} aircraft", det)
    elif jok is None and up < 60:
        items["json"] = _item("json", "warn", "Starting", det)
    elif jok is not None and jok < 300:
        items["json"] = _item("json", "warn", f"{j.get('err') or 'Late'} ({j.get('consecutive', 0)} in a row); last good list {_ago(jok)} ago", det)
    else:
        items["json"] = _item("json", "err", (j.get("err") or "No aircraft list") +
                              (f" — last good list {_ago(jok)} ago" if jok else ""), det)

    # decoding / meteo (last 10 min)
    m = snap["meteo"]
    pairs = m["wind"] + m["wind_old"] + m["nowind"]
    ehs = tot["ehs"]
    bad = tot["err"] + tot["dec_err"]
    det = [f"{ehs} EHS aircraft, {tot['aircraft']} aircraft in 10 min",
           f"winds {m['wind'] / 10:.1f}/min, {m['temp'] / 10:.1f}/min with temperature",
           f"undecodable {100 * bad / tot['msgs']:.1f} %" if tot["msgs"] else "no messages"]
    if items["feed"]["state"] == "err" or not tot["msgs"]:
        items["decode"] = _item("decode", "warn", "Nothing to decode — no messages", det)
    elif ehs >= DECODE_MIN_EHS and pairs >= 100 and m["wind"] == 0:
        items["decode"] = _item("decode", "err", f"{ehs} EHS aircraft heard but no winds computed in 10 min", det)
    elif ehs >= DECODE_MIN_EHS and pairs >= 200 and m["wind"] / pairs < 0.2:
        items["decode"] = _item("decode", "warn", f"Few winds: {100 * m['wind'] / pairs:.0f} % of the BDS 5,0 / 6,0 replies", det)
    elif tot["msgs"] > 1000 and bad / tot["msgs"] > 0.3:
        items["decode"] = _item("decode", "warn", f"Many undecodable messages ({100 * bad / tot['msgs']:.0f} %)", det)
    elif ehs == 0:
        items["decode"] = _item("decode", "ok", "No EHS aircraft at the moment", det)
    else:
        items["decode"] = _item("decode", "ok", f"{m['wind'] / 10:.0f} winds/min from {ehs} EHS aircraft", det)

    # database & jobs
    d = hb.get("db")
    st, notes, det = "ok", [], []
    dok = now - d["ok_ts"] if d.get("ok_ts") else None
    if d.get("err_ts") and now - d["err_ts"] < 900 and (not d.get("ok_ts") or d["err_ts"] >= d["ok_ts"] - 600):
        st = "err" if d.get("err_level") == "error" else "warn"
        notes.append(f"{d['err']} ({_ago(now - d['err_ts'])} ago)")
    if m["wind"] > 0 and (dok is None and up > 600 or dok is not None and dok > 600):
        st = "err" if (dok or up) > 1800 else max(st, "warn", key=RANK.get)
        notes.append(f"no observations written for {_ago(dok if dok is not None else up)}")
    det.append(f"last write {_ago(dok)} ago ({d.get('rows', 0)} rows)" if dok is not None else "no writes yet")
    h = hb.get("hourly")
    if h.get("run_ts"):
        det.append(f"hourly jobs running for {_ago(now - h['run_ts'])}")
        if now - h["run_ts"] > 3 * 3600:
            st = max(st, "warn", key=RANK.get); notes.append("hourly jobs running unusually long")
    elif h.get("ok_ts"):
        det.append(f"hourly jobs done {_ago(now - h['ok_ts'])} ago")
        if now - h["ok_ts"] > 3 * 3600:
            st = max(st, "warn", key=RANK.get); notes.append(f"hourly jobs last done {_ago(now - h['ok_ts'])} ago")
    if h.get("err_ts") and now - h["err_ts"] < 3 * 3600 and h["err_ts"] >= (h.get("ok_ts") or 0):
        st = max(st, "warn", key=RANK.get); notes.append(h["err"])
    for name, label in (("housekeeping", "memory clean-up"), ("autopurge", "purge check")):
        r = hb.get(name)
        if r.get("err_ts") and r["err_ts"] >= (r.get("ok_ts") or 0):
            st = max(st, "warn", key=RANK.get); notes.append(f"{label} failed")
    try:
        sz = os.path.getsize(cfg.DB_PATH) / 1e9
        wal = os.path.getsize(cfg.DB_PATH + "-wal") / 1e6 if os.path.exists(cfg.DB_PATH + "-wal") else 0
        det.append(f"database {sz:.2f} GB, WAL {wal:.0f} MB")
    except OSError:
        pass
    items["db"] = _item("db", st, "; ".join(notes) if notes else
                        (f"Writing — last batch {_ago(dok)} ago" if dok is not None else "Ready — nothing to write yet"), det)

    # windshear engine
    w = hb.get("ws_sweep")
    wage = now - w["ok_ts"] if w.get("ok_ts") else None
    det = []
    if ws_tracker is not None:
        try:
            with ws_tracker._lock:
                eng = ws_tracker._engine_status(now)
            det = [f"{eng.get('final', 0)} aircraft on final now",
                   f"today {eng.get('arr', 0)} landings, {eng.get('dep', 0)} departures analysed",
                   f"{eng.get('refs') if eng.get('refs') is not None else '—'} reference flights (45 min)"]
            if eng.get("age") is not None:
                det.append(f"last analysis {_ago(eng['age'])} ago")
        except Exception:                             # noqa: BLE001
            pass
    if wage is not None and wage < 30:
        items["ws"] = _item("ws", "ok", "Running" + (f" — {det[0]}" if det else ""), det)
    elif wage is None and up < 60:
        items["ws"] = _item("ws", "warn", "Starting", det)
    elif w.get("err_ts") and w["err_ts"] >= (w.get("ok_ts") or 0):
        items["ws"] = _item("ws", "err" if (wage or up) > 120 else "warn", f"Sweep failing ({_ago(now - w['err_ts'])} ago)", det)
    else:
        items["ws"] = _item("ws", "err", f"Not running for {_ago(wage if wage is not None else up)}", det)

    # GPS quality
    g = hb.get("gps_sweep")
    gage = now - g["ok_ts"] if g.get("ok_ts") else None
    lim = 3 * float(g.get("sweep") or getattr(cfg, "GPS_SWEEP_SEC", 5.0)) + 15
    det = [f"sweep every {g.get('sweep') or getattr(cfg, 'GPS_SWEEP_SEC', 5.0):g} s"]
    if gage is not None and gage < lim:
        items["gps"] = _item("gps", "ok", f"Running — last sweep {_ago(gage)} ago", det)
    elif gage is None and up < 60:
        items["gps"] = _item("gps", "warn", "Starting", det)
    else:
        items["gps"] = _item("gps", "err" if (gage or up) > 300 else "warn",
                             f"Sweep late ({_ago(gage if gage is not None else up)})", det)

    # MEPS (never red)
    mf = meps.get()
    if mf is None or not mf.enabled:
        items["meps"] = _item("meps", "off", "Off (MEPS_FETCH = False) — the system uses its fallbacks")
    else:
        newest = _cached("meps_run", 60, lambda: get_db().execute("SELECT MAX(run) FROM meps_hours").fetchone()[0])
        det = []
        if mf.last:
            failed = "failed" in mf.last[1]
            det.append(f"last look {_ago(now - mf.last[0])} ago" + (" — a request failed" if failed else ""))
        else:
            failed = False
        nh = _cached("meps_hour", 60, lambda: meps.newest_hour(get_db()))
        behind = now - nh[0] if nh else None
        if newest:
            nage = now - newest
            det.insert(0, f"newest run {time.strftime('%d.%m. %H', time.gmtime(newest))} UTC")
            if nh:
                det.insert(1, f"profiles up to {time.strftime('%H', time.gmtime(nh[0]))} UTC")
            if behind is not None and behind > 5400:
                # the Skew-T profile needs a stored hour within 1.5 h of the time shown
                items["meps"] = _item("meps", "warn", "No model profile for the current hour — newest "
                                      f"{time.strftime('%H', time.gmtime(nh[0]))} UTC (run "
                                      f"{time.strftime('%H', time.gmtime(nh[1]))} UTC); newer runs not received"
                                      + (", fetch failing" if failed else ""), det)
            elif nage <= 9 * 3600 and not (failed and nage > 6 * 3600):
                items["meps"] = _item("meps", "ok", f"Run {time.strftime('%H', time.gmtime(newest))} UTC stored ({_ago(nage)} old)", det)
            else:
                items["meps"] = _item("meps", "warn", f"Newest run {_ago(nage)} old — "
                                      + ("fetch failing, " if failed else "") + "the system uses the stored values", det)
        else:
            items["meps"] = _item("meps", "warn", "No model data yet — the system uses its fallbacks"
                                  if up > 900 else "Starting (first fetch a few minutes after the start)", det)

    # soundings
    ss = sondes.get()
    if ss is None:
        items["sondes"] = _item("sondes", "off", "Not available")
    else:
        keys = _cached("sonde_keys", 60, ss.keys) or []
        newest = None
        if keys:
            k = keys[-1]
            try:
                newest = calendar.timegm(time.strptime(k[:10], "%Y%m%d%H"))
            except ValueError:
                newest = None
        det = [f"{len(keys)} soundings stored"]
        lf = ss.last_fetch
        failed = bool(lf and "failed" in lf[1])
        if lf:
            det.append(f"last look {_ago(now - lf[0])} ago" + (" — failed" if failed else ""))
        place = getattr(ss, "place", "Jokioinen")
        if not ss.enabled:
            items["sondes"] = _item("sondes", "off", f"Fetching off (SONDE_FETCH = False); newest {place} "
                                    + (f"{_ago(now - newest)} old" if newest else "—"), det)
        elif newest is None:
            items["sondes"] = _item("sondes", "warn", "No soundings stored yet", det)
        else:
            sage = now - newest
            txt = f"{place} {time.strftime('%H', time.gmtime(newest))} UTC ({_ago(sage)} old)"
            if sage <= 15 * 3600:
                items["sondes"] = _item("sondes", "ok", txt, det)
            elif sage <= 30 * 3600:
                items["sondes"] = _item("sondes", "warn", f"Newest {txt}" + (" — fetch failing" if failed else ""), det)
            else:
                items["sondes"] = _item("sondes", "err", f"Newest {txt}" + (" — fetch failing" if failed else ""), det)

    # Kivenlahti mast (collector/mast.py, from 2026-11-01): newest step ≤ 30 min old OK,
    # ≤ 2 h amber, older red; off when switched off on the Maintenance page
    try:
        from collector import mast as _mast
        mf = _mast.get()
        if mf is None:
            items["mast"] = _item("mast", "off", "Not available")
        else:
            on = _cached("mast_on", 60, lambda: _mast.get_settings(get_db())["enabled"])
            newest = _cached("mast_newest", 60, lambda: mf.newest(get_db()))
            det = []
            if mf.last:
                det.append(f"last look {_ago(now - mf.last[0])} ago — {mf.last[2]}")
            if on is False:
                items["mast"] = _item("mast", "off", "Fetching off (Maintenance page)"
                                      + (f"; newest step {_ago(now - newest)} old" if newest else ""), det)
            elif newest is None:
                items["mast"] = _item("mast", "warn" if up > 900 else "ok",
                                      "No observations stored yet" if up > 900 else "Starting (first fetch about a minute after the start)", det)
            else:
                age = now - newest
                txt = f"Newest step {time.strftime('%H:%M', time.gmtime(newest))} UTC ({_ago(age)} old)"
                items["mast"] = _item("mast", "ok" if age <= 1800 else "warn" if age <= 7200 else "err",
                                      txt + ("" if age <= 1800 or not (mf.last and not mf.last[1]) else " — fetch failing"), det)
    except Exception as exc:                          # noqa: BLE001
        items["mast"] = _item("mast", "off", f"Not available ({exc})")

    # calibrations
    det, st, txt = [], "ok", []
    tc = _cached("tcorr", 60, lambda: tcorr.current(get_db())) if tcorr.ENABLED else None
    if not tcorr.ENABLED:
        det.append("temperature correction off (TEMP_CORRECTION = False)")
    elif tc and tc.get("ts"):
        tage = now - tc["ts"]
        det.append(f"temperature correction learnt {_hm(tc['ts'])} from MEPS, {tc.get('days', '?')} days")
        if tage <= 3 * 3600:
            txt.append(f"Temperature correction learnt {_ago(tage)} ago")
        else:
            st = "warn"; txt.append(f"Temperature correction from {_ago(tage)} ago in use (no new model data)")
    else:
        st = "warn"; txt.append("No temperature correction learnt yet — uncorrected")
    hc = heading_cal.get()
    if hc is not None and hc.enabled:
        try:
            sm = _cached("hcal", 60, lambda: hc.summary(include_airframes=False)) or {}
            det.append(f"heading calibration {sm.get('mode')}: {sm.get('calibrated', 0)} of {sm.get('airframes', 0)} airframes calibrated")
        except Exception:                             # noqa: BLE001
            pass
    else:
        det.append("heading calibration off")
    # magnetic declination at the aircraft position (collector/declination.py):
    # without the pygeomag package the fixed MAG_DECLINATION is used, with only
    # a warning at start-up — the winds far from the airport lose accuracy
    decl_warn = None
    mag = getattr(cfg, "MAG_DECLINATION", None)
    if getattr(cfg, "USE_WMM_DECLINATION", True):
        try:
            from collector import declination as _decl
            ds = _decl.status()
            if ds["state"] != "ok":
                decl_warn = f"Magnetic declination model (pygeomag) missing — fixed {mag}° in use"
                det.append(f"magnetic declination: the WMM2025 model could not be loaded "
                           f"({ds['error'] or 'pygeomag not installed'}); the fixed MAG_DECLINATION "
                           f"{mag}° is used, so winds far from the airport are less accurate (up to "
                           f"about 2° of heading). Install pygeomag for the Python that runs "
                           f"MODE-S Wind and restart")
            elif ds["extrapolated"]:
                decl_warn = "Magnetic declination model out of date — update pygeomag"
                det.append("magnetic declination: WMM2025 outside its validity period, extrapolated "
                           "— update pygeomag for the next World Magnetic Model")
            else:
                det.append("magnetic declination: WMM2025 model (pygeomag), at each aircraft's position")
        except Exception:                             # noqa: BLE001
            pass
    else:
        det.append(f"magnetic declination fixed {mag}° (USE_WMM_DECLINATION = False)")
    if decl_warn:
        st = max(st, "warn", key=RANK.get)
        for t in txt:                                 # the other note stays visible in the details
            det.insert(0, t[:1].lower() + t[1:])
        txt.insert(0, decl_warn)
    if not tcorr.ENABLED and (hc is None or not hc.enabled) and not decl_warn:
        items["calib"] = _item("calib", "off", "Off", det)
    else:
        items["calib"] = _item("calib", st, txt[0] if txt else "Active", det)

    # METAR / QNH
    icao = (getattr(cfg, "AIRPORT_ICAO", "") or "").upper()
    wx = dict(wx_cache or {})
    if not icao:
        items["metar"] = _item("metar", "off", "No airport set (AIRPORT_ICAO)")
    else:
        met = wx.get("metar") or ""
        mt = None
        mm = re.search(r"\b(\d{2})(\d{2})(\d{2})Z\b", met)
        if mm:
            g = time.gmtime(now)
            day, hh, mi = int(mm.group(1)), int(mm.group(2)), int(mm.group(3))
            y, mo = g.tm_year, g.tm_mon
            if day > g.tm_mday:                        # last month
                mo -= 1
                if mo == 0:
                    y, mo = y - 1, 12
            try:
                mt = calendar.timegm((y, mo, day, hh, mi, 0, 0, 0, 0))
            except (OverflowError, ValueError):
                mt = None
        fa = wx.get("fetched_at") or 0
        det = [f"QNH {wx['qnh_hpa']:.0f} hPa" if wx.get("qnh_hpa") else "no QNH",
               f"last fetch {_ago(now - fa)} ago" if fa else "not fetched yet"]
        # pilot reports (ilmailusaa.fi, from 2026-10-29): information only
        pr = _wxr.poller()
        if pr is not None and pr.enabled:
            st = pr.status
            if st["last_ok"]:
                det.append(f"pilot reports: last fetch {_ago(now - st['last_ok'])} ago, "
                           f"{st['got']} in the 24 h list" + (f" (later attempt failed: {st['err']})" if st["err"] else ""))
            elif st["err"]:
                det.append(f"pilot reports: fetch failed ({st['err']})")
            else:
                det.append("pilot reports: not fetched yet")
        if mt is None:
            items["metar"] = _item("metar", "warn" if up < 120 else "err",
                                   "Starting" if up < 120 else f"No METAR for {icao}", det)
        else:
            mage = now - mt
            txt = f"{icao} {time.strftime('%H%M', time.gmtime(mt))}Z ({_ago(mage)} old)"
            if mage <= 75 * 60:
                items["metar"] = _item("metar", "ok", txt + (f", QNH {wx['qnh_hpa']:.0f}" if wx.get("qnh_hpa") else ""), det)
            elif mage <= 3 * 3600:
                items["metar"] = _item("metar", "warn", f"METAR {txt} — QNH may be out of date", det)
            else:
                items["metar"] = _item("metar", "err", f"METAR {txt} — QNH out of date", det)

    # Radarcape receiver (systemstatus.json, collector/radarcape_status.py)
    items["rc"] = _rc_item(now, up)

    # registration database BaseStation.sqb (optional, collector/aircraft_db.py)
    items["regdb"] = _regdb_item(now)

    # Raspberry Pi (or, on another computer, this server)
    items["pi"] = _pi(cfg, now)

    # stopped threads
    alive = {t.name for t in threading.enumerate()}
    for tname, key in THREADS.items():
        if tname in alive:
            continue
        if tname == "sondes" and (sondes.get() is None or not sondes.get().enabled):
            continue
        if tname == "meps" and (meps.get() is None or not meps.get().enabled):
            continue
        if tname == "wx_poll" and not icao:
            continue
        if tname == "pilot_reports" and (_wxr.poller() is None or not _wxr.poller().enabled):
            continue
        if tname == "rc_status" and items["rc"]["state"] == "off":
            continue
        if up < 30:
            continue
        it = items[key]
        it["detail"] = [it["text"]] + it["detail"] if it["state"] != "err" or "stopped" not in it["text"] else it["detail"]
        it["state"] = "err"
        it["text"] = f"{TASK[tname]} stopped — restart the server"

    # state changes
    out = []
    with _lock:
        for key in ORDER[:1] + tuple(extra_keys) + ORDER[1:]:
            it = items[key]
            prev = _last.get(key)
            if prev is None:
                _last[key] = (it["state"], now)
            elif prev[0] != it["state"]:
                hb.CHANGES.appendleft({"ts": now, "key": key, "label": it["label"], "from": prev[0],
                                     "to": it["state"], "text": it["text"]})
                _last[key] = (it["state"], now)
                (log.warning if it["state"] == "err" else log.info)(
                    "Health: %s %s → %s (%s)", it["label"], prev[0], it["state"], it["text"])
            it["since"] = _last[key][1]
            out.append(it)
        changes = list(hb.CHANGES)
    worst = max((RANK[i["state"]] for i in out), default=1)
    overall = {3: "err", 2: "warn"}.get(worst, "ok")
    return {"now": now, "started": hb.STARTED, "overall": overall,
            "counts": {s: sum(1 for i in out if i["state"] == s) for s in ("ok", "warn", "err", "off")},
            "items": out, "changes": changes}


def get(cfg, ws_tracker=None, wx_cache=None, max_age: float = 10.0) -> dict:
    """Evaluation of at most max_age seconds ago (one per 10 s for all viewers)."""
    now = time.time()
    c = _cache
    if c["val"] is None or now - c["t"] >= max_age:
        c["val"] = evaluate(cfg, ws_tracker, wx_cache)
        c["t"] = now
    return c["val"]


def start_thread(cfg, ws_tracker=None, wx_cache_fn=None, interval: float = 60.0) -> None:
    """Evaluate every minute so the state changes are recorded (and logged)
    also while nobody has the page open."""
    def run():
        time.sleep(45)
        while True:
            try:
                get(cfg, ws_tracker, wx_cache_fn() if wx_cache_fn else None, max_age=interval / 2)
            except Exception as exc:                  # noqa: BLE001
                log.debug("health evaluation failed: %s", exc)
            time.sleep(interval)
    threading.Thread(target=run, name="health", daemon=True).start()
