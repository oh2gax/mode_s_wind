"""
height_series.py — dense GNSS-height / pressure-altitude series per aircraft
visit (research data, from 2026-10-20).

The stored observations carry the GNSS − baro altitude difference only once
per throttled row (about every 30 s / 1 000 ft).  The aircraft broadcast it
about twice a second (ADS-B TC 19), and their pressure altitude in every
airborne-position message (TC 9–18).  Both come in 25 ft steps, so a series
that records a row only when one of them **steps** is lossless and small:

  row = (t, pressure altitude ft, GNSS − baro ft, lat, lon, NACp)

written when the pressure altitude or the GNSS − baro difference changes,
when NACp changes, when the difference stops arriving (GNSS lost → None),
and as a position keyframe at least every KEYFRAME_SEC.  Toggling between
two neighbouring values in level flight (the 25 ft rounding boundary) is
recorded at most once per TOGGLE_SEC.

Uses: GNSS heights of pressure surfaces at full resolution, thin-layer
thickness / virtual temperatures from climbs and descents, the level-leg
geostrophic wind from the along-track change of the difference, and the
speed-dependent altimeter error (difference against Mach in level flight).

One row per aircraft visit in height_series (ends after END_GAP_SEC without
messages, or after MAX_ROWS / MAX_SPAN_SEC); data = zlib-compressed JSON
{"v", "t0", "icao", "cs", "cols": [[name, scale, delta], …], <col>: [ints]}:
value = cumsum(col) / scale for delta-coded columns, col / scale otherwise,
None stays None; t is seconds after t0.  About 2–4 kB for a climb or a
descent, well under 1 kB for a level overflight.  Visits with fewer than
MIN_GMB_ROWS rows carrying the difference are not stored.

All calls come from the collector thread (receiver.run_collector); finished
visits are written in one transaction every FLUSH_SEC.
"""

from __future__ import annotations

import json
import logging
import zlib

log = logging.getLogger("modes.height_series")

COLS = (("t", 10, True), ("alt", 1, True), ("gmb", 1, True),
        ("lat", 10000, True), ("lon", 10000, True), ("nacp", 1, False))
KEYFRAME_SEC = 20.0     # position row at least this often
TOGGLE_SEC = 10.0       # a change back to the previous value is recorded at most this often
GMB_LOST_SEC = 10.0     # no TC 19 difference for this long → recorded as None
END_GAP_SEC = 300.0     # visit ends after this long without messages
MAX_ROWS = 20000        # … or with this many rows
MAX_SPAN_SEC = 4 * 3600.0
MIN_GMB_ROWS = 10       # store a visit only with at least this many rows with a difference
MIN_SPAN_SEC = 60.0
FLUSH_SEC = 60.0


class _Track:
    __slots__ = ("icao", "cs", "rows", "t0", "last_msg", "last_row_t",
                 "alt", "alt_dir", "alt_t", "gmb", "gmb_dir", "gmb_t", "gmb_seen",
                 "lat", "lon", "nacp", "n_gmb", "alt_min", "alt_max")

    def __init__(self, icao: str, ts: float):
        self.icao, self.cs, self.rows = icao, None, []
        self.t0 = self.last_msg = ts
        self.last_row_t = -1e18
        self.alt = self.alt_dir = None
        self.alt_t = -1e18
        self.gmb = self.gmb_dir = None
        self.gmb_t = -1e18
        self.gmb_seen = -1e18
        self.lat = self.lon = self.nacp = None
        self.n_gmb = 0
        self.alt_min = self.alt_max = None

    def row(self, ts: float) -> None:
        self.rows.append((ts, self.alt, self.gmb, self.lat, self.lon, self.nacp))
        self.last_row_t = ts
        if self.gmb is not None:
            self.n_gmb += 1


def _accept(new: int, cur, cur_dir, cur_t: float, ts: float):
    """Step filter for a 25 ft quantity: (accept, direction).  A step in the
    same direction as the previous one, or of ≥ 50 ft, is always taken; a
    step back to the other side of a rounding boundary only every TOGGLE_SEC."""
    if cur is None:
        return True, None
    if new == cur:
        return False, cur_dir
    d = 1 if new > cur else -1
    if cur_dir is None or d == cur_dir or abs(new - cur) >= 50 or ts - cur_t >= TOGGLE_SEC:
        return True, d
    return False, cur_dir


def encode(tr: _Track) -> bytes:
    t0 = tr.rows[0][0]
    out = {"v": 1, "t0": round(t0, 1), "icao": tr.icao, "cs": tr.cs,
           "cols": [list(c) for c in COLS]}
    for i, (name, scale, delta) in enumerate(COLS):
        vals, prev = [], 0
        for r in tr.rows:
            v = r[i]
            if i == 0:
                v = v - t0
            if v is None:
                vals.append(None)
                continue
            iv = int(round(v * scale))
            if delta:
                vals.append(iv - prev)
                prev = iv
            else:
                vals.append(iv)
        out[name] = vals
    return zlib.compress(json.dumps(out, separators=(",", ":")).encode(), 9)


def decode(blob: bytes) -> dict:
    """Inverse of encode (for analysis scripts): {"t0", "icao", "cs", "t": [...],
    "alt": [...], "gmb": [...], "lat", "lon", "nacp"} with absolute values."""
    d = json.loads(zlib.decompress(blob))
    for name, scale, delta in d.get("cols", []):
        acc, res = 0, []
        for v in d.get(name, []):
            if v is None:
                res.append(None)
                continue
            if delta:
                acc += v
                v = acc
            res.append(v / scale)
        if name == "t":
            res = [round(v + d["t0"], 1) for v in res]
        d[name] = res
    return d


class HeightSeries:
    def __init__(self, enabled: bool = True):
        self.enabled = enabled
        self._tr: dict[str, _Track] = {}
        self._done: list[_Track] = []
        self._next_flush = 0.0
        self.stored = 0          # visits written since start (status / log)

    def _track(self, icao: str, ts: float) -> _Track:
        tr = self._tr.get(icao)
        if tr is not None and (ts - tr.last_msg > END_GAP_SEC or len(tr.rows) >= MAX_ROWS
                               or ts - tr.t0 > MAX_SPAN_SEC):
            self._close(tr)
            tr = None
        if tr is None:
            tr = self._tr[icao] = _Track(icao, ts)
        tr.last_msg = ts
        return tr

    # ── message hooks ───────────────────────────────────────────────────────
    def position(self, icao: str, ts: float, alt, lat, lon, callsign=None) -> None:
        """Airborne position (TC 9–18): barometric pressure altitude (ft)."""
        if not self.enabled or alt is None:
            return
        tr = self._track(icao, ts)
        if callsign:
            tr.cs = callsign
        if lat is not None and lon is not None:
            tr.lat, tr.lon = lat, lon
        alt = int(alt)
        tr.alt_min = alt if tr.alt_min is None else min(tr.alt_min, alt)
        tr.alt_max = alt if tr.alt_max is None else max(tr.alt_max, alt)
        rec = False
        ok, d = _accept(alt, tr.alt, tr.alt_dir, tr.alt_t, ts)
        if ok:
            tr.alt, tr.alt_dir, tr.alt_t = alt, d, ts
            rec = True
        if tr.gmb is not None and ts - tr.gmb_seen > GMB_LOST_SEC:
            tr.gmb, tr.gmb_dir = None, None          # GNSS difference no longer sent
            rec = True
        if rec or ts - tr.last_row_t >= KEYFRAME_SEC:
            tr.row(ts)

    def gmb(self, icao: str, ts: float, value) -> None:
        """Airborne velocity (TC 19): GNSS − baro altitude difference (ft)."""
        if not self.enabled or value is None:
            return
        tr = self._track(icao, ts)
        tr.gmb_seen = ts
        value = int(value)
        ok, d = _accept(value, tr.gmb, tr.gmb_dir, tr.gmb_t, ts)
        if ok:
            tr.gmb, tr.gmb_dir, tr.gmb_t = value, d, ts
            if tr.alt is not None:
                tr.row(ts)

    def nacp(self, icao: str, ts: float, value) -> None:
        if not self.enabled or value is None:
            return
        tr = self._tr.get(icao)
        if tr is None or tr.nacp == value:
            if tr is not None:
                tr.last_msg = ts
            return
        tr.nacp = value
        tr.last_msg = ts
        if tr.alt is not None:
            tr.row(ts)

    # ── closing and writing ─────────────────────────────────────────────────
    def _close(self, tr: _Track) -> None:
        self._tr.pop(tr.icao, None)
        if (tr.n_gmb >= MIN_GMB_ROWS and len(tr.rows) >= 2
                and tr.rows[-1][0] - tr.rows[0][0] >= MIN_SPAN_SEC):
            self._done.append(tr)

    def tick(self, now: float, db_fn) -> None:
        """Close idle visits and write the finished ones (every FLUSH_SEC)."""
        if not self.enabled or now < self._next_flush:
            return
        self._next_flush = now + FLUSH_SEC
        for tr in [t for t in self._tr.values() if now - t.last_msg > END_GAP_SEC]:
            self._close(tr)
        self._write(db_fn)

    def flush_all(self, db_fn) -> None:
        for tr in list(self._tr.values()):
            self._close(tr)
        self._write(db_fn)

    def _write(self, db_fn) -> None:
        if not self._done:
            return
        done, self._done = self._done, []
        try:
            db = db_fn()
            db.executemany(
                "INSERT INTO height_series (ts, t_end, icao, callsign, n, n_gmb, alt_min, alt_max, data) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                [(tr.rows[0][0], tr.rows[-1][0], tr.icao, tr.cs, len(tr.rows), tr.n_gmb,
                  tr.alt_min, tr.alt_max, encode(tr)) for tr in done])
            db.commit()
            self.stored += len(done)
        except Exception as exc:
            log.warning("height_series DB write failed (%d visits dropped): %s", len(done), exc)
