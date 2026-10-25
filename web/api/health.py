"""
web/api/health.py — system health indicators of the Statistics page
(from 2026-10-25).

Eleven indicators, each green (healthy) / amber (degraded: late, retrying or
on a fallback) / red (fault: stopped, failing or very old) / grey (off):

  feed      Radarcape Beast feed      last frame < 5 s / < 60 s / older
  json      Radarcape aircraft list   last good poll < 15 s / failing / > 5 min
  decode    decoding / meteo          winds while EHS aircraft are heard
  db        database & jobs           batch writes, hourly jobs, purge check,
                                      memory clean-up
  ws        windshear engine          sweep running (every 3 s)
  gps       GPS quality               sweep running
  meps      MEPS model                newest stored run ≤ 9 h (never red: the
                                      system works without the model)
  sondes    soundings                 newest Jokioinen sounding ≤ 15 h / 30 h
  calib     calibrations              temperature correction learnt from MEPS
                                      within 3 h (else the stored values are in
                                      use), heading calibration
  metar     METAR / QNH               observation ≤ 75 min / 3 h
  pi        Raspberry Pi              CPU temperature, under-voltage /
                                      throttling, free memory, disk, load

Plus: a background thread of the server that has stopped turns its indicator
red.  The reasons are plain language for all users; error details stay in the
log.  Everything is read from RAM or from small, cached queries (the MEPS
newest run and the temperature correction: 60 s); one evaluation takes a few
milliseconds.  The state changes (last 50) are kept in RAM for the detail
panel, evaluated every 60 s by a small thread even when nobody has the page
open, and logged.
"""

from __future__ import annotations

import calendar
import logging
import os
import re
import shutil
import threading
import time

from collector import health as hb

log = logging.getLogger("modes.health")

ORDER = ("feed", "json", "decode", "db", "ws", "gps", "meps", "sondes", "calib", "metar", "pi")
LABEL = {"feed": "Feed", "json": "Aircraft list", "decode": "Decoding", "db": "Database",
         "ws": "Windshear", "gps": "GPS", "meps": "MEPS", "sondes": "Soundings",
         "calib": "Calibrations", "metar": "METAR", "pi": "Pi"}
TITLE = {"feed": "Radarcape Beast feed (Mode S messages)",
         "json": "Radarcape aircraft list (MLAT positions, registrations)",
         "decode": "Decoding and wind computation",
         "db": "Database writes and background jobs",
         "ws": "Windshear detection engine",
         "gps": "GPS quality monitor",
         "meps": "MEPS weather model data (optional)",
         "sondes": "Jokioinen radiosoundings",
         "calib": "Calibrations (temperature correction, heading calibration)",
         "metar": "METAR / QNH of the airport",
         "pi": "Raspberry Pi (temperature, power, memory, disk, load)"}
RANK = {"off": 0, "ok": 1, "warn": 2, "err": 3}

# thread name → indicator (threads started in run.py / web/app.py)
THREADS = {"collector": "feed", "json_poller": "json", "ws_sweep": "ws", "gps_sweep": "gps",
           "housekeeping": "db", "hourly_jobs": "db", "autopurge": "db",
           "sondes": "sondes", "meps": "meps", "wx_poll": "metar"}
TASK = {"collector": "Feed reader", "json_poller": "Aircraft list poller", "ws_sweep": "Windshear sweep",
        "gps_sweep": "GPS sweep", "housekeeping": "Memory clean-up", "hourly_jobs": "Hourly jobs",
        "autopurge": "Purge check", "sondes": "Sounding fetcher", "meps": "MEPS fetcher",
        "wx_poll": "METAR fetcher"}

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
        if temp >= 80:
            st = "err"; notes.append(f"CPU very hot ({temp:.0f} °C)")
        elif temp >= 70:
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
    if not det:
        return _item("pi", "off", "No system readings on this computer")
    text = "; ".join(notes) if notes else (f"Normal — CPU {temp:.0f} °C" if temp is not None else "Normal")
    return _item("pi", st, text[0].upper() + text[1:], det)


# ── evaluation ──────────────────────────────────────────────────────────────

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
    elif age < 5:
        items["feed"] = _item("feed", "ok", f"Live — {snap['ten'][-1][1] / 10 if snap['ten'] else tot['rate']:.0f} messages/s", det)
    elif age < 60:
        items["feed"] = _item("feed", "warn", f"Silent for {_ago(age)}", det)
    else:
        items["feed"] = _item("feed", "err", f"No messages for {_ago(age)} — receiver or network down?", det)

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
    elif ehs >= 3 and m["wind"] == 0:
        items["decode"] = _item("decode", "err", f"{ehs} EHS aircraft heard but no winds computed in 10 min", det)
    elif pairs >= 50 and m["wind"] / pairs < 0.2:
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
        if newest:
            nage = now - newest
            det.insert(0, f"newest run {time.strftime('%d.%m. %H', time.gmtime(newest))} UTC")
            if nage <= 9 * 3600 and not (failed and nage > 6 * 3600):
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
    if not tcorr.ENABLED and (hc is None or not hc.enabled):
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

    # Raspberry Pi
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
        if up < 30:
            continue
        it = items[key]
        it["detail"] = [it["text"]] + it["detail"] if it["state"] != "err" or "stopped" not in it["text"] else it["detail"]
        it["state"] = "err"
        it["text"] = f"{TASK[tname]} stopped — restart the server"

    # state changes
    out = []
    with _lock:
        for key in ORDER:
            it = items[key]
            prev = _last.get(key)
            if prev is None:
                _last[key] = (it["state"], now)
            elif prev[0] != it["state"]:
                hb.CHANGES.appendleft({"ts": now, "key": key, "label": LABEL[key], "from": prev[0],
                                     "to": it["state"], "text": it["text"]})
                _last[key] = (it["state"], now)
                (log.warning if it["state"] == "err" else log.info)(
                    "Health: %s %s → %s (%s)", LABEL[key], prev[0], it["state"], it["text"])
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
