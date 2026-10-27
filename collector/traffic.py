"""
traffic.py — data transfer counters for the Statistics page (from 2026-10-27).

How many bytes MODE-S Wind moves, per minute, hour and day — useful on a
cloud server with a monthly transfer allowance, and to see what a tunnel from
the receiver site carries.  Counted kinds:

  beast   the Radarcape's Beast stream: the exact bytes the Beast parser
          consumed (collector/beast_sig.py wraps pyModeS's parser)
  json    the Radarcape's aircraft list (aircraftlist.json, every 2 s)
  status  the Radarcape's status page (systemstatus.json, once a minute)
  web     the web pages and data served to the users (response bodies plus
          their headers, the Live Map's live stream included)
  rx, tx  the machine's network interface totals, received / sent
          (/proc/net/dev of the default-route interface; Linux only).  They
          include everything: the tunnel's encryption, HTTPS, the model,
          sounding and METAR downloads, system updates, and on the home
          station also the local network (the Radarcape's own stream).

The application counters miss the network overhead (TCP/IP, TLS, SSH), so
rx / tx are a little higher than the known parts even without other traffic.

Kept: the minutes of the last two hours in memory; one row per UTC hour in
traffic_hours (written when the hour ends, the hour in progress every 15 min
and at shutdown, so that a restart continues it; kept TRAFFIC_DAYS = 400
days).  Days and months are summed from the hours (UTC).  A few hundred
bytes a write — negligible also on an SD card.
"""

from __future__ import annotations

import atexit
import calendar
import logging
import os
import sqlite3
import threading
import time
from collections import deque

log = logging.getLogger(__name__)

KINDS = ("beast", "json", "status", "web", "rx", "tx")
_IDX = {k: i for i, k in enumerate(KINDS)}
APP_IN = ("beast", "json", "status")          # received by MODE-S Wind from the receiver
TRAFFIC_DAYS = 400                            # traffic_hours kept (days)
SAVE_PARTIAL_SEC = 900                        # the hour in progress written this often
TICK_SEC = 60.0


def _hour(t: float) -> int:
    return int(t // 3600 * 3600)


def _minute(t: float) -> int:
    return int(t // 60 * 60)


def _default_ifaces() -> list:
    """The interfaces of the default route (/proc/net/route), else all but lo."""
    names = []
    try:
        with open("/proc/net/route") as f:
            next(f)
            for line in f:
                p = line.split()
                if len(p) > 2 and p[1] == "00000000" and p[0] not in names:
                    names.append(p[0])
    except OSError:
        pass
    return names


def _read_if(names: list | None):
    """(rx, tx) byte totals of the named interfaces (all but lo when None)."""
    rx = tx = 0
    found = False
    try:
        with open("/proc/net/dev") as f:
            for line in f.readlines()[2:]:
                name, _, rest = line.partition(":")
                name = name.strip()
                if name == "lo" or (names and name not in names):
                    continue
                v = rest.split()
                if len(v) >= 9:
                    rx += int(v[0])
                    tx += int(v[8])
                    found = True
    except (OSError, ValueError):
        return None
    return (rx, tx) if found else None


class Traffic:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._min_t = _minute(time.time())
        self._min = [0] * len(KINDS)                 # the minute in progress
        self.minutes: deque = deque(maxlen=120)      # (t, [values]) of finished minutes
        self._hour_t = _hour(time.time())
        self._hour = [0] * len(KINDS)                # the UTC hour in progress
        self._hours: dict = {}                       # finished hours not yet written
        self._if_prev = None
        self.ifaces: list = []
        self.if_ok = False
        self.db_path: str | None = None
        self._last_partial = time.time()
        self._cache = (0.0, None)                    # (time, stored hours) for the API
        self.started = time.time()

    # ── counting ────────────────────────────────────────────────────────────
    def add(self, kind: str, n: int) -> None:
        if n <= 0:
            return
        i = _IDX[kind]
        now = time.time()
        with self._lock:
            if _minute(now) != self._min_t:
                self._roll(now)
            self._min[i] += int(n)
            self._hour[i] += int(n)

    def _roll(self, now: float) -> None:
        """Close the minute (and the hour) in progress; lock held."""
        self.minutes.append((self._min_t, self._min))
        self._min_t, self._min = _minute(now), [0] * len(KINDS)
        if _hour(now) != self._hour_t:
            self._hours[self._hour_t] = self._hour
            self._hour_t, self._hour = _hour(now), [0] * len(KINDS)

    def sample_if(self) -> None:
        cur = _read_if(self.ifaces or None)
        if cur is None:
            self.if_ok = False
            return
        self.if_ok = True
        if self._if_prev is not None:
            drx, dtx = cur[0] - self._if_prev[0], cur[1] - self._if_prev[1]
            if drx >= 0 and dtx >= 0:                # a counter reset: skip that step
                self.add("rx", drx)
                self.add("tx", dtx)
        self._if_prev = cur

    # ── storage ─────────────────────────────────────────────────────────────
    def _conn(self):
        c = sqlite3.connect(self.db_path, timeout=30)
        c.execute("""CREATE TABLE IF NOT EXISTS traffic_hours (
                        ts INTEGER PRIMARY KEY, beast INTEGER, json INTEGER, status INTEGER,
                        web INTEGER, rx INTEGER, tx INTEGER)""")
        return c

    def init(self, db_path: str) -> None:
        """Open the table and continue the hour in progress from its stored row."""
        self.db_path = db_path
        self.ifaces = _default_ifaces()
        try:
            c = self._conn()
            row = c.execute("SELECT beast, json, status, web, rx, tx FROM traffic_hours WHERE ts = ?",
                            (self._hour_t,)).fetchone()
            c.close()
            if row:
                with self._lock:
                    self._hour = [a + int(b or 0) for a, b in zip(self._hour, row)]
        except Exception as exc:                     # noqa: BLE001
            log.warning("Data transfer counters: table not available: %s", exc)
        self.sample_if()
        atexit.register(self.flush)

    def flush(self, partial: bool = True) -> None:
        """Write the finished hours, and the hour in progress (partial)."""
        if not self.db_path:
            return
        with self._lock:
            if _minute(time.time()) != self._min_t:
                self._roll(time.time())
            rows = list(self._hours.items())
            self._hours = {}
            if partial:
                rows.append((self._hour_t, list(self._hour)))
        if not rows:
            return
        try:
            c = self._conn()
            c.executemany("INSERT OR REPLACE INTO traffic_hours (ts, beast, json, status, web, rx, tx) "
                          "VALUES (?, ?, ?, ?, ?, ?, ?)", [(t, *v) for t, v in rows])
            c.commit()
            c.close()
            self._cache = (0.0, None)
        except Exception as exc:                     # noqa: BLE001
            log.warning("Data transfer counters not saved: %s", exc)
            with self._lock:                         # keep the finished hours for the next try
                for t, v in rows:
                    if t != self._hour_t:
                        self._hours.setdefault(t, v)

    def purge(self) -> None:
        try:
            c = self._conn()
            c.execute("DELETE FROM traffic_hours WHERE ts < ?", (time.time() - TRAFFIC_DAYS * 86400,))
            c.commit()
            c.close()
        except Exception as exc:                     # noqa: BLE001
            log.debug("traffic purge: %s", exc)

    def run(self) -> None:
        """Background thread: interface sample every minute, hours to the DB."""
        day = time.gmtime().tm_yday
        while True:
            time.sleep(TICK_SEC - (time.time() % TICK_SEC) + 0.5)
            try:
                self.sample_if()
                with self._lock:
                    if _minute(time.time()) != self._min_t:
                        self._roll(time.time())
                    done = bool(self._hours)
                now = time.time()
                if done or now - self._last_partial >= SAVE_PARTIAL_SEC:
                    self.flush(partial=True)
                    self._last_partial = now
                if time.gmtime().tm_yday != day:
                    day = time.gmtime().tm_yday
                    self.purge()
            except Exception as exc:                 # noqa: BLE001
                log.warning("Data transfer counters: %s", exc)

    # ── API ─────────────────────────────────────────────────────────────────
    def _stored(self) -> dict:
        """{hour ts: [values]} of the stored hours (cached 60 s)."""
        t, rows = self._cache
        if rows is not None and time.time() - t < 60:
            return rows
        rows = {}
        if self.db_path:
            try:
                c = self._conn()
                for r in c.execute("SELECT ts, beast, json, status, web, rx, tx FROM traffic_hours "
                                   "WHERE ts >= ?", (time.time() - 62 * 86400,)):
                    rows[int(r[0])] = [int(x or 0) for x in r[1:]]
                c.close()
            except Exception as exc:                 # noqa: BLE001
                log.debug("traffic read: %s", exc)
        self._cache = (time.time(), rows)
        return rows

    def _all_hours(self) -> dict:
        hours = dict(self._stored())
        with self._lock:
            for t, v in self._hours.items():
                hours[t] = v
            hours[self._hour_t] = list(self._hour)
        return hours

    @staticmethod
    def _sum(vals) -> dict:
        tot = [0] * len(KINDS)
        n = 0
        for v in vals:
            n += 1
            for i, x in enumerate(v):
                tot[i] += x
        d = dict(zip(KINDS, tot))
        d["app_in"] = sum(d[k] for k in APP_IN)
        d["hours"] = n
        return d

    def snapshot(self, rng: str = "24h") -> dict:
        now = time.time()
        hours = self._all_hours()
        with self._lock:
            mins = list(self.minutes)
        # the rate: the last full minute
        last = mins[-1] if mins and mins[-1][0] >= _minute(now) - 60 else None
        rate = {k: (last[1][i] / 60.0 if last else None) for i, k in enumerate(KINDS)}
        if last:
            rate["app_in"] = sum(rate[k] for k in APP_IN)

        g = time.gmtime(now)
        day0 = int(now // 86400 * 86400)
        month0 = calendar.timegm((g.tm_year, g.tm_mon, 1, 0, 0, 0))
        nm = (g.tm_year + (g.tm_mon == 12), g.tm_mon % 12 + 1)
        month1 = calendar.timegm((nm[0], nm[1], 1, 0, 0, 0))
        sel = lambda a, b: [v for t, v in hours.items() if a <= t < b]          # noqa: E731
        today = self._sum(sel(day0, day0 + 86400))
        yday = self._sum(sel(day0 - 86400, day0))
        last7 = self._sum(sel(_hour(now) - 167 * 3600, _hour(now) + 3600))
        month = self._sum(sel(month0, month1))
        # a whole month at the rate of the time counted this month (counting may
        # have begun after the 1st; the projection needs at least an hour)
        firsts = [t for t in hours if month0 <= t < month1]
        t_from = max(month0, min(firsts)) if firsts else now
        counted = max(0.0, now - t_from)
        proj = None
        if counted >= 3600:
            f = (month1 - month0) / counted
            proj = {k: int(month[k] * f) for k in KINDS + ("app_in",)}
        out = {
            "kinds": list(KINDS), "app_in": list(APP_IN), "range": rng,
            "rate": rate, "today": today, "yesterday": yday, "last7": last7,
            "month": month, "month_label": time.strftime("%B %Y", g), "month_projection": proj,
            "month_counted_h": round(counted / 3600, 1),
            "iface": ",".join(self.ifaces) or None, "iface_ok": self.if_ok,
            "since": min(hours) if hours else None,
        }
        # the chart bins
        if rng == "1h":
            out["bin_sec"] = 60
            out["bins"] = [[t, *v] for t, v in mins if t >= _minute(now) - 3600]
        elif rng == "30d":
            out["bin_sec"] = 86400
            days: dict = {}
            for t, v in hours.items():
                d = t // 86400 * 86400
                if d >= day0 - 29 * 86400:
                    acc = days.setdefault(d, [0] * len(KINDS))
                    for i, x in enumerate(v):
                        acc[i] += x
            out["bins"] = [[t, *days[t]] if t in days else [t] + [None] * len(KINDS)
                           for t in range(day0 - 29 * 86400, day0 + 1, 86400)]
        else:
            n = 168 if rng == "7d" else 24
            out["bin_sec"] = 3600
            h0 = _hour(now)
            out["bins"] = [[t, *hours[t]] if t in hours else [t] + [None] * len(KINDS)
                           for t in range(h0 - (n - 1) * 3600, h0 + 1, 3600)]
        return out


_instance = Traffic()


def get() -> Traffic:
    return _instance


def add(kind: str, n: int) -> None:
    """Count n bytes of one kind (cheap; never raises)."""
    try:
        _instance.add(kind, n)
    except Exception:                                # noqa: BLE001
        pass
