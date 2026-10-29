#!/usr/bin/env python3
"""
tools/load_metar_history.py — load the airport's METAR history into the
metar_reports table (from 2026-10-29, see collector/wx_reports.py).

Source: the Iowa Environmental Mesonet (IEM) METAR archive
(mesonet.agron.iastate.edu, cgi-bin/request/asos.py), which keeps the
routine METARs of EFHK every 30 min since at least 2018.  Finland publishes
no SPECI, so the archive is complete for our purpose.  One request per month,
a pause between the requests; rows already stored (the same observation time,
from the live fetch or an earlier load) are skipped, so the tool can be run
again at any time, e.g. to fill a gap after a long break.

    # the whole history (2018 → this month), about 9 × 17 500 rows, a few minutes
    python3 tools/load_metar_history.py

    # one period, another station
    python3 tools/load_metar_history.py --from 2023-01 --to 2023-12 --station EFTP

    # only count what would be loaded
    python3 tools/load_metar_history.py --from 2026-02 --to 2026-02 --dry-run

Safe to run while MODE-S Wind is running (SQLite WAL; short commits).  The
database path and the airport come from config.py / config_local.py
(DB_PATH, AIRPORT_ICAO) unless given with --db / --station.  At the end the
METARs with a windshear group (WS R22L / WS ALL RWY) are listed by day.
"""

import argparse
import csv
import io
import os
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from config import Config                      # noqa: E402
import config_override                         # noqa: E402

config_override.apply(Config)
from database.db import init_db                # noqa: E402
from collector import wx_reports as wxr        # noqa: E402

IEM_URL = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py"


def _month(s: str) -> tuple[int, int]:
    d = datetime.strptime(s, "%Y-%m")
    return d.year, d.month


def _next(y: int, m: int) -> tuple[int, int]:
    return (y + 1, 1) if m == 12 else (y, m + 1)


def fetch_month(station: str, y: int, m: int, timeout: float = 120.0) -> list[tuple[int, str]]:
    """(observation time, METAR text) of one month from IEM."""
    y2, m2 = _next(y, m)
    q = [("station", station), ("data", "metar"),
         ("year1", y), ("month1", m), ("day1", 1), ("year2", y2), ("month2", m2), ("day2", 1),
         ("tz", "Etc/UTC"), ("format", "onlycomma"), ("latlon", "no"), ("missing", "empty"),
         ("trace", "empty"), ("direct", "no"), ("report_type", 3), ("report_type", 4)]
    url = IEM_URL + "?" + urllib.parse.urlencode(q)
    req = urllib.request.Request(url, headers={"User-Agent": "MODE-S-Wind/1.0 (METAR history loader)"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        text = resp.read().decode("utf-8", errors="replace")
    out = []
    for row in csv.DictReader(io.StringIO(text)):
        v, met = (row.get("valid") or "").strip(), (row.get("metar") or "").strip()
        if not v or not met:
            continue
        try:
            ts = int(datetime.strptime(v, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc).timestamp())
        except ValueError:
            continue
        out.append((ts, met))
    return out


def main() -> int:
    cfg = Config()
    now = datetime.now(timezone.utc)
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from", dest="start", default="2018-01", help="first month YYYY-MM (default 2018-01)")
    ap.add_argument("--to", dest="end", default=now.strftime("%Y-%m"), help="last month YYYY-MM (default this month)")
    ap.add_argument("--station", default=(getattr(cfg, "AIRPORT_ICAO", "") or "EFHK").upper())
    ap.add_argument("--db", default=cfg.DB_PATH)
    ap.add_argument("--pause", type=float, default=3.0, help="seconds between the monthly requests (default 3)")
    ap.add_argument("--dry-run", action="store_true", help="fetch and count, store nothing")
    a = ap.parse_args()

    y, m = _month(a.start)
    ye, me = _month(a.end)
    if (y, m) > (ye, me):
        print("--from is after --to")
        return 2
    if not a.dry_run:
        init_db(a.db)                          # creates the tables if this version has not run yet
    db = sqlite3.connect(a.db, timeout=30.0)
    db.execute("PRAGMA journal_mode = WAL")
    tot = new = bad = 0
    first = True
    while (y, m) <= (ye, me):
        if not first:
            time.sleep(a.pause)
        first = False
        for attempt in range(3):
            try:
                pairs = fetch_month(a.station, y, m)
                break
            except Exception as exc:
                print(f"{y}-{m:02d}: fetch failed ({exc}){' — retrying' if attempt < 2 else ''}")
                pairs = None
                time.sleep(10 * (attempt + 1))
        if pairs is None:
            y, m = _next(y, m)
            continue
        rows, ws = [], 0
        fetched = time.time()
        for ts, txt in pairs:
            rec = wxr.parse_metar(txt)
            if not rec or rec["station"] != a.station:
                bad += 1
                continue
            ws += 1 if rec["ws"] else 0
            rows.append(wxr.metar_row(rec, ts, "iem", fetched))
        n = 0 if a.dry_run else wxr.insert_metars(db, rows)
        tot += len(rows)
        new += n
        print(f"{y}-{m:02d}: {len(rows):5d} METARs, {n:5d} new, {ws:3d} with WS")
        y, m = _next(y, m)
    print(f"Total {tot} METARs, {new} new{', ' + str(bad) + ' not parsed' if bad else ''}"
          f"{' (dry run: nothing stored)' if a.dry_run else ''}")
    if not a.dry_run:
        rows = db.execute("SELECT date(ts, 'unixepoch') d, COUNT(*), GROUP_CONCAT(DISTINCT ws) "
                          "FROM metar_reports WHERE station = ? AND ws IS NOT NULL GROUP BY d ORDER BY d",
                          (a.station,)).fetchall()
        if rows:
            print(f"\nDays with a windshear group ({len(rows)}):")
            for d, c, w in rows:
                print(f"  {d}  {c:2d} METAR{'s' if c > 1 else ' '}  {w}")
    db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
