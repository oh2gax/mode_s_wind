"""
radarcape_status.py — the Radarcape's own status for the Statistics page and
the health indicators (from 2026-10-26).

Reads http://<RADARCAPE_HOST>/systemstatus.json once a minute (about 1.5 kB):
the GPS flags of the receiver (antenna, tracking, satellites, UTC, timestamp
sync, 1PPS, GNSS module data), the GPS module temperature, the uptimes, the
time sources, the receiver position and its FPGA settings and versions.  RAM
only, nothing is written.  Off with RADARCAPE_STATUS = False in config.py.

Kept for the page: the fields above and the feeders; left out on purpose: the
network details (MAC and IP addresses), the MLAT nickname, the kernel string
and the client fields.

Meanings (Jetvision wiki, Radarcape: Software Features):
  gps_settings   AntOk/AntFail (antenna short or open), Track/notTrack,
                 GoodSat/BadSat (3+ / 1–2 satellites), TimeUTC/TimeGPS,
                 Sync/noSync (DPLL locked for ns timestamps), PpsOk/PpsFail,
                 TsipUbxOk/TsipUbxFail (serial data from the GNSS module),
                 TrueUTC/Daysec+1 (legacy day-second range)
  fpga_settings  BIN/AVR, ALL/DF17, CRC/CRCoff, TSgps/TS12M, RTS/RTSoff,
                 FEC/FECoff, AC/ACoff
  temperature    on a Radarcape: the GPS module temperature, about 20 K above
                 the air around it (not the air temperature)
  ntp_rms_offset the system clock's NTP RMS offset in microseconds

When ANTENNA_LAT / ANTENNA_LON are not set in config.py, the receiver's own GPS
position becomes the centre of the range rings (collector/msg_stats.py).
"""

from __future__ import annotations

import json
import logging
import threading
import time
import urllib.request
from collections import deque

from collector import health as hb

log = logging.getLogger("modes.radarcape")

POLL_SEC = 60.0
TIMEOUT = 5.0
TEMP_KEEP_SEC = 86400.0

GPS_GOOD = ("AntOk", "Track", "GoodSat", "TimeUTC", "Sync", "PpsOk", "TsipUbxOk", "TrueUTC")
GPS_BAD = {"AntOk": "AntFail", "Track": "notTrack", "GoodSat": "BadSat", "TimeUTC": "TimeGPS",
           "Sync": "noSync", "PpsOk": "PpsFail", "TsipUbxOk": "TsipUbxFail", "TrueUTC": "Daysec+1"}
GPS_TEXT = {
    "AntOk": "GPS antenna working (AntFail: short or open circuit)",
    "Track": "the GPS receiver tracks satellites",
    "GoodSat": "three or more satellites received (BadSat: only one or two)",
    "TimeUTC": "timestamps in UTC, the GPS–UTC offset known (TimeGPS: raw GPS time)",
    "Sync": "internal clock (DPLL) locked for nanosecond timestamps",
    "PpsOk": "the 1PPS pulse from the GPS arrives",
    "TsipUbxOk": "serial data from the GNSS module arrives",
    "TrueUTC": "day-second count from 0 at midnight (Daysec+1: legacy 1–86400)",
}
# what MODE-S Wind needs of the receiver settings: (good, other, meaning)
FPGA_NEED = (("BIN", "AVR", "Beast binary output"),
             ("ALL", "DF17", "all Mode S downlink formats (DF17: only DF11/17/18)"),
             ("CRC", "CRCoff", "CRC check of DF11 / DF17"),
             ("TSgps", "TS12M", "GPS timestamps (TS12M: legacy 12 MHz counter)"),
             ("RTS", "RTSoff", "data-flow handshake FPGA ↔ software (strongly required)"),
             ("FEC", "FECoff", "1-bit error correction (FECoff: about 15 % fewer frames)"),
             ("ACoff", "AC", "Mode A/C reception off"))


class RadarcapeStatus:
    def __init__(self, host: str, enabled: bool = True) -> None:
        self.host = host
        self.enabled = enabled and bool(host)
        self._lock = threading.Lock()
        self.data: dict | None = None
        self.ok_ts: float | None = None
        self.err: str | None = None
        self.err_ts: float | None = None
        self.restart_ts: float | None = None   # receiver software restart seen
        self._temps: deque = deque()           # (ts, °C), 24 h
        self._prev_rcd = None

    @property
    def url(self) -> str:
        return f"http://{self.host}/systemstatus.json"

    def poll_once(self) -> bool:
        now = time.time()
        try:
            with urllib.request.urlopen(self.url, timeout=TIMEOUT) as r:
                raw = json.loads(r.read(64 * 1024).decode("utf-8", "replace"))
            if not isinstance(raw, dict):
                raise ValueError("not a JSON object")
        except Exception as exc:                    # noqa: BLE001
            with self._lock:
                self.err, self.err_ts = exc.__class__.__name__, now
            hb.fail("radarcape", "no answer from the Radarcape status")
            log.debug("Radarcape status not read: %s", exc)
            return False
        pos = raw.get("position") or {}
        d = {
            "sw_type": raw.get("sw_type"), "sw_ver": raw.get("sw_ver"), "fpga_ver": raw.get("fpga_ver"),
            "board": raw.get("board"), "distribution": raw.get("distribution"),
            "fpga": list(raw.get("fpga_settings") or []), "gps": list(raw.get("gps_settings") or []),
            "temp": raw.get("temperature"),
            "os_uptime": raw.get("os_uptime"), "rcd_uptime": raw.get("rcd_uptime"),
            "mlat_time_source": raw.get("mlat_time_source"), "ntp_source": raw.get("system_ntp_source"),
            "ntp_rms": _num(raw.get("ntp_rms_offset")),
            "gps_time": raw.get("gps_time"), "sys_time": raw.get("sys_time"),
            "position": {k: pos.get(k) for k in ("lat", "lon", "alt", "live")} if pos else None,
            "feeders": dict(raw.get("external_sw") or raw.get("feeders") or {}),
            "internet": dict(raw.get("internet_connection_status") or {}),
            "ts": now,
        }
        with self._lock:
            rcd = d["rcd_uptime"]
            if isinstance(rcd, (int, float)) and isinstance(self._prev_rcd, (int, float)) and rcd < self._prev_rcd:
                self.restart_ts = now
            self._prev_rcd = rcd
            if isinstance(d["temp"], (int, float)):
                self._temps.append((now, float(d["temp"])))
                while self._temps and now - self._temps[0][0] > TEMP_KEEP_SEC:
                    self._temps.popleft()
            self.data, self.ok_ts, self.err = d, now, None
        hb.beat("radarcape")
        return True

    def run(self) -> None:
        time.sleep(5)
        while True:
            try:
                self.poll_once()
                self._set_site()
            except Exception as exc:                # noqa: BLE001
                log.debug("Radarcape status error: %s", exc)
            time.sleep(POLL_SEC)

    def _set_site(self) -> None:
        """Range-ring centre from the receiver's GPS when ANTENNA_* are not set."""
        from collector import msg_stats
        ms = msg_stats.get()
        p = (self.data or {}).get("position") or {}
        if isinstance(p.get("alt"), (int, float)):
            ms.site_alt = p.get("alt")                  # antenna altitude, also with ANTENNA_*
        if getattr(ms, "site_src", "") == "config" or p.get("lat") is None or p.get("lon") is None:
            return
        if p.get("live") is False:
            return
        ms.site = (float(p["lat"]), float(p["lon"]))
        ms.site_src = "radarcape"
        ms.site_alt = p.get("alt")

    def public(self, now: float | None = None) -> dict:
        """For the Statistics page (/api/msgstats → "radarcape")."""
        now = time.time() if now is None else now
        with self._lock:
            d = dict(self.data) if self.data else None
            temps = [t for _, t in self._temps]
            out = {"enabled": self.enabled, "ok_ts": self.ok_ts, "err": self.err, "err_ts": self.err_ts,
                   "restart_ts": self.restart_ts, "data": d,
                   "temp_min": min(temps) if temps else None, "temp_max": max(temps) if temps else None,
                   "temp_n": len(temps)}
        if d:
            g = set(d.get("gps") or [])
            out["gps_flags"] = [{"flag": f if f in g else GPS_BAD[f], "ok": f in g, "text": GPS_TEXT[f]}
                                for f in GPS_GOOD]
            fs = set(d.get("fpga") or [])
            out["fpga_flags"] = [{"flag": good if good in fs else other if other in fs else good + "?",
                                  "ok": good in fs, "text": meaning} for good, other, meaning in FPGA_NEED]
            out["fpga_other"] = sorted(fs - {x for t in FPGA_NEED for x in t[:2]})
        return out


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def gps_problems(gps: list) -> tuple[list, list]:
    """(red, amber) lists of plain-language GPS problems."""
    flags = set(gps or [])
    red, amber = [], []
    if "AntOk" not in flags:
        red.append("GPS antenna fault (short or open)")
    if "Track" not in flags:
        red.append("GPS tracks no satellites")
    if "Sync" not in flags:
        red.append("timestamp clock not locked (noSync)")
    if "PpsOk" not in flags:
        red.append("1PPS pulse missing")
    if "TsipUbxOk" not in flags:
        red.append("no data from the GNSS module")
    if "GoodSat" not in flags and "Track" in flags:
        amber.append("only 1–2 satellites")
    if "TimeUTC" not in flags:
        amber.append("GPS time not yet UTC")
    if "TrueUTC" not in flags:
        amber.append("legacy day-second count (Daysec+1)")
    return red, amber


def fpga_differences(fpga: list) -> list:
    flags = set(fpga or [])
    return [f"{other} ({meaning.split(' (')[0]} expected: {good})" for good, other, meaning in FPGA_NEED
            if good not in flags and other in flags]


_instance: RadarcapeStatus | None = None


def init(cfg) -> RadarcapeStatus:
    global _instance
    _instance = RadarcapeStatus(getattr(cfg, "RADARCAPE_HOST", ""),
                                enabled=bool(getattr(cfg, "RADARCAPE_STATUS", True)))
    return _instance


def get() -> RadarcapeStatus | None:
    return _instance
