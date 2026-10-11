#!/usr/bin/env python3
"""
tools/archive_query.py — combine the monthly archive files and the running
database into one analysis database (from 2026-10-11, see database/archive.py).

    # what is where
    python3 tools/archive_query.py --list

    # one SQLite file with all observations / flights of a period, plus the
    # tables that live only in the running database (approach history, GPS
    # quality, episodes, hourly profiles, …)
    python3 tools/archive_query.py --from 2026-09-01 --to 2026-12-31 \\
        --out /tmp/modes_analysis.db

    # quick query against the combined result (prints CSV)
    python3 tools/archive_query.py --from 2026-10-01 --to 2026-10-07 \\
        --sql "SELECT date(ts,'unixepoch') d, COUNT(*) FROM observations GROUP BY d"

The running database and the archive files are only read (attached, never
written), so this can run while the system is collecting.  Rows are
de-duplicated by id, so overlapping periods (a flight crossing a month
boundary, a snapshot taken earlier) are harmless.

Options: --db (default data/modes_meteo.db), --archive (default
data/archive), --no-live (archives only), --tables (extra live tables to
copy; default all small tables).
"""

import argparse
import csv
import datetime
import glob
import os
import sqlite3
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARCHIVED = ("observations", "approach_series", "departure_profiles")   # by ts
LIVE_ONLY = ("approach_history", "profile_hours", "gps_quality_hours", "gps_quality_zone_hours",
             "gps_episodes", "heading_cal", "maintenance_config")


def _ts(date_str, end=False):
    d = datetime.datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=datetime.timezone.utc)
    if end:
        d += datetime.timedelta(days=1)
    return d.timestamp()


def _tables(conn, schema):
    return {r[0] for r in conn.execute(f"SELECT name FROM {schema}.sqlite_master WHERE type='table'")}


def _cols(conn, schema, table):
    return [r[1] for r in conn.execute(f"PRAGMA {schema}.table_info({table})")]


def _ensure(out, src_schema, table):
    """Create table in the output with the source definition / add missing columns."""
    have = _cols(out, "main", table)
    src = _cols(out, src_schema, table)
    if not have:
        sql = out.execute(f"SELECT sql FROM {src_schema}.sqlite_master WHERE type='table' AND name=?",
                          (table,)).fetchone()[0]
        out.execute(sql.replace("REFERENCES flights(id)", ""))   # standalone analysis copy
        return src
    for c in src:
        if c not in have:
            out.execute(f"ALTER TABLE main.{table} ADD COLUMN {c}")
    return src


def sources(args):
    files = sorted(glob.glob(os.path.join(args.archive, "modes_meteo_archive_*.db")))
    if not args.no_live and os.path.exists(args.db):
        files.append(args.db)
    return files


def do_list(args):
    for f in sources(args):
        c = sqlite3.connect(f"file:{f}?mode=ro", uri=True)
        try:
            n, a, b = c.execute("SELECT COUNT(*), MIN(ts), MAX(ts) FROM observations").fetchone()
        except sqlite3.Error:
            n = a = b = None
        fmt = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M") if t else "—"
        print(f"{os.path.basename(f):40s} {os.path.getsize(f) / 1e6:8.1f} MB  "
              f"{n if n is not None else '—':>9} obs  {fmt(a)} … {fmt(b)}")
        c.close()


def build(args, out_path):
    t0 = _ts(args.date_from) if args.date_from else 0.0
    t1 = _ts(args.date_to, end=True) if args.date_to else 1e12
    out = sqlite3.connect(out_path)
    for f in sources(args):
        out.execute("ATTACH DATABASE ? AS src", (f,))      # read only: nothing is written to it
        have = _tables(out, "src")
        for table in ARCHIVED:
            if table not in have:
                continue
            cols = ", ".join(_ensure(out, "src", table))
            out.execute(f"INSERT OR IGNORE INTO main.{table} ({cols}) SELECT {cols} FROM src.{table} "
                        f"WHERE ts >= ? AND ts < ?", (t0, t1))
            if table == "observations" and "flights" in have:
                fc = ", ".join(_ensure(out, "src", "flights"))
                out.execute(f"INSERT OR IGNORE INTO main.flights ({fc}) SELECT {fc} FROM src.flights "
                            f"WHERE id IN (SELECT DISTINCT flight_id FROM src.observations "
                            f"WHERE ts >= ? AND ts < ?)", (t0, t1))
        if f == args.db:
            for table in (args.tables.split(",") if args.tables else LIVE_ONLY):
                if table in have and table not in _tables(out, "main"):
                    cols = ", ".join(_ensure(out, "src", table))
                    out.execute(f"INSERT INTO main.{table} ({cols}) SELECT {cols} FROM src.{table}")
        out.commit()
        out.execute("DETACH DATABASE src")
        print(f"  + {os.path.basename(f)}", file=sys.stderr)
    out.execute("CREATE INDEX IF NOT EXISTS idx_obs_ts ON observations(ts)")
    out.commit()
    return out


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--db", default=os.path.join(ROOT, "data", "modes_meteo.db"))
    p.add_argument("--archive", default=os.path.join(ROOT, "data", "archive"))
    p.add_argument("--from", dest="date_from")
    p.add_argument("--to", dest="date_to")
    p.add_argument("--out")
    p.add_argument("--sql")
    p.add_argument("--list", action="store_true")
    p.add_argument("--no-live", action="store_true")
    p.add_argument("--tables", help="comma-separated live-only tables to copy")
    args = p.parse_args()
    if args.list:
        return do_list(args)
    if not args.out and not args.sql:
        p.error("give --out FILE and/or --sql QUERY (or --list)")
    out = build(args, args.out or ":memory:")
    if args.sql:
        cur = out.execute(args.sql)
        w = csv.writer(sys.stdout)
        w.writerow([d[0] for d in cur.description])
        w.writerows(cur)
    if args.out:
        n = out.execute("SELECT COUNT(*) FROM observations").fetchone()[0]
        print(f"Wrote {args.out}: {n} observations", file=sys.stderr)
    out.close()


if __name__ == "__main__":
    main()
