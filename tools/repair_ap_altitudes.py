#!/usr/bin/env python3
"""
tools/repair_ap_altitudes.py — one-off repair of the stored rows that got
another aircraft's altitude (from 2026-11-06).

Background (collector/receiver.py, AP_ALT_*): an Address/Parity reply (DF0 /
4 / 16 / 20) read with a bit error in its parity field is taken as the reply
of another aircraft, mostly one whose address is one bit away.  With the
second receiver merged (from 2 Nov 2026 12 UTC) about 1–3 % of the stored
rows got such an altitude: their wind and temperature are the aircraft's own,
but stored thousands of feet too high or low.  From 6 Nov 2026 the collector
drops these replies; this tool removes the rows stored before that.

The reference: the aircraft's own ADS-B altitudes of height_series, without
the stale points (from 2026-11-07, _drop_stale): until the collector's fix of
that day, a row there could carry the altitude of minutes before when the
airborne positions had paused — 25 of 32 suspects of 6–7 Nov were such false
alarms.

A row is taken as wrong when
  • its altitude does not fit the aircraft's own ADS-B altitude (height_series,
    DF17 — CRC-checked) of at most 20 s before or after it: the collector's
    check (receiver.ap_alt_suspect), or
  • (from the afternoon of 6 Nov 2026, the collector's neighbour test,
    receiver.ap_nb_suspect) it is more than 200 ft off the aircraft's own
    altitude and within 100 ft of the ADS-B altitude (at most 5 s apart) of an
    aircraft whose address is one bit away — the parallel approaches 1 000 ft
    apart, which the first test lets through, or
  • (no ADS-B altitude near it) it jumps more than 4 000 ft away from both
    neighbouring rows of the aircraft that agree with each other (within 60 s).

Default: a dry run — counts per day and examples, nothing is written.
With --apply:
  1. the wrong rows are saved to data/repair_ap_alt_<UTC time>.json.gz (to put
     back if ever needed) and deleted from observations;
  2. the hourly profile archive (profile_hours) of the hours with removed rows
     is computed again in place (the METAR surface values "m" are kept);
  3. the hourly products of those hours (kinematics_hours, gnss_hours,
     bl_hours) are computed again, and the radiosonde verification rows from
     --since on are removed: the hourly job adds them again within the hour.

Run on the server with the new collector already running (so that no new
wrong rows come in); the collector can keep running:

    cd ~/mode_s_wind && venv/bin/python tools/repair_ap_altitudes.py           # dry run
    cd ~/mode_s_wind && venv/bin/python tools/repair_ap_altitudes.py --apply

Options: --db (default the configured DB_PATH), --since (default
2026-11-02T12:00, UTC), --until (default now).
"""

from __future__ import annotations

import argparse
import bisect
import collections
import datetime as dt
import gzip
import json
import os
import sqlite3
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from config import Config                      # noqa: E402
import config_override                         # noqa: E402
config_override.apply(Config)

from collector.receiver import (ap_alt_suspect, AP_ALT_REF_SEC, AP_ALT_RATE_FT_S, AP_ALT_GATE_FT,   # noqa: E402
                                AP_NB_OWN_FT, AP_NB_MATCH_FT, AP_NB_FRESH_SEC)
from collector.height_series import decode as hs_decode         # noqa: E402

SPIKE_FT = 4000          # fallback test: jump from both neighbours
SPIKE_PAIR_FT = 1500     # … that agree with each other within this
SPIKE_SPAN_SEC = 60      # … and lie within this


def _utc(s: str) -> float:
    d = dt.datetime.fromisoformat(s)
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return d.timestamp()


def _day(ts: float) -> str:
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%d")


def adsb_altitudes(db, t0: float, t1: float) -> dict:
    """{icao: [(t, alt), …]} — the aircraft's own ADS-B altitudes (height_series)."""
    out = collections.defaultdict(list)
    for icao, blob in db.execute(
            "SELECT icao, data FROM height_series WHERE t_end >= ? AND ts <= ?", (t0 - 60, t1 + 60)):
        try:
            d = hs_decode(blob)
        except Exception:                      # noqa: BLE001  (a damaged row)
            continue
        pts = [(t, a) for t, a in zip(d.get("t", []), d.get("alt", [])) if t is not None and a is not None]
        out[icao].extend(_drop_stale(pts))
    for v in out.values():
        v.sort()
    return out


STALE_BACK_SEC = 300     # how far back an old altitude is looked for before an impossible jump


def _drop_stale(pts: list) -> list:
    """The height_series points without the stale altitudes (from 2026-11-07).
    Until the collector's fix of 7 Nov 2026 a GMB / NACp change wrote a row with
    the aircraft's last altitude also while its airborne positions had paused
    (461FA1 6 Nov 19:46: 39 000 ft one second, 4 875 ft the next).  A step to
    the next point faster than AP_ALT_RATE_FT_S (+ AP_ALT_GATE_FT) marks the
    point before it, and the points of the same altitude just before that
    (at most STALE_BACK_SEC), as stale."""
    pts = sorted(pts)
    bad = set()
    for i in range(len(pts) - 1):
        (t1, a1), (t2, a2) = pts[i], pts[i + 1]
        if abs(a2 - a1) > AP_ALT_GATE_FT + AP_ALT_RATE_FT_S * max(0.0, t2 - t1):
            j = i
            while j >= 0 and pts[j][1] == a1 and t1 - pts[j][0] <= STALE_BACK_SEC:
                bad.add(j)
                j -= 1
    return [p for k, p in enumerate(pts) if k not in bad]


def find_wrong(db, t0: float, t1: float):
    """[(id, icao, ts, altitude, why, ref)] of the rows with another aircraft's altitude."""
    ref = adsb_altitudes(db, t0, t1)
    rows = db.execute(
        "SELECT id, icao, ts, altitude FROM observations WHERE ts >= ? AND ts < ? AND altitude IS NOT NULL "
        "ORDER BY icao, ts", (t0, t1)).fetchall()
    by = collections.defaultdict(list)
    for r in rows:
        by[r[1]].append(r)
    wrong = []
    keys = set(ref)

    def adsb_near(ic, ts, within):
        L = ref.get(ic)
        if not L:
            return None
        j = bisect.bisect_right(L, (ts, float("inf")))
        c = [L[k] for k in (j - 1, j) if 0 <= k < len(L) and abs(L[k][0] - ts) <= within]
        return min(c, key=lambda x: abs(x[0] - ts)) if c else None

    for icao, lst in by.items():
        L = ref.get(icao, [])
        try:
            nbs = [n for n in (f"{int(icao, 16) ^ (1 << k):06X}" for k in range(24)) if n in keys]
        except ValueError:
            nbs = []
        for i, (rid, _ic, ts, alt) in enumerate(lst):
            # 1. against the aircraft's own ADS-B altitude (the nearer of the
            #    points just before and just after, within AP_ALT_REF_SEC)
            j = bisect.bisect_right(L, (ts, float("inf")))
            near = [L[k] for k in (j - 1, j) if 0 <= k < len(L) and abs(L[k][0] - ts) <= AP_ALT_REF_SEC]
            if near:
                if all(ap_alt_suspect(alt, a, t, ts) for t, a in near):
                    wrong.append((rid, icao, ts, alt, "adsb", near[0][1]))
                elif nbs and all(abs(alt - a) > AP_NB_OWN_FT + AP_ALT_RATE_FT_S * abs(ts - t) for t, a in near):
                    for n in nbs:
                        q = adsb_near(n, ts, AP_NB_FRESH_SEC)
                        if q and abs(alt - q[1]) <= AP_NB_MATCH_FT + AP_ALT_RATE_FT_S * abs(ts - q[0]):
                            wrong.append((rid, icao, ts, alt, "neighbour " + n, near[0][1]))
                            break
                continue
            # 2. no ADS-B altitude near: a spike between two agreeing neighbours
            if 0 < i < len(lst) - 1:
                p, n = lst[i - 1], lst[i + 1]
                if (n[2] - p[2] < SPIKE_SPAN_SEC and abs(p[3] - n[3]) < SPIKE_PAIR_FT
                        and abs(alt - (p[3] + n[3]) / 2) > SPIKE_FT):
                    wrong.append((rid, icao, ts, alt, "spike", round((p[3] + n[3]) / 2)))
    return wrong, len(rows)


def save_rows(db, ids: list, path: str) -> None:
    cols = [r[1] for r in db.execute("PRAGMA table_info(observations)")]
    out = []
    for k in range(0, len(ids), 500):
        part = ids[k:k + 500]
        q = ",".join("?" * len(part))
        out += [dict(zip(cols, r)) for r in db.execute(f"SELECT * FROM observations WHERE id IN ({q})", part)]
    with gzip.open(path, "wt", encoding="utf-8") as f:
        json.dump({"table": "observations", "saved": time.time(), "rows": out}, f, separators=(",", ":"))


def main() -> int:
    cfg = Config()
    ap = argparse.ArgumentParser(description="Remove the stored rows with another aircraft's altitude.")
    ap.add_argument("--db", default=cfg.DB_PATH)
    ap.add_argument("--since", default="2026-11-02T12:00")
    ap.add_argument("--until", default=None)
    ap.add_argument("--apply", action="store_true", help="delete and recompute (default: dry run)")
    a = ap.parse_args()
    t0 = _utc(a.since)
    t1 = _utc(a.until) if a.until else time.time()

    db = sqlite3.connect(a.db, timeout=30.0)
    db.row_factory = None
    db.execute("PRAGMA journal_mode = WAL")
    wrong, n_rows = find_wrong(db, t0, t1)
    per_day = collections.Counter(_day(w[2]) for w in wrong)
    per_why = collections.Counter(w[4].split()[0] for w in wrong)
    print(f"Rows {_day(t0)} … {_day(t1)}: {n_rows}; with another aircraft's altitude: {len(wrong)} "
          f"(against ADS-B {per_why['adsb']}, one-bit neighbour {per_why['neighbour']}, spikes {per_why['spike']})")
    for d in sorted(per_day):
        print(f"  {d}  {per_day[d]}")
    shown = [w for w in wrong if w[4].startswith("neighbour")][:5]
    for w in shown + [w for w in wrong if w not in shown][:10 - len(shown)]:
        print(f"  e.g. {w[1]} {dt.datetime.fromtimestamp(w[2], dt.timezone.utc):%d.%m. %H:%M:%S} "
              f"stored {w[3]} ft, own {w[5]} ft ({w[4]})")
    if not a.apply:
        print("Dry run — nothing changed (add --apply).")
        return 0
    if not wrong:
        return 0

    ids = [w[0] for w in wrong]
    path = os.path.join(os.path.dirname(os.path.abspath(a.db)),
                        f"repair_ap_alt_{dt.datetime.now(dt.timezone.utc):%Y%m%d_%H%M}.json.gz")
    save_rows(db, ids, path)
    print(f"Saved the {len(ids)} rows to {path}")
    for k in range(0, len(ids), 500):
        part = ids[k:k + 500]
        db.execute(f"DELETE FROM observations WHERE id IN ({','.join('?' * len(part))})", part)
        db.commit()
    print(f"Deleted {len(ids)} rows from observations")

    hours = sorted({int(w[2] // 3600 * 3600) for w in wrong})
    cur = int(time.time() // 3600 * 3600)
    hours = [h for h in hours if h < cur]

    # 2. the hourly profile archive, in place (keeps "m")
    from collector.atmos import area_profile, pack_levels
    db.row_factory = sqlite3.Row
    n_p = 0
    for h in hours:
        r = db.execute("SELECT data FROM profile_hours WHERE ts = ?", (h,)).fetchone()
        if not r:
            continue
        rec = json.loads(r["data"])
        levels, used, n_ac = area_profile(db, h, h + 3600, cfg.RECEIVER_LAT, cfg.RECEIVER_LON,
                                          cfg.SOUNDING_RADIUS_KM, with_aircraft=True)
        if not used:
            continue
        rec.update({"n": used, "a": n_ac, "lv": pack_levels(levels)})
        db.execute("UPDATE profile_hours SET data = ? WHERE ts = ?", (json.dumps(rec, separators=(",", ":")), h))
        n_p += 1
        time.sleep(0.05)
    db.commit()
    print(f"Hourly profile archive: {n_p} hour(s) computed again")

    # 3. the hourly products of those hours
    max_h = int((cur - min(hours)) // 3600) + 2 if hours else 48
    try:
        from collector.kinematics import store_missing_kinematics_hours
        db.executemany("DELETE FROM kinematics_hours WHERE ts = ?", [(h,) for h in hours])
        db.commit()
        n_k = store_missing_kinematics_hours(db, cfg.RECEIVER_LAT, cfg.RECEIVER_LON,
                                             float(getattr(cfg, "KINEMATICS_RADIUS_KM", 200)),
                                             max_hours=max_h, pause_sec=0.05)
        print(f"Kinematics: {n_k} hour(s) computed again")
    except Exception as exc:                   # noqa: BLE001
        print(f"Kinematics: not recomputed ({exc}) — a restart back-fills them")
    try:
        from collector import gnss_heights as gh
        db.executemany("DELETE FROM gnss_hours WHERE ts = ?", [(h,) for h in hours])
        db.commit()
        n_g = gh.store_missing_gnss_hours(db, cfg.RECEIVER_LAT, cfg.RECEIVER_LON, cfg.SOUNDING_RADIUS_KM,
                                          max_hours=max_h, pause_sec=0.05)
        print(f"GNSS heights: {n_g} hour(s) computed again")
    except Exception as exc:                   # noqa: BLE001
        print(f"GNSS heights: not recomputed ({exc}) — a restart back-fills them")
    try:
        from collector import boundary as bl
        n_b = bl.recompute(db, hours, pause_sec=0.05)
        print(f"Boundary layer: {n_b} hour(s) computed again")
    except Exception as exc:                   # noqa: BLE001
        print(f"Boundary layer: not recomputed ({exc})")
    try:
        n_s = db.execute("DELETE FROM sonde_verification WHERE ts >= ?", (int(t0) - 3600,)).rowcount
        db.commit()
        print(f"Radiosonde verification: {n_s} row(s) removed — the hourly job adds them again")
    except Exception as exc:                   # noqa: BLE001
        print(f"Radiosonde verification: not changed ({exc})")
    db.close()
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
