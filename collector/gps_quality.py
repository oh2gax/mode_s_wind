"""
collector/gps_quality.py

Area-wide GPS quality monitor.  Runs as a background sweep thread and
analyses every tracked aircraft for signs of GPS degradation:

  1. NACp degradation  — Navigation Accuracy Category (position) ≤ threshold.
     Sourced from TC=29 / TC=31 ADS-B messages decoded by receiver.py.
     NACp 0–6 = accuracy worse than ~0.1 NM; operationally significant.

  2. Position freeze   — lat/lon unchanged across GPS_FREEZE_POLLS consecutive
     sweeps while groundspeed exceeds GPS_MIN_GS_KT.  The aircraft is clearly
     moving but its GPS output is stuck at the last valid fix.

  3. Position gap      — no ADS-B position message received for GPS_GAP_SEC
     seconds while EHS (altitude + groundspeed) data is still arriving.
     The transponder is alive but the GPS source has dropped out.

Hourly bucket data is persisted to the SQLite ``gps_quality_hours`` table
so that history survives process restarts.  Only *completed* hours are
written — exactly 24 rows per day — so the write load is negligible.
On startup the tracker reloads the last MAX_BUCKETS hours (currently 6
months) from the DB, restoring the time-series chart and heatmap instantly.
The current (incomplete) hour lives in RAM only and is lost on an unplanned
restart, but that is an acceptable trade-off (≤ 59 minutes of data).
The heatmap response is capped independently at HEATMAP_MAX_BUCKETS (31
days) since the heatmap canvas only ever renders the most recent 14 days —
no need to ship 6 months of buckets for a field that gets truncated anyway.

Per-band detail (since 2026-10-06)
----------------------------------
Each hourly row also stores ``band_detail`` (JSON): distinct aircraft seen
per FL band (``ac``), distinct degraded aircraft per band (``deg``) and the
signal mix per band (``sig``).  Older rows have NULL.

Degradation episode log (since 2026-10-06)
------------------------------------------
One ``gps_episodes`` row per aircraft per continuous degraded period
(clean gaps shorter than EPISODE_MERGE_SEC are merged), for aircraft within
episode_radius_nm (default 100 NM) of the airport when the episode starts.
Start / end / recovery snapshots (position, altitude, track, vertical rate,
groundspeed, distance), altitude range, lowest NACp / NIC, signals seen and
how the episode ended.  Closed episodes are buffered in RAM and written in
the same transaction as the 60-s current-hour checkpoint, so each row is
written once and no extra commits are needed.  The episodes still open are
saved in the same checkpoint (gps_quality_live row "_episodes"); after a
restart within EPISODE_RESTORE_MAX_SEC they continue, after a longer stop
they are written with end_reason "shutdown".  Never auto-purged; manual
purge on the Maintenance page.

Finer detail for later analysis (since 2026-10-09)
--------------------------------------------------
All of this rides along in the existing writes (the hourly rows' band_detail
JSON, the 60-s checkpoint and the episode rows) — no extra commits.

  * 10-minute resolution — band_detail "t10": six 10-minute slots per hour
    with distinct aircraft seen (ac), degraded (deg), severely degraded (sev)
    and with a spoofing indicator (spf), all altitudes, plus seen / degraded
    in FL050–250 (mac / mdeg).  Per zone, like the hourly row.
  * Severity — an aircraft is *severely* degraded when its position is
    unusable: fresh NACp 0 (accuracy unknown or ≥ 10 NM), NIC 0 (no
    integrity) or no own ADS-B position (ADS-B loss / Gap).  band_detail
    "sev" = distinct severe aircraft per FL band, "s0" = severe sweeps per
    band split into nacp0 / nic0 / nopos.  NACp 1–6 is the milder rest.
  * Spoofing indicators (not part of the degradation signals; the counts
    above and the episode definition are unchanged):
      mlat_dis — own ADS-B position disagrees with the MLAT position
                 (both ≤ SPOOF_POS_SEC old) by more than MLAT_DIS_NM plus the
                 distance flown in the time difference, on two consecutive
                 comparisons with new positions on both sides (a single MLAT or
                 decoding outlier is ignored; since the evening of 2026-10-09)
                 (per sweep)
      gmb_sat  — GNSS − baro altitude difference (TC 19) at its largest
                 encodable value (> 3137 ft) (per sweep)
      gmb_jump — GNSS − baro difference changed by ≥ GMB_JUMP_FT between
                 two reports ≤ GMB_FRESH_SEC apart (per change)
      pos_jump — own ADS-B position stepped further than the groundspeed
                 allows, confirmed by the next position (a single CPR
                 outlier is ignored) (per jump)
    band_detail "spf" = counts per FL band (+ "cmp" = sweeps where an
    ADS-B/MLAT comparison was possible, "gmb_n" = sweeps with a fresh GNSS −
    baro value), "spa" = distinct aircraft per band, and in the 'all' zone
    "spl" = the flagged aircraft (up to SPOOF_LIST_MAX per hour) with first
    time, altitude, distance and the largest values.  Episode rows get the
    indicators seen while the episode was open (also during the recovery
    window), the largest ADS-B/MLAT distance, the GNSS − baro range, the
    number of severe sweeps and of ADS-B/MLAT comparisons.
    Normal-quality flags (since the evening of 2026-10-09): an indicator raised
    while the aircraft reports normal GPS quality (fresh NACp above the
    threshold and no degradation signal) is the strong spoofing case — a
    false position the aircraft believes in.  Counted per band as
    "ok_<kind>"; each "spl" entry has the NACp at the first flag ("nacp") and
    the kinds raised with normal quality ("q").  Indicators during jamming
    (NACp 0) are more likely the receiver re-acquiring after the outage.
    MLAT (Radarcape network) covers mainly higher altitudes, e.g. over the
    Gulf of Finland; low near EFHK there is practically no MLAT, so mlat_dis
    is a high-altitude check.

Thread safety
-------------
  GpsQualityTracker._lock (RLock) protects all mutable state.
  The Flask endpoint calls get_state() which acquires the lock briefly
  to take a snapshot; the sweep thread holds the lock only during update().
"""

import json
import math
import threading
import time
import logging
from collections import deque

from database.db import get_db

log = logging.getLogger("modes.gps_quality")

# ── FL band definitions ───────────────────────────────────────────────────────
# Each entry: (lower_ft, upper_ft, label)
# Altitude is pressure altitude in feet (ADS-B barometric altitude).
# FL = pressure altitude / 100, so FL050 = 5 000 ft.
FL_BANDS = [
    ( 1_000,  3_000, "010-030"),
    ( 3_000,  5_000, "030-050"),
    ( 5_000,  8_000, "050-080"),
    ( 8_000, 10_000, "080-100"),
    (10_000, 15_000, "100-150"),
    (15_000, 20_000, "150-200"),
    (20_000, 25_000, "200-250"),
    (25_000, 30_000, "250-300"),
    (30_000, 99_999, "300+"),
]
FL_BAND_LABELS = [b[2] for b in FL_BANDS]
# NOTE: the former single "050-100" band was split into "050-080" / "080-100"
# on 2026-09-07. Historical gps_quality_hours / gps_quality_zone_hours rows
# written before that date still have their events keyed under the old
# "050-100" label inside the stored fl_bands JSON blob. Those events are not
# lost, but they will not appear under either new band — fl.get(lbl, 0) in
# _load_from_db / _load_zones_from_db simply returns 0 for a label that
# doesn't exist in an old row. Only new events recorded after the split are
# correctly split between the two new bands.

# ── Bucket duration ───────────────────────────────────────────────────────────
BUCKET_SEC    = 3_600          # one hour per bucket
MAX_BUCKETS   = 180 * 24       # 6 months rolling — covers the GPS Quality page's
                                # longest time-series selector (6m); also the DB
                                # reload cutoff on startup (_load_from_db / _load_zones_from_db)
HEATMAP_MAX_BUCKETS = 31 * 24  # heatmap only ever renders the most recent 14 days
                                # client-side (HEATMAP_MAX_DAYS in gps_quality.js) —
                                # capped independently so its payload doesn't grow
                                # with the longer time-series window above

# ── Counting-method version ───────────────────────────────────────────────────
# Stored with every hourly bucket so charts can mark where the way events are
# counted changed (numbers before and after a change are not comparable).
#   1 — until 2026-09-25 11:00 UTC: live_state was never pruned; an aircraft
#       returning hours/days later carried its old ADS-B timestamp and position,
#       inflating ADS-B loss (and Freeze) the longer the app ran
#   2 — 2026-09-25 11:00 UTC: live_state pruned after 10 min of silence
#   3 — 2026-09-26: ADS-B loss counted per visit (aircraft must be transmitting
#       extended squitters now); current hour survives restarts (checkpoint)
#   4 — 2026-09-26: all signals require the aircraft to be heard by our own
#       receiver; Freeze = own ADS-B positions keep arriving with identical
#       coordinates; Gap = no position update from any source; new NIC
#       (integrity) signal; NACp version-aware and only while fresh
METHOD_VERSION = 4

# ── ADS-B loss (per visit) ────────────────────────────────────────────────────
# An aircraft counts as ADS-B-active if any DF17 extended squitter was
# received within ES_ACTIVE_SEC.  ADS-B loss = ADS-B-active, position known
# (e.g. MLAT) but no own ADS-B position for ≥ gap_sec during this visit.
ES_ACTIVE_SEC = 30.0

# ── Own-reception / freshness windows (METHOD_VERSION 4) ──────────────────────
HEARD_SEC        = 60.0   # aircraft counted only if our receiver heard it within this window
QUALITY_FRESH_SEC = 30.0  # NACp / NIC values older than this are ignored
FREEZE_POS_SEC   = 10.0   # own ADS-B position must be this recent for a Freeze check

# ── Current-hour checkpoint ───────────────────────────────────────────────────
CHECKPOINT_SEC = 60.0     # write the in-progress hour to gps_quality_live

# ── Distance-zone filtering ───────────────────────────────────────────────────
# Zone names and their radius limits in nautical miles.
# 'all' zone uses the existing gps_quality_hours table (no filtering).
# Distance zones use gps_quality_zone_hours and count only aircraft whose
# last-known position is within the specified radius from the airport.
ZONE_LIMITS_NM: dict[str, float] = {
    "50nm": 50.0,
    "20nm": 20.0,
}
# Maximum age of a last-known position to be used for zone assignment when
# the current position is absent (Position Gap events).  2 minutes is enough
# for an aircraft on final approach to remain within the zone boundary.
LAST_POS_MAX_AGE_SEC = 120.0

# ── Degradation episode log ───────────────────────────────────────────────────
SIG_ORDER          = ("nacp", "nic", "freeze", "gap", "adsb_loss")
EPISODE_MERGE_SEC  = 120.0   # a clean period shorter than this does not end an episode
EPISODE_RADIUS_NM  = 100.0
EPISODE_BUF_MAX    = 20_000   # closed episodes kept for retry while the DB is unwritable
EPISODE_LIVE_KEY   = "_episodes"  # gps_quality_live row holding the open episodes
EPISODE_RESTORE_MAX_SEC = 600.0   # after a restart within this time, open episodes continue;
                                  # after a longer stop they are saved with end_reason "shutdown"   # default: episodes start only within this distance of the airport

# ── 10-minute slots / severity / spoofing indicators (since 2026-10-09) ────────
SLOT_SEC       = 600                 # 10-minute slots inside the hourly bucket
SLOTS          = BUCKET_SEC // SLOT_SEC
T10_KEYS       = ("ac", "deg", "sev", "spf", "mac", "mdeg")
MID_LO_FT, MID_HI_FT = 5_000, 25_000  # "mid" altitude range FL050–250
SPOOF_KINDS    = ("mlat_dis", "gmb_sat", "gmb_jump", "pos_jump")
SPOOF_POS_SEC  = 10.0    # own ADS-B and MLAT positions must be this recent to compare
MLAT_DIS_NM    = 2.0     # ADS-B vs MLAT disagreement floor (MLAT error)
MLAT_SLACK_SEC = 5.0     # JSON poll interval / position age uncertainty
MLAT_CONFIRM_SEC = 20.0  # a second mismatching comparison must follow within this
GMB_FRESH_SEC  = 30.0    # GNSS − baro value must be this recent
GMB_JUMP_FT    = 500     # GNSS − baro change counted as a jump
GMB_SAT_FT     = 3150    # largest encodable |GNSS − baro| (> 3137.5 ft)
JUMP_MIN_NM    = 2.0     # position step allowed beyond 1.5 × groundspeed × time
JUMP_MAX_DT    = 60.0    # no jump check across a longer break in own positions
SPOOF_LIST_MAX = 100     # flagged aircraft listed per hour ('all' zone)
FINE_DETAIL_SINCE = 1791504000   # 2026-10-09 00:00 UTC — severity / spoofing / 10-min data
DETAIL_MAX_HOURS = 31 * 24   # /api/gps/detail window limit
SPOOF_LIST_OUT   = 300       # flagged aircraft returned by get_detail()
GS_UNKNOWN_KT  = 600.0   # groundspeed assumed for the allowances when unknown

# ── ADS-B loss detection ──────────────────────────────────────────────────────
# Fires when the aircraft still has a visible position (kept alive by MLAT) but
# its own Beast-feed ADS-B GPS position timestamp has not been updated for
# ≥ gap_sec seconds.  The timestamp is maintained by receiver.py whenever a
# TC=9-18/20-22 airborne-position message arrives in the Beast feed.
# No debounce counter is needed — the gap_sec time threshold is sufficient.


def _haversine_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Return the great-circle distance in nautical miles between two points."""
    R_NM = 3_440.065   # Earth mean radius in nautical miles
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return R_NM * 2 * math.asin(math.sqrt(a))


def _fl_band(altitude_ft: float | None) -> str | None:
    """Return the FL band label for a pressure altitude, or None if unknown."""
    if altitude_ft is None:
        return None
    for lo, hi, label in FL_BANDS:
        if lo <= altitude_ft < hi:
            return label
    return FL_BAND_LABELS[-1]   # ≥ FL300


def _seen_band(altitude_ft: float | None) -> str | None:
    """FL band for the per-band aircraft count; None below the lowest band."""
    if altitude_ft is None or altitude_ft < FL_BANDS[0][0]:
        return None
    return _fl_band(altitude_ft)


def _nz(dd: dict) -> dict:
    """{band: {key: n}} without zero counts / empty bands."""
    return {lbl: {k: n for k, n in d.items() if n} for lbl, d in dd.items() if any(d.values())}


def _band_detail(b: dict) -> dict:
    """Per-band detail for one bucket: distinct aircraft seen / degraded and
    the signal mix per FL band (non-zero entries only), plus the finer
    detail added 2026-10-09 (severity, spoofing indicators, 10-min slots)."""
    seen = b.get("_band_seen", {})
    deg  = b.get("_band_deg", {})
    det = {
        "ac":  {lbl: len(v) for lbl, v in seen.items() if v},
        "deg": {lbl: len(v) for lbl, v in deg.items() if v},
        "sig": _nz(b.get("band_sig", {})),
    }
    sev = {lbl: len(v) for lbl, v in b.get("_band_sev", {}).items() if v}
    if sev:
        det["sev"] = sev
    s0 = _nz(b.get("band_sev", {}))
    if s0:
        det["s0"] = s0
    spf = _nz(b.get("band_spf", {}))
    if spf:
        det["spf"] = spf
    spa = {lbl: len(v) for lbl, v in b.get("_band_spf", {}).items() if v}
    if spa:
        det["spa"] = spa
    if b.get("spl"):
        det["spl"] = [{"icao": i, **e} for i, e in sorted(b["spl"].items(), key=lambda x: x[1]["t"])]
    if "t10" in b:
        det["t10"] = b["t10"]
    if b.get("_sev"):
        det["sevn"] = len(b["_sev"])      # distinct severe aircraft in the hour
    if b.get("_spf"):
        det["spfn"] = len(b["_spf"])      # distinct aircraft with a spoofing indicator
    return det


def _ram_detail(det: dict | None) -> dict | None:
    """The part of band_detail kept in RAM for completed hours (what
    get_state() uses); the rest is only stored in the DB."""
    if det is None:
        return None
    return {k: det[k] for k in ("ac", "deg", "sig", "sev", "sevn") if k in det}


def _empty_t10() -> dict:
    return {k: [0] * SLOTS for k in T10_KEYS}


def _slot_add(b: dict, now: float, key: str, icao: str) -> None:
    """Add an aircraft to the current 10-minute slot of a bucket.  Only the
    slot in progress keeps its aircraft set; finished slots are counts."""
    i = min(max(int((now - b["ts"]) // SLOT_SEC), 0), SLOTS - 1)
    s = b.get("_slot")
    if s is not None and i < s["i"]:          # clock stepped back: stay in the slot
        i = s["i"]
    if s is None or s["i"] != i:
        s = b["_slot"] = {"i": i, **{k: set() for k in T10_KEYS}}
    s[key].add(icao)
    b.setdefault("t10", _empty_t10())[key][i] = len(s[key])


_TRANSIENT_KEYS = ("_seen", "_deg", "_band_seen", "_band_deg", "_band_sev", "_band_spf", "_slot",
                   "_sev", "_spf")
_RAW_DETAIL_KEYS = ("band_sig", "band_sev", "band_spf", "spl", "t10")   # folded into band_detail


def _freeze_bucket(b: dict, detail: dict | None = None) -> None:
    """Turn a completed hour into a compact record (memory).

    Keeps the counts, stores the per-band detail as plain numbers and drops
    the per-aircraft sets and per-band signal dicts — they are only needed
    while the hour is being counted.  Completed buckets are kept in RAM for
    up to MAX_BUCKETS (6 months × 3 zones), so the sets would otherwise add
    up to a large amount of memory over a long uptime.
    """
    if detail is not None:
        b["band_detail"] = _ram_detail(detail)
    for k in _TRANSIENT_KEYS + _RAW_DETAIL_KEYS:
        b.pop(k, None)


def _load_detail(txt: str | None, ts: float, now_hour: float) -> dict | None:
    """band_detail JSON of a stored hour, only within the heatmap window."""
    if not txt or ts < now_hour - HEATMAP_MAX_BUCKETS * BUCKET_SEC:
        return None
    try:
        return _ram_detail(json.loads(txt))
    except (TypeError, ValueError):
        return None


def _prune_band_detail(buckets: list, cutoff_ts: float) -> None:
    """Drop band_detail from buckets older than cutoff_ts (only the heatmap
    window uses it).  Buckets are in time order; stop at the first newer one."""
    for b in buckets:
        if b["ts"] >= cutoff_ts:
            break
        b.pop("band_detail", None)


def _empty_bucket(ts: float) -> dict:
    """Return a zeroed hourly bucket starting at timestamp ts."""
    return {
        "ts":            int(ts),
        "total":         0,                        # unique aircraft seen this hour
        "degraded":      0,                        # aircraft with ≥1 event this hour
        "events":        0,                        # total event count this hour
        "nacp_events":      0,   # events from NACp signal
        "nic_events":       0,   # events from NIC (integrity) signal
        "freeze_events":    0,   # events from Freeze signal
        "gap_events":       0,   # events from Gap signal
        "adsb_loss_events": 0,   # events from ADS-B loss (MLAT covering GPS dropout)
        "fl_bands": {lbl: 0 for lbl in FL_BAND_LABELS},   # events per FL band
        "method":  METHOD_VERSION,                 # counting-method version
        # per-band signal counts {band: {signal: n}}
        "band_sig": {lbl: {s: 0 for s in SIG_ORDER} for lbl in FL_BAND_LABELS},
        "_seen":   set(),                          # transient: icaos seen this hour
        "_deg":    set(),                          # transient: icaos with event
        "_band_seen": {lbl: set() for lbl in FL_BAND_LABELS},   # transient: icaos per band
        "_band_deg":  {lbl: set() for lbl in FL_BAND_LABELS},   # transient: degraded icaos per band
        # since 2026-10-09 — see module docstring "Finer detail"
        "band_sev": {},     # {band: {nacp0|nic0|nopos: severe sweeps}}
        "band_spf": {},     # {band: {spoof kind|cmp|gmb_n: n}}
        "spl":      {},     # {icao: {...}} aircraft with a spoofing indicator ('all' zone)
        "t10":      _empty_t10(),                  # 10-minute slot counts
        "_band_sev": {},    # transient: severely degraded icaos per band
        "_band_spf": {},    # transient: icaos with a spoofing indicator per band
        "_sev":      set(), # transient: severely degraded icaos (all bands)
        "_spf":      set(), # transient: icaos with a spoofing indicator (all bands)
    }


def _bucket_hour(ts: float) -> float:
    """Truncate timestamp to the start of its UTC hour."""
    return math.floor(ts / BUCKET_SEC) * BUCKET_SEC


_EPISODE_INSERT_SQL = """INSERT OR IGNORE INTO gps_episodes
    (icao, callsign, registration, aircraft_type, t_start, t_end, duration_s, sweeps,
     signals, min_nacp, min_nic, min_alt, max_alt,
     start_lat, start_lon, start_alt, start_track, start_vrate, start_gs, start_dist_nm,
     end_lat, end_lon, end_alt, end_track, end_vrate, end_gs, end_dist_nm, end_pos_age,
     rec_lat, rec_lon, rec_alt, rec_dist_nm, end_reason, method,
     severe_sweeps, spoof, max_mlat_nm, mlat_cmp, gmb_min, gmb_max)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"""


# ── GpsQualityTracker ─────────────────────────────────────────────────────────

class GpsQualityTracker:
    """
    Thread-safe in-RAM GPS quality monitor.

    Instantiated once in run.py.  The background sweep thread calls
    update(ac) for every live aircraft then prune_stale() to drop
    aircraft not seen recently.  Flask reads get_state() for the API.
    """

    def __init__(
        self,
        nacp_threshold: int   = 6,
        nic_threshold:  int   = 6,
        freeze_polls:   int   = 3,
        gap_sec:        float = 45.0,
        min_gs_kt:      float = 50.0,
        min_alt_ft:     float = 500.0,
        db_path:        str   = "",
        airport_lat:    float | None = None,
        airport_lon:    float | None = None,
        episode_radius_nm: float = EPISODE_RADIUS_NM,
    ):
        self.nacp_threshold = nacp_threshold
        self.nic_threshold  = nic_threshold
        self.freeze_polls   = freeze_polls
        self.gap_sec        = gap_sec
        self.min_gs_kt      = min_gs_kt
        self.min_alt_ft     = min_alt_ft
        self._db_path       = db_path
        self._airport_lat   = airport_lat
        self._airport_lon   = airport_lon
        self.episode_radius_nm = episode_radius_nm

        # Per-aircraft tracking state
        # icao → {last_lat, last_lon, last_pos_ts, freeze_count, last_seen}
        self._ac_state: dict[str, dict] = {}

        # Live degraded aircraft (rebuilt every sweep)
        self._live_events: list[dict] = []

        # Rolling hourly buckets for 'all' zone — oldest first
        self._buckets: deque = deque(maxlen=MAX_BUCKETS)

        # Rolling hourly buckets for each distance zone
        self._zone_buckets: dict[str, deque] = {
            zone: deque(maxlen=MAX_BUCKETS) for zone in ZONE_LIMITS_NM
        }

        # Degradation episode log: open episodes per aircraft, and closed
        # episodes waiting to be written with the next checkpoint
        self._episodes:   dict[str, dict] = {}
        self._episode_buf: list[tuple]    = []

        self._lock = threading.RLock()
        self._last_checkpoint = 0.0
        # get_detail(): parsed completed hours per (zone, hours, current hour)
        self._detail_cache: dict = {}

        # Restore history from DB (completed hours only), plus the hour that
        # was in progress when the process last stopped (checkpoint).
        if db_path:
            current_ckpt = self._flush_old_checkpoints()
            self._load_from_db()
            self._load_zones_from_db()
            self._restore_current_hour(current_ckpt)
            self._restore_episodes()

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _current_bucket(self) -> dict:
        """Return the bucket for the current hour, creating it if needed.

        When the hour rolls over, the previous bucket is complete: flush it
        to the DB before opening the new one.  Flush is called without the
        lock so it doesn't block the sweep thread while waiting for disk I/O.
        """
        now_hour = _bucket_hour(time.time())
        if not self._buckets or self._buckets[-1]["ts"] < now_hour:
            # Capture and persist the completed bucket before replacing it
            if self._buckets and self._db_path:
                completed = self._buckets[-1]
                flush_copy = {
                    "ts":               completed["ts"],
                    "events":           completed["events"],
                    "total":            completed["total"],
                    "degraded":         completed["degraded"],
                    "fl_bands":         dict(completed["fl_bands"]),
                    "nacp_events":      completed.get("nacp_events",      0),
                    "nic_events":       completed.get("nic_events",       0),
                    "freeze_events":    completed.get("freeze_events",    0),
                    "gap_events":       completed.get("gap_events",       0),
                    "adsb_loss_events": completed.get("adsb_loss_events", 0),
                    "method":           completed.get("method", METHOD_VERSION),
                    "band_detail":      _band_detail(completed),
                }
                self._flush_to_db(flush_copy)
            if self._buckets:
                _freeze_bucket(self._buckets[-1], _band_detail(self._buckets[-1]))
                _prune_band_detail(self._buckets, now_hour - HEATMAP_MAX_BUCKETS * BUCKET_SEC)
            self._buckets.append(_empty_bucket(now_hour))
        return self._buckets[-1]

    def _current_zone_bucket(self, zone: str) -> dict:
        """Return the current hourly bucket for a distance zone, flushing on rollover."""
        now_hour = _bucket_hour(time.time())
        zb = self._zone_buckets[zone]
        if not zb or zb[-1]["ts"] < now_hour:
            if zb and self._db_path:
                completed = zb[-1]
                flush_copy = {
                    "ts":               completed["ts"],
                    "events":           completed["events"],
                    "total":            completed["total"],
                    "degraded":         completed["degraded"],
                    "fl_bands":         dict(completed["fl_bands"]),
                    "nacp_events":      completed.get("nacp_events",      0),
                    "nic_events":       completed.get("nic_events",       0),
                    "freeze_events":    completed.get("freeze_events",    0),
                    "gap_events":       completed.get("gap_events",       0),
                    "adsb_loss_events": completed.get("adsb_loss_events", 0),
                    "method":           completed.get("method", METHOD_VERSION),
                    "band_detail":      _band_detail(completed),
                }
                self._flush_zone_to_db(flush_copy, zone)
            if zb:
                _freeze_bucket(zb[-1], _band_detail(zb[-1]))
                _prune_band_detail(zb, now_hour - HEATMAP_MAX_BUCKETS * BUCKET_SEC)
            zb.append(_empty_bucket(now_hour))
        return zb[-1]

    @staticmethod
    def _write_event_to_bucket(bucket: dict, icao: str,
                               altitude: float | None, flags: list[str],
                               sev: list[str] | None = None) -> None:
        """Increment event counters in an arbitrary bucket dict.
        sev: severity tags of this sweep (nacp0 / nic0 / nopos), empty = mild."""
        now = time.time()
        _slot_add(bucket, now, "deg", icao)
        if altitude is not None and MID_LO_FT <= altitude < MID_HI_FT:
            _slot_add(bucket, now, "mdeg", icao)
        if sev:
            _slot_add(bucket, now, "sev", icao)
            bucket.setdefault("_sev", set()).add(icao)
        bucket["events"] += 1
        bucket["_deg"].add(icao)
        bucket["degraded"] = len(bucket["_deg"])
        if "nacp"      in flags: bucket["nacp_events"]      += 1
        if "nic"       in flags: bucket["nic_events"]       += 1
        if "freeze"    in flags: bucket["freeze_events"]    += 1
        if "gap"       in flags: bucket["gap_events"]       += 1
        if "adsb_loss" in flags: bucket["adsb_loss_events"] += 1
        fl = _fl_band(altitude)
        if fl:
            bucket["fl_bands"][fl] = bucket["fl_bands"].get(fl, 0) + 1
            bucket.setdefault("_band_deg", {}).setdefault(fl, set()).add(icao)
            sig = bucket.setdefault("band_sig", {}).setdefault(fl, {s: 0 for s in SIG_ORDER})
            for f in flags:
                if f in sig:
                    sig[f] += 1
            if sev:
                bucket.setdefault("_band_sev", {}).setdefault(fl, set()).add(icao)
                sv = bucket.setdefault("band_sev", {}).setdefault(fl, {})
                for t in sev:
                    sv[t] = sv.get(t, 0) + 1

    def _record_event(self, icao: str, altitude: float | None,
                      flags: list[str], zones: list[str],
                      sev: list[str] | None = None) -> None:
        """Increment event counters in the 'all' bucket and any qualifying zone buckets."""
        self._write_event_to_bucket(self._current_bucket(), icao, altitude, flags, sev)
        for zone in zones:
            self._write_event_to_bucket(
                self._current_zone_bucket(zone), icao, altitude, flags, sev)

    @staticmethod
    def _write_spoof_to_bucket(bucket: dict, icao: str, altitude: float | None,
                               kinds: list[str], counts: dict, entry: dict | None,
                               ok: bool = False) -> None:
        """Spoofing-indicator counters in one bucket.  counts: per-sweep
        denominators (cmp, gmb_n); entry: details for the 'all' zone list;
        ok: the aircraft reports normal GPS quality in this sweep."""
        fl = _fl_band(altitude)
        if fl and (kinds or counts):
            sp = bucket.setdefault("band_spf", {}).setdefault(fl, {})
            for k in list(kinds) + [k for k, n in counts.items() if n] \
                    + (["ok_" + k for k in kinds] if ok else []):
                sp[k] = sp.get(k, 0) + 1
        if not kinds:
            return
        _slot_add(bucket, time.time(), "spf", icao)
        bucket.setdefault("_spf", set()).add(icao)
        if fl:
            bucket.setdefault("_band_spf", {}).setdefault(fl, set()).add(icao)
        if entry is None:
            return
        spl = bucket.setdefault("spl", {})
        e = spl.get(icao)
        if e is None:
            if len(spl) >= SPOOF_LIST_MAX:
                return
            e = spl[icao] = {"t": entry["t"], "alt": entry.get("alt"), "dist": entry.get("dist"),
                             "cs": entry.get("cs"), "nacp": entry.get("nacp"), "k": []}
        for k in kinds:
            if k not in e["k"]:
                e["k"].append(k)
            if ok and k not in e.setdefault("q", []):
                e["q"].append(k)
        for k in ("mlat_nm", "jump_nm", "gmb_jump", "gmb"):   # keep the largest magnitude
            v = entry.get(k)
            if v is not None and (e.get(k) is None or abs(v) > abs(e[k])):
                e[k] = v

    def _record_spoof(self, icao: str, ac: dict, now: float, kinds: list[str],
                      vals: dict, counts: dict, zones: list[str],
                      dist_nm: float | None, flags: list[str] | None = None) -> None:
        """Count the spoofing indicators of one sweep (lock held).  flags: the
        degradation signals of the same sweep (for the normal-quality case)."""
        if not kinds and not any(counts.values()):
            return
        alt = ac.get("altitude")
        b = self._current_bucket()
        entry = None
        ok = False
        if kinds:
            nacp, nacp_ts = ac.get("nac_p"), ac.get("nac_p_ts")
            fresh = nacp is not None and nacp_ts is not None and now - nacp_ts <= QUALITY_FRESH_SEC
            # Normal reported quality: fresh NACp above the threshold, no degradation signal
            ok = fresh and nacp > self.nacp_threshold and not flags
            entry = {"t": int(now - b["ts"]),
                     "alt": None if alt is None else int(alt),
                     "dist": None if dist_nm is None else round(dist_nm, 1),
                     "cs": ac.get("callsign"), "nacp": nacp if fresh else None, **vals}
        self._write_spoof_to_bucket(b, icao, alt, kinds, counts, entry, ok)
        for zone in zones:
            self._write_spoof_to_bucket(self._current_zone_bucket(zone), icao, alt,
                                        kinds, counts, None, ok)

    def _record_seen(self, icao: str, zones: list[str],
                     altitude: float | None = None) -> None:
        """Mark an aircraft as seen in the 'all' bucket and any qualifying zone
        buckets, and in the FL band of its current altitude."""
        band = _seen_band(altitude)
        mid  = altitude is not None and MID_LO_FT <= altitude < MID_HI_FT
        now  = time.time()
        for zb in [self._current_bucket()] + [self._current_zone_bucket(z) for z in zones]:
            zb["_seen"].add(icao)
            zb["total"] = len(zb["_seen"])
            if band:
                zb.setdefault("_band_seen", {}).setdefault(band, set()).add(icao)
            _slot_add(zb, now, "ac", icao)
            if mid:
                _slot_add(zb, now, "mac", icao)

    # ── Database persistence ──────────────────────────────────────────────────

    def _flush_to_db(self, bucket: dict) -> None:
        """
        Write one completed hourly bucket to gps_quality_hours.
        Uses INSERT OR REPLACE so repeated flushes of the same ts are safe.
        Called without the lock held (bucket is a completed, immutable row).
        """
        try:
            fl_json = json.dumps(bucket["fl_bands"])
            detail  = bucket.get("band_detail") or _band_detail(bucket)
            conn = get_db()
            conn.execute(
                """INSERT OR REPLACE INTO gps_quality_hours
                   (ts, events, total, degraded, fl_bands,
                    nacp_events, freeze_events, gap_events, adsb_loss_events, method, nic_events,
                    band_detail)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (bucket["ts"], bucket["events"], bucket["total"],
                 bucket["degraded"], fl_json,
                 bucket.get("nacp_events",      0),
                 bucket.get("freeze_events",    0),
                 bucket.get("gap_events",       0),
                 bucket.get("adsb_loss_events", 0),
                 bucket.get("method", METHOD_VERSION),
                 bucket.get("nic_events", 0),
                 json.dumps(detail, separators=(",", ":"))),
            )
            conn.commit()
            log.debug("GPS quality: persisted bucket ts=%d events=%d",
                      bucket["ts"], bucket["events"])
        except Exception as exc:
            log.warning("GPS quality: failed to persist bucket ts=%s: %s",
                        bucket.get("ts"), exc)

    def _flush_zone_to_db(self, bucket: dict, zone: str) -> None:
        """Write one completed zone hourly bucket to gps_quality_zone_hours."""
        try:
            fl_json = json.dumps(bucket["fl_bands"])
            detail  = bucket.get("band_detail") or _band_detail(bucket)
            conn = get_db()
            conn.execute(
                """INSERT OR REPLACE INTO gps_quality_zone_hours
                   (ts, zone, events, total, degraded, fl_bands,
                    nacp_events, freeze_events, gap_events, adsb_loss_events, method, nic_events,
                    band_detail)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (bucket["ts"], zone, bucket["events"], bucket["total"],
                 bucket["degraded"], fl_json,
                 bucket.get("nacp_events",      0),
                 bucket.get("freeze_events",    0),
                 bucket.get("gap_events",       0),
                 bucket.get("adsb_loss_events", 0),
                 bucket.get("method", METHOD_VERSION),
                 bucket.get("nic_events", 0),
                 json.dumps(detail, separators=(",", ":"))),
            )
            conn.commit()
            log.debug("GPS quality: persisted zone=%s bucket ts=%d events=%d",
                      zone, bucket["ts"], bucket["events"])
        except Exception as exc:
            log.warning("GPS quality: failed to persist zone=%s bucket ts=%s: %s",
                        zone, bucket.get("ts"), exc)

    def _load_from_db(self) -> None:
        """
        Reload historical hourly buckets from the DB at startup.
        Loads completed hours only (ts < current hour start).
        Populates _buckets so charts and heatmap are immediately available.
        """
        try:
            now_hour = _bucket_hour(time.time())
            cutoff   = now_hour - (MAX_BUCKETS - 1) * BUCKET_SEC
            conn     = get_db()
            rows     = conn.execute(
                """SELECT ts, events, total, degraded, fl_bands,
                          nacp_events, freeze_events, gap_events, adsb_loss_events, method, nic_events,
                          band_detail
                   FROM gps_quality_hours
                   WHERE ts >= ? AND ts < ?
                   ORDER BY ts ASC""",
                (int(cutoff), int(now_hour)),
            ).fetchall()
            for row in rows:
                fl   = json.loads(row["fl_bands"] or "{}")
                b    = _empty_bucket(row["ts"])
                b["events"]           = row["events"]
                b["total"]            = row["total"]
                b["degraded"]         = row["degraded"]
                b["fl_bands"]         = {lbl: fl.get(lbl, 0) for lbl in FL_BAND_LABELS}
                b["nacp_events"]      = row["nacp_events"]        or 0
                b["freeze_events"]    = row["freeze_events"]      or 0
                b["gap_events"]       = row["gap_events"]         or 0
                b["adsb_loss_events"] = row["adsb_loss_events"]   or 0
                b["method"]           = row["method"] or 1
                b["nic_events"]       = row["nic_events"] or 0
                _freeze_bucket(b, _load_detail(row["band_detail"], row["ts"], now_hour))
                self._buckets.append(b)
            log.info("GPS quality: loaded %d historical hour buckets from DB",
                     len(rows))
        except Exception as exc:
            log.warning("GPS quality: failed to load history from DB: %s", exc)

    def _load_zones_from_db(self) -> None:
        """Reload historical zone buckets from gps_quality_zone_hours at startup."""
        try:
            now_hour = _bucket_hour(time.time())
            cutoff   = now_hour - (MAX_BUCKETS - 1) * BUCKET_SEC
            conn     = get_db()
            for zone in ZONE_LIMITS_NM:
                rows = conn.execute(
                    """SELECT ts, events, total, degraded, fl_bands,
                              nacp_events, freeze_events, gap_events, adsb_loss_events, method, nic_events,
                              band_detail
                       FROM gps_quality_zone_hours
                       WHERE zone = ? AND ts >= ? AND ts < ?
                       ORDER BY ts ASC""",
                    (zone, int(cutoff), int(now_hour)),
                ).fetchall()
                for row in rows:
                    fl = json.loads(row["fl_bands"] or "{}")
                    b  = _empty_bucket(row["ts"])
                    b["events"]           = row["events"]
                    b["total"]            = row["total"]
                    b["degraded"]         = row["degraded"]
                    b["fl_bands"]         = {lbl: fl.get(lbl, 0) for lbl in FL_BAND_LABELS}
                    b["nacp_events"]      = row["nacp_events"]      or 0
                    b["freeze_events"]    = row["freeze_events"]    or 0
                    b["gap_events"]       = row["gap_events"]       or 0
                    b["adsb_loss_events"] = row["adsb_loss_events"] or 0
                    b["method"]           = row["method"] or 1
                    b["nic_events"]       = row["nic_events"] or 0
                    _freeze_bucket(b, _load_detail(row["band_detail"], row["ts"], now_hour))
                    self._zone_buckets[zone].append(b)
                log.info("GPS quality: loaded %d zone=%s buckets from DB", len(rows), zone)
        except Exception as exc:
            log.warning("GPS quality: failed to load zone history from DB: %s", exc)

    def reload_from_db(self) -> None:
        """
        Reload all historical buckets from DB, replacing the in-RAM cache.
        Called after a maintenance purge so the live charts reflect the new
        DB state immediately without requiring a server restart.
        """
        now_hour = _bucket_hour(time.time())
        with self._lock:
            # Keep the in-progress hour (not in the DB yet) across the reload
            keep_all  = [b for b in self._buckets if b["ts"] >= now_hour]
            keep_zone = {z: [b for b in zb if b["ts"] >= now_hour]
                         for z, zb in self._zone_buckets.items()}
            self._buckets.clear()
            for zb in self._zone_buckets.values():
                zb.clear()
        self._load_from_db()
        self._load_zones_from_db()
        with self._lock:
            self._buckets.extend(keep_all)
            for z, bl in keep_zone.items():
                self._zone_buckets[z].extend(bl)
        log.info("GPS quality: in-RAM cache reloaded from DB after maintenance purge")

    # ── Current-hour checkpoint (restart safety) ──────────────────────────────

    @staticmethod
    def _bucket_to_json(b: dict) -> str:
        d = {k: v for k, v in b.items() if not k.startswith("_")}
        d["seen"] = sorted(b.get("_seen", ()))
        d["deg"]  = sorted(b.get("_deg", ()))
        d["band_seen"] = {lbl: sorted(v) for lbl, v in b.get("_band_seen", {}).items() if v}
        d["band_deg"]  = {lbl: sorted(v) for lbl, v in b.get("_band_deg", {}).items() if v}
        d["band_sev_ac"] = {lbl: sorted(v) for lbl, v in b.get("_band_sev", {}).items() if v}
        d["band_spf_ac"] = {lbl: sorted(v) for lbl, v in b.get("_band_spf", {}).items() if v}
        d["sev_all"] = sorted(b.get("_sev", ()))
        d["spf_all"] = sorted(b.get("_spf", ()))
        s = b.get("_slot")
        if s is not None:          # aircraft of the 10-min slot in progress
            d["slot"] = {"i": s["i"], **{k: sorted(s[k]) for k in T10_KEYS if s[k]}}
        return json.dumps(d, separators=(",", ":"))

    @staticmethod
    def _bucket_from_json(txt: str) -> dict:
        d = json.loads(txt)
        b = _empty_bucket(d["ts"])
        for k in ("total", "degraded", "events", "nacp_events", "nic_events", "freeze_events",
                  "gap_events", "adsb_loss_events", "method"):
            if k in d:
                b[k] = d[k]
        fl = d.get("fl_bands", {})
        b["fl_bands"] = {lbl: fl.get(lbl, 0) for lbl in FL_BAND_LABELS}
        b["_seen"] = set(d.get("seen", ()))
        b["_deg"]  = set(d.get("deg", ()))
        for lbl, v in d.get("band_seen", {}).items():
            b["_band_seen"].setdefault(lbl, set()).update(v)
        for lbl, v in d.get("band_deg", {}).items():
            b["_band_deg"].setdefault(lbl, set()).update(v)
        for lbl, sig in d.get("band_sig", {}).items():
            tgt = b["band_sig"].setdefault(lbl, {s: 0 for s in SIG_ORDER})
            for k, n in sig.items():
                tgt[k] = n
        # since 2026-10-09 (absent in older checkpoints)
        for key in ("band_sev", "band_spf", "spl"):
            if isinstance(d.get(key), dict):
                b[key] = d[key]
        t10 = d.get("t10")
        if isinstance(t10, dict):
            for k in T10_KEYS:
                v = t10.get(k)
                if isinstance(v, list) and len(v) == SLOTS:
                    b["t10"][k] = v
        for src, dst in (("band_sev_ac", "_band_sev"), ("band_spf_ac", "_band_spf")):
            for lbl, v in (d.get(src) or {}).items():
                b[dst].setdefault(lbl, set()).update(v)
        b["_sev"] = set(d.get("sev_all", ()))
        b["_spf"] = set(d.get("spf_all", ()))
        s = d.get("slot")
        if isinstance(s, dict) and "i" in s:
            b["_slot"] = {"i": s["i"], **{k: set(s.get(k, ())) for k in T10_KEYS}}
        return b

    def checkpoint(self, force: bool = False) -> None:
        """Persist the in-progress hour of every zone to gps_quality_live.

        Called from rebuild_live() every sweep; writes at most every
        CHECKPOINT_SEC.  A restart then loses at most CHECKPOINT_SEC of data
        instead of everything counted so far in the current hour.
        """
        if not self._db_path:
            return
        now = time.time()
        if not force and now - self._last_checkpoint < CHECKPOINT_SEC:
            return
        self._last_checkpoint = now
        now_hour = _bucket_hour(now)
        with self._lock:
            rows = []
            if self._buckets and self._buckets[-1]["ts"] >= now_hour:
                rows.append(("all", self._buckets[-1]["ts"], self._bucket_to_json(self._buckets[-1])))
            for zone, zb in self._zone_buckets.items():
                if zb and zb[-1]["ts"] >= now_hour:
                    rows.append((zone, zb[-1]["ts"], self._bucket_to_json(zb[-1])))
            # Open episodes, so that a restart continues them instead of
            # losing their first part (always written, also when empty)
            rows.append((EPISODE_LIVE_KEY, int(now), json.dumps({
                "saved":    now,
                "episodes": {icao: {**ep, "sig": sorted(ep["sig"]),
                                    "spf": sorted(ep.get("spf", ()))}
                             for icao, ep in self._episodes.items()},
            })))
            episodes = self._episode_buf
            self._episode_buf = []
        if not rows and not episodes:
            return
        try:
            conn = get_db()
            if rows:
                conn.executemany(
                    "INSERT OR REPLACE INTO gps_quality_live (zone, ts, data) VALUES (?, ?, ?)", rows)
            if episodes:
                conn.executemany(_EPISODE_INSERT_SQL, episodes)
            conn.commit()
        except Exception as exc:
            log.warning("GPS quality: checkpoint failed: %s", exc)
            if episodes:
                with self._lock:   # keep the closed episodes for the next attempt
                    self._episode_buf[:0] = episodes
                    # bound memory if the DB stays unwritable for a long time
                    if len(self._episode_buf) > EPISODE_BUF_MAX:
                        dropped = len(self._episode_buf) - EPISODE_BUF_MAX
                        del self._episode_buf[:dropped]
                        log.warning("GPS quality: %d unsaved episodes dropped", dropped)

    def _flush_old_checkpoints(self) -> dict:
        """At startup: write checkpoints of hours that already ended to the
        hourly tables (only if that hour has no row yet), and return the
        checkpoints of the current hour as {zone: bucket} for restoring."""
        current: dict[str, dict] = {}
        try:
            now_hour = _bucket_hour(time.time())
            conn = get_db()
            for row in conn.execute("SELECT zone, ts, data FROM gps_quality_live").fetchall():
                if row["zone"].startswith("_"):          # open-episode row, see _restore_episodes
                    continue
                b = self._bucket_from_json(row["data"])
                if row["ts"] >= now_hour:
                    current[row["zone"]] = b
                    continue
                if row["zone"] == "all":
                    exists = conn.execute("SELECT 1 FROM gps_quality_hours WHERE ts = ?",
                                          (row["ts"],)).fetchone()
                    if not exists:
                        self._flush_to_db(b)
                        log.info("GPS quality: saved interrupted hour %d from checkpoint", row["ts"])
                else:
                    exists = conn.execute("SELECT 1 FROM gps_quality_zone_hours WHERE ts = ? AND zone = ?",
                                          (row["ts"], row["zone"])).fetchone()
                    if not exists:
                        self._flush_zone_to_db(b, row["zone"])
        except Exception as exc:
            log.warning("GPS quality: reading checkpoints failed: %s", exc)
        return current

    def _restore_episodes(self) -> None:
        """At startup: take over the episodes that were open at the last
        checkpoint.  After a short stop (≤ EPISODE_RESTORE_MAX_SEC) they
        continue — the next sweeps extend, recover or close them as usual;
        after a longer stop they are saved as ended at their last degraded
        sweep with end_reason "shutdown"."""
        try:
            row = get_db().execute("SELECT data FROM gps_quality_live WHERE zone = ?",
                                   (EPISODE_LIVE_KEY,)).fetchone()
            if not row:
                return
            d = json.loads(row["data"])
        except Exception as exc:
            log.warning("GPS quality: reading open episodes failed: %s", exc)
            return
        now   = time.time()
        fresh = now - float(d.get("saved", 0)) <= EPISODE_RESTORE_MAX_SEC
        n = 0
        with self._lock:
            for icao, ep in (d.get("episodes") or {}).items():
                if not ep.get("sweeps") or "start" not in ep or "last" not in ep:
                    continue
                ep["sig"] = set(ep.get("sig") or ())
                ep["spf"] = set(ep.get("spf") or ())
                self._episodes[icao] = ep
                n += 1
                if fresh:
                    ep["restored"] = now        # grace period before "lost"
                else:
                    self._close_episode(icao, "shutdown")
        if n:
            log.info("GPS quality: %s %d open episode(s) from checkpoint",
                     "continuing" if fresh else "saved (stop too long)", n)

    def _restore_current_hour(self, current: dict) -> None:
        """Continue counting the hour that was in progress at shutdown."""
        if not current:
            return
        with self._lock:
            if "all" in current and (not self._buckets or self._buckets[-1]["ts"] < current["all"]["ts"]):
                self._buckets.append(current["all"])
            for zone, zb in self._zone_buckets.items():
                b = current.get(zone)
                if b is not None and (not zb or zb[-1]["ts"] < b["ts"]):
                    zb.append(b)
        log.info("GPS quality: resumed current hour from checkpoint (%s)", ", ".join(sorted(current)))

    # ── Signal helpers ────────────────────────────────────────────────────────

    def _signals(self, ac: dict, prev: dict, now: float) -> tuple[list[str], dict]:
        """Evaluate the GPS degradation signals for one aircraft (METHOD_VERSION 4).

        Returns (flags, per-aircraft state to keep for the next sweep).
        All signals rely on data received by our own receiver:

          nacp      — NACp ≤ threshold, from a status message (TC 29, or TC 31
                      with ADS-B version ≥ 1) received within QUALITY_FRESH_SEC
          nic       — NIC ≤ threshold (containment radius Rc too large), from an
                      airborne-position type code received within QUALITY_FRESH_SEC
          freeze    — own ADS-B positions keep arriving (latest within
                      FREEZE_POS_SEC) but the coordinates have not changed for
                      ≥ freeze_polls consecutive sweeps while groundspeed ≥ min
          adsb_loss — ADS-B active (DF17 within ES_ACTIVE_SEC), no own position
                      for ≥ gap_sec in this visit, but the position keeps
                      updating from another source (MLAT)
          gap       — ADS-B active, no position update from ANY source for
                      ≥ gap_sec in this visit
        adsb_loss and gap are mutually exclusive; freeze excludes both.
        """
        flags: list[str] = []
        gs = ac.get("groundspeed")

        # Self-reported quality (fresh values only)
        nacp, nacp_ts = ac.get("nac_p"), ac.get("nac_p_ts")
        if nacp is not None and nacp_ts is not None and now - nacp_ts <= QUALITY_FRESH_SEC \
                and nacp <= self.nacp_threshold:
            flags.append("nacp")
        nic, nic_ts = ac.get("nic"), ac.get("nic_ts")
        if nic is not None and nic_ts is not None and now - nic_ts <= QUALITY_FRESH_SEC \
                and nic <= self.nic_threshold:
            flags.append("nic")

        # Freeze: own ADS-B positions arriving with identical coordinates
        a_lat, a_lon, a_ts = ac.get("adsb_lat"), ac.get("adsb_lon"), ac.get("last_adsb_pos_ts")
        own_pos_fresh = a_ts is not None and now - a_ts <= FREEZE_POS_SEC
        freeze_count = 0
        if own_pos_fresh and gs is not None and gs >= self.min_gs_kt:
            if (a_lat, a_lon) == (prev.get("adsb_lat"), prev.get("adsb_lon")):
                freeze_count = prev.get("freeze_count", 0) + 1
            if freeze_count >= self.freeze_polls:
                flags.append("freeze")

        # ADS-B loss / Gap (per visit, aircraft must be transmitting ES now)
        last_es = ac.get("last_es_ts")
        if last_es is not None and now - last_es <= ES_ACTIVE_SEC and not own_pos_fresh:
            first_seen = ac.get("first_seen")
            own_ref = a_ts if a_ts is not None else first_seen
            if own_ref is not None and now - own_ref >= self.gap_sec:
                any_ref = ac.get("last_pos_update_ts") or first_seen
                if any_ref is not None and now - any_ref >= self.gap_sec:
                    flags.append("gap")          # no position from any source
                else:
                    flags.append("adsb_loss")    # MLAT still updating the position

        state = {
            "adsb_lat":     a_lat,
            "adsb_lon":     a_lon,
            "freeze_count": freeze_count,
            "last_seen":    ac.get("last_seen", now),
            "flags":        flags,
            "flags_ts":     now,
        }
        return flags, state

    @staticmethod
    def _severity(ac: dict, flags: list[str], now: float) -> list[str]:
        """Severity tags of a degraded sweep: the position is unusable when
        NACp is 0 (nacp0), NIC is 0 (nic0) or there is no own ADS-B position
        (nopos = ADS-B loss / Gap).  Empty list = mild (NACp / NIC 1–6, Freeze)."""
        tags: list[str] = []
        if "nacp" in flags and ac.get("nac_p") == 0:
            tags.append("nacp0")
        if "nic" in flags and ac.get("nic") == 0:
            tags.append("nic0")
        if "adsb_loss" in flags or "gap" in flags:
            tags.append("nopos")
        return tags

    @staticmethod
    def _spoof_checks(ac: dict, prev: dict, now: float) -> tuple[list[str], dict, dict, dict]:
        """Spoofing indicators for one aircraft (see module docstring).

        Returns (kinds, values, per-sweep counts {cmp, gmb_n}, state to keep).
        """
        kinds: list[str] = []
        vals:  dict = {}
        st:    dict = {}
        # Groundspeed unknown: assume a fast jet so that it cannot cause a flag
        gs = ac.get("groundspeed") or GS_UNKNOWN_KT
        a_lat, a_lon, a_ts = ac.get("adsb_lat"), ac.get("adsb_lon"), ac.get("last_adsb_pos_ts")
        own_fresh = (a_lat is not None and a_lon is not None and a_ts is not None
                     and now - a_ts <= SPOOF_POS_SEC)

        # 1. Own ADS-B position vs MLAT position — counted only when the
        #    mismatch repeats on the next comparison with new positions on both
        #    sides (a single MLAT or decoding outlier is ignored)
        cmp = 0
        m_lat, m_lon, m_ts = ac.get("mlat_lat"), ac.get("mlat_lon"), ac.get("mlat_ts")
        md = prev.get("md")                      # last mismatch [mlat_ts, adsb_ts, t]
        if own_fresh and m_lat is not None and m_lon is not None and m_ts is not None \
                and now - m_ts <= SPOOF_POS_SEC:
            cmp = 1
            d = _haversine_nm(a_lat, a_lon, m_lat, m_lon)
            if d > MLAT_DIS_NM + gs * (abs(a_ts - m_ts) + MLAT_SLACK_SEC) / 3600.0:
                if md is not None and m_ts != md[0] and a_ts != md[1]:
                    kinds.append("mlat_dis")
                    vals["mlat_nm"] = round(d, 1)
                if md is None or (m_ts != md[0] and a_ts != md[1]):
                    md = [m_ts, a_ts, now]
            else:
                md = None                        # agreeing comparison clears it
        if md is not None and now - md[2] <= MLAT_CONFIRM_SEC:
            st["md"] = md

        # 2. GNSS − baro altitude difference (TC 19)
        gmb_n = 0
        g, g_ts = ac.get("geo_minus_baro"), ac.get("gmb_ts")
        if g is not None and g_ts is not None and now - g_ts <= GMB_FRESH_SEC:
            gmb_n = 1
            vals["gmb"] = g
            if abs(g) >= GMB_SAT_FT:
                kinds.append("gmb_sat")
            pg, pg_ts = prev.get("gmb"), prev.get("gmb_ts")
            if pg is not None and pg_ts is not None and g_ts != pg_ts \
                    and g_ts - pg_ts <= GMB_FRESH_SEC and abs(g - pg) >= GMB_JUMP_FT:
                kinds.append("gmb_jump")
                vals["gmb_jump"] = g - pg
            st["gmb"], st["gmb_ts"] = g, g_ts

        # 3. Own ADS-B position jump, confirmed by the next own position
        jp, jpend = prev.get("jp"), prev.get("jpend")    # [lat, lon, ts] / [lat, lon, ts, nm]
        if own_fresh and not (jp and jp[2] == a_ts) and not (jpend and jpend[2] == a_ts):
            cur = [a_lat, a_lon, a_ts]

            def reach(p, q) -> bool:                     # q reachable from p
                return (_haversine_nm(p[0], p[1], q[0], q[1])
                        <= JUMP_MIN_NM + 1.5 * gs * abs(q[2] - p[2]) / 3600.0)

            if jp is None or a_ts - jp[2] > JUMP_MAX_DT:
                jp, jpend = cur, None
            elif jpend is None:
                if reach(jp, cur):
                    jp = cur
                else:
                    jpend = cur + [round(_haversine_nm(jp[0], jp[1], a_lat, a_lon), 1)]
            elif reach(jp, cur):                         # back on the old track: outlier
                jp, jpend = cur, None
            elif reach(jpend, cur):                      # continues from the jumped position
                kinds.append("pos_jump")
                vals["jump_nm"] = jpend[3]
                jp, jpend = cur, None
            else:                                        # neither — wait for the next one
                jpend = cur + [round(_haversine_nm(jp[0], jp[1], a_lat, a_lon), 1)]
        if jp is not None and now - jp[2] <= JUMP_MAX_DT:
            st["jp"] = jp
            if jpend is not None:
                st["jpend"] = jpend
        return kinds, vals, {"cmp": cmp, "gmb_n": gmb_n}, st

    def update(self, ac: dict) -> None:
        """
        Process one aircraft from the live_state snapshot.
        Called by the sweep thread for every aircraft seen in the last 60 s.
        Only aircraft heard by our own receiver within HEARD_SEC are counted
        (METHOD_VERSION 4) — aircraft kept alive solely by the Radarcape JSON
        list (MLAT network beyond our antenna's range) are ignored.
        """
        icao = ac.get("icao", "")
        if not icao:
            return
        now = time.time()
        last_rx = ac.get("last_rx_ts")
        if last_rx is None or now - last_rx > HEARD_SEC:
            return
        alt = ac.get("altitude")

        with self._lock:
            prev = self._ac_state.get(icao, {})

            # ── Zone membership ─────────────────────────────────────────
            # Uses the current position only while it is being updated
            # (any source); a position that stopped updating more than
            # LAST_POS_MAX_AGE_SEC ago no longer places the aircraft in a zone.
            active_zones: list[str] = []
            dist_nm: float | None = None
            lat, lon = ac.get("lat"), ac.get("lon")
            pos_ts = ac.get("last_pos_update_ts") or ac.get("first_seen") or 0
            if (self._airport_lat is not None and lat is not None and lon is not None
                    and now - pos_ts <= LAST_POS_MAX_AGE_SEC):
                dist_nm = _haversine_nm(self._airport_lat, self._airport_lon, lat, lon)
                for zone, limit in ZONE_LIMITS_NM.items():
                    if dist_nm <= limit:
                        active_zones.append(zone)

            self._record_seen(icao, active_zones, alt)

            # Skip degradation signal checks below the minimum altitude gate
            # (landing aircraft that the receiver loses at a few hundred ft).
            if alt is not None and alt < self.min_alt_ft:
                self._ac_state.pop(icao, None)
                if icao in self._episodes:
                    self._episodes[icao]["rec"] = self._snapshot(ac, now, dist_nm, pos_ts)
                    self._close_episode(icao, "below_min_alt")
                return

            flags, state = self._signals(ac, prev, now)
            kinds, vals, counts, sp_state = self._spoof_checks(ac, prev, now)
            state.update(sp_state)
            self._ac_state[icao] = state
            sev = self._severity(ac, flags, now) if flags else []
            if flags:
                self._record_event(icao, alt, flags, active_zones, sev)
            self._record_spoof(icao, ac, now, kinds, vals, counts, active_zones, dist_nm, flags)
            self._episode_step(icao, ac, flags, now, dist_nm, pos_ts, sev)
            ep = self._episodes.get(icao)
            if ep is not None:          # spoofing indicators while the episode is open
                ep["cmp"] = ep.get("cmp", 0) + counts["cmp"]
                ep.setdefault("spf", set()).update(kinds)
                if "mlat_nm" in vals:
                    ep["mlat_nm"] = max(ep.get("mlat_nm") or 0.0, vals["mlat_nm"])
                g = vals.get("gmb")
                if g is not None:
                    ep["gmb_min"] = g if ep.get("gmb_min") is None else min(ep["gmb_min"], g)
                    ep["gmb_max"] = g if ep.get("gmb_max") is None else max(ep["gmb_max"], g)

    def prune_stale(self, max_age_sec: float = 90.0) -> None:
        """Remove aircraft not updated for max_age_sec seconds."""
        now    = time.time()
        cutoff = now - max_age_sec
        with self._lock:
            stale = [icao for icao, s in self._ac_state.items()
                     if s.get("last_seen", 0) < cutoff]
            for icao in stale:
                del self._ac_state[icao]
            # Open episodes of aircraft no longer heard: contact lost while degraded
            for icao in [i for i, ep in self._episodes.items()
                         if max(ep["t_last"], ep.get("restored", 0.0)) < cutoff
                         and i not in self._ac_state]:
                self._close_episode(icao, "lost")

    # ── Degradation episode log ───────────────────────────────────────────────

    @staticmethod
    def _snapshot(ac: dict, now: float, dist_nm: float | None, pos_ts: float) -> dict:
        """Position / motion snapshot for an episode start, end or recovery."""
        def _r(v, nd=0):
            return None if v is None else round(v, nd) if nd else int(round(v))
        return {
            "t":       now,
            "lat":     _r(ac.get("lat"), 4),
            "lon":     _r(ac.get("lon"), 4),
            "alt":     _r(ac.get("altitude")),
            "trk":     _r(ac.get("track")),
            "vr":      _r(ac.get("vert_rate")),
            "gs":      _r(ac.get("groundspeed")),
            "dist":    _r(dist_nm, 1),
            "pos_age": _r(now - pos_ts) if pos_ts else None,
        }

    def _episode_step(self, icao: str, ac: dict, flags: list[str], now: float,
                      dist_nm: float | None, pos_ts: float,
                      sev: list[str] | None = None) -> None:
        """Open, extend or close this aircraft's degradation episode (lock held)."""
        ep = self._episodes.get(icao)
        if flags:
            if ep is None:
                # Episodes start only within the episode radius (current position)
                if dist_nm is None or dist_nm > self.episode_radius_nm:
                    return
                snap = self._snapshot(ac, now, dist_nm, pos_ts)
                ep = self._episodes[icao] = {
                    "icao": icao, "t_start": now, "start": snap,
                    "min_alt": None, "max_alt": None, "min_nacp": None, "min_nic": None,
                    "sig": set(), "sweeps": 0, "rec": None,
                    "sev": 0, "spf": set(), "mlat_nm": None, "cmp": 0,
                    "gmb_min": None, "gmb_max": None,
                }
            snap = self._snapshot(ac, now, dist_nm, pos_ts)
            ep["t_last"] = now
            ep["last"]   = snap
            ep["rec"]    = None          # degraded again — no recovery yet
            ep["sweeps"] += 1
            ep["sig"].update(flags)
            if sev:
                ep["sev"] = ep.get("sev", 0) + 1
            ep["callsign"] = ac.get("callsign") or ep.get("callsign")
            ep["type"]     = ac.get("aircraft_type") or ep.get("type")
            ep["reg"]      = ac.get("registration") or ep.get("reg")
            alt = ac.get("altitude")
            if alt is not None:
                ep["min_alt"] = alt if ep["min_alt"] is None else min(ep["min_alt"], alt)
                ep["max_alt"] = alt if ep["max_alt"] is None else max(ep["max_alt"], alt)
            nacp, nacp_ts = ac.get("nac_p"), ac.get("nac_p_ts")
            if nacp is not None and nacp_ts is not None and now - nacp_ts <= QUALITY_FRESH_SEC:
                ep["min_nacp"] = nacp if ep["min_nacp"] is None else min(ep["min_nacp"], nacp)
            nic, nic_ts = ac.get("nic"), ac.get("nic_ts")
            if nic is not None and nic_ts is not None and now - nic_ts <= QUALITY_FRESH_SEC:
                ep["min_nic"] = nic if ep["min_nic"] is None else min(ep["min_nic"], nic)
        elif ep is not None:
            if ep["rec"] is None:        # first clean sweep after the last degraded one
                ep["rec"] = self._snapshot(ac, now, dist_nm, pos_ts)
            if now - ep["t_last"] >= EPISODE_MERGE_SEC:
                self._close_episode(icao, "recovered")

    def _close_episode(self, icao: str, reason: str) -> None:
        """Move an open episode to the write buffer (lock held)."""
        ep = self._episodes.pop(icao, None)
        if ep is None or ep.get("sweeps", 0) == 0:
            return
        st, en, rc = ep["start"], ep["last"], ep.get("rec") or {}
        self._episode_buf.append((
            icao, ep.get("callsign"), ep.get("reg"), ep.get("type"),
            round(ep["t_start"], 1), round(ep["t_last"], 1),
            int(round(ep["t_last"] - ep["t_start"])), ep["sweeps"],
            ",".join(s for s in SIG_ORDER if s in ep["sig"]),
            ep["min_nacp"], ep["min_nic"],
            None if ep["min_alt"] is None else int(ep["min_alt"]),
            None if ep["max_alt"] is None else int(ep["max_alt"]),
            st["lat"], st["lon"], st["alt"], st["trk"], st["vr"], st["gs"], st["dist"],
            en["lat"], en["lon"], en["alt"], en["trk"], en["vr"], en["gs"], en["dist"], en["pos_age"],
            rc.get("lat"), rc.get("lon"), rc.get("alt"), rc.get("dist"),
            reason, METHOD_VERSION,
            ep.get("sev", 0),
            ",".join(k for k in SPOOF_KINDS if k in ep.get("spf", ())) or None,
            ep.get("mlat_nm"), ep.get("cmp", 0),
            ep.get("gmb_min"), ep.get("gmb_max"),
        ))

    def rebuild_live(self, live_state_snapshot: list[dict]) -> None:
        """
        Rebuild the live degraded-aircraft list from the current sweep, using
        the flags computed by update() in this sweep (no second evaluation).
        Called once per sweep after all update() calls are done.
        """
        now  = time.time()
        live = []
        with self._lock:
            for ac in live_state_snapshot:
                icao = ac.get("icao", "")
                st   = self._ac_state.get(icao)
                if not icao or not st or now - st.get("flags_ts", 0) > 10 or not st.get("flags"):
                    continue
                alt = ac.get("altitude")
                live.append({
                    "icao":        icao,
                    "callsign":    ac.get("callsign") or icao,
                    "altitude":    alt,
                    "fl_band":     _fl_band(alt),
                    "groundspeed": ac.get("groundspeed"),
                    "nac_p":       ac.get("nac_p"),
                    "nic":         ac.get("nic"),
                    "nic_rc_m":    ac.get("nic_rc_m"),
                    "nac_v":       ac.get("nac_v"),
                    "flags":       list(st["flags"]),
                    "last_seen":   ac.get("last_seen", now),
                })

            # Sort by altitude descending (highest first)
            live.sort(key=lambda x: x.get("altitude") or 0, reverse=True)
            self._live_events = live

        # Persist the in-progress hour periodically (restart safety)
        self.checkpoint()

    # ── 10-minute / severity / spoofing detail (GPS Quality page) ─────────────

    @staticmethod
    def _detail_part(ts: int, total: int, degraded: int, det: dict) -> dict:
        """The part of one hour's band_detail used by get_detail()."""
        return {
            "ts": int(ts), "total": total or 0, "degraded": degraded or 0,
            "t10":  det.get("t10"),
            "sevn": det.get("sevn", max((det.get("sev") or {"": 0}).values())),
            "spfn": det.get("spfn", 0),
            "s0":   det.get("s0") or {},
            "spf":  det.get("spf") or {},
            "spl":  det.get("spl") or [],
            "new":  "t10" in det,
        }

    def _read_detail_rows(self, zone: str, t0: float, t1: float) -> list[dict]:
        """Completed hours [t0, t1) of a zone from the DB (read only).  The
        flagged-aircraft list is kept in the All zone only; for a distance
        zone it is taken from there and filtered by distance."""
        out: dict[int, dict] = {}
        try:
            conn = get_db()
            if zone == "all":
                rows = conn.execute(
                    "SELECT ts, total, degraded, band_detail FROM gps_quality_hours "
                    "WHERE ts >= ? AND ts < ? AND band_detail IS NOT NULL ORDER BY ts",
                    (int(t0), int(t1))).fetchall()
            else:
                rows = conn.execute(
                    "SELECT ts, total, degraded, band_detail FROM gps_quality_zone_hours "
                    "WHERE zone = ? AND ts >= ? AND ts < ? AND band_detail IS NOT NULL ORDER BY ts",
                    (zone, int(t0), int(t1))).fetchall()
            for r in rows:
                try:
                    det = json.loads(r["band_detail"])
                except (TypeError, ValueError):
                    continue
                if "t10" not in det:
                    continue            # before 2026-10-09
                out[r["ts"]] = self._detail_part(r["ts"], r["total"], r["degraded"], det)
            if zone != "all" and out:
                limit = ZONE_LIMITS_NM[zone]
                for r in conn.execute(
                        "SELECT ts, band_detail FROM gps_quality_hours "
                        "WHERE ts >= ? AND ts < ? AND band_detail LIKE '%\"spl\"%'",
                        (int(t0), int(t1))).fetchall():
                    if r["ts"] in out:
                        try:
                            spl = json.loads(r["band_detail"]).get("spl") or []
                        except (TypeError, ValueError):
                            continue
                        out[r["ts"]]["spl"] = [e for e in spl
                                               if e.get("dist") is not None and e["dist"] <= limit]
        except Exception as exc:
            log.warning("GPS quality: reading detail rows failed: %s", exc)
        return [out[k] for k in sorted(out)]

    def get_detail(self, zone: str = "all", hours: int = 24) -> dict:
        """10-minute slots, severity and spoofing indicators for the last
        `hours` hours (GPS Quality page).  Completed hours are read from the
        DB once per hour and cached; the hour in progress comes from RAM.

        Returns:
          slots     — [[slot_ts, ac, deg, sev, spf, mac, mdeg], …] (T10_KEYS order)
          hours     — [[hour_ts, aircraft, degraded, severe, spoof-flagged], …]
          severity  — degraded / severe aircraft-hours and severe sweeps by kind
          spoof     — per indicator: sweeps and distinct aircraft; ADS-B/MLAT
                      comparisons (cmp) and sweeps with a GNSS − baro value
                      (gmb_n); the flagged aircraft, newest first
          since     — first hour with this detail in the window (None = none)
        """
        if zone not in ZONE_LIMITS_NM:
            zone = "all"
        hours = max(1, min(int(hours), DETAIL_MAX_HOURS))
        now = time.time()
        now_hour = _bucket_hour(now)
        t0 = now_hour - (hours - 1) * BUCKET_SEC
        key = (zone, hours, now_hour)
        with self._lock:
            done = self._detail_cache.get(key)
        if done is None:
            done = self._read_detail_rows(zone, t0, now_hour)
            with self._lock:
                # keep only this hour's entries, and only a few of them
                kept = {k: v for k, v in self._detail_cache.items() if k[2] == now_hour}
                self._detail_cache = kept if len(kept) < 12 else {}
                self._detail_cache[key] = done
        rows = list(done)
        with self._lock:
            zb = self._zone_buckets[zone] if zone in self._zone_buckets else self._buckets
            if zb and zb[-1]["ts"] >= now_hour and "t10" in zb[-1]:
                cur = self._detail_part(zb[-1]["ts"], zb[-1]["total"], zb[-1]["degraded"],
                                        _band_detail(zb[-1]))
                if zone != "all":
                    spl = []
                    if self._buckets and self._buckets[-1]["ts"] >= now_hour:
                        limit = ZONE_LIMITS_NM[zone]
                        spl = [{"icao": i, **e} for i, e in self._buckets[-1].get("spl", {}).items()
                               if e.get("dist") is not None and e["dist"] <= limit]
                    cur["spl"] = spl
                rows.append(cur)

        slots, hrs = [], []
        sev_kind: dict = {}
        sp_sweeps: dict = {}
        sp_ac: dict = {}
        flagged = []
        deg_h = sev_h = 0
        for r in rows:
            t10 = r["t10"] or {}
            for i in range(SLOTS):
                st = r["ts"] + i * SLOT_SEC
                if st > now:
                    break
                slots.append([st] + [(t10.get(k) or [0] * SLOTS)[i] for k in T10_KEYS])
            hrs.append([r["ts"], r["total"], r["degraded"], r["sevn"], r["spfn"]])
            deg_h += r["degraded"]
            sev_h += r["sevn"] or 0
            for d in r["s0"].values():
                for k, n in d.items():
                    sev_kind[k] = sev_kind.get(k, 0) + n
            for d in r["spf"].values():
                for k, n in d.items():
                    sp_sweeps[k] = sp_sweeps.get(k, 0) + n
            for e in r["spl"]:
                for k in e.get("k", ()):
                    sp_ac.setdefault(k, set()).add(e.get("icao"))
                for k in e.get("q", ()):
                    sp_ac.setdefault("ok_" + k, set()).add(e.get("icao"))
                flagged.append({**e, "t": r["ts"] + e.get("t", 0)})
        flagged.sort(key=lambda e: e["t"], reverse=True)
        return {
            "zone":     zone,
            "hours_n":  hours,
            "slot_sec": SLOT_SEC,
            "keys":     list(T10_KEYS),
            "since":    rows[0]["ts"] if rows else None,
            "slots":    slots,
            "hours":    hrs,
            "severity": {"degraded_ach": deg_h, "severe_ach": sev_h, "sweeps": sev_kind},
            "spoof": {
                "kinds":   {k: {"sweeps": sp_sweeps.get(k, 0), "aircraft": len(sp_ac.get(k, ())),
                                "ok_sweeps": sp_sweeps.get("ok_" + k, 0),
                                "ok_aircraft": len(sp_ac.get("ok_" + k, ()))}
                            for k in SPOOF_KINDS},
                "cmp":     sp_sweeps.get("cmp", 0),
                "gmb_n":   sp_sweeps.get("gmb_n", 0),
                "flagged": flagged[:SPOOF_LIST_OUT],
                "flagged_total": len(flagged),
            },
            "thresholds": {"mlat_nm": MLAT_DIS_NM, "gmb_jump_ft": GMB_JUMP_FT,
                           "gmb_sat_ft": GMB_SAT_FT, "jump_nm": JUMP_MIN_NM},
        }

    def get_state(self, zone: str = "all") -> dict:
        """
        Return a JSON-serialisable snapshot for the API endpoint.

        Args:
          zone: 'all' (default) uses the main bucket set; '50nm' or '20nm'
                uses the corresponding distance-filtered zone bucket set.

        Returns:
          live        — aircraft currently showing degraded GPS (list)
          time_series — hourly buckets for the requested zone (oldest first,
                        up to MAX_BUCKETS = 6 months, for the range selector)
          heatmap     — most recent buckets for the zone (up to
                        HEATMAP_MAX_BUCKETS = 31 days); capped independently
                        of time_series since the heatmap canvas only ever
                        renders the last 14 days regardless of how much is sent
          band_days   — {day_ts: {band: {ac, deg, sig}}} from band_detail
                        (aircraft-hours seen / degraded and signal events
                        per FL band and UTC day; days before 2026-10-06
                        have no entry)
          fl_bands    — ordered list of FL band label strings
          stats       — summary counts for the last 24 hours
          zone        — the active zone name (echoed back to the frontend)
        """
        with self._lock:
            if zone in self._zone_buckets:
                buckets = list(self._zone_buckets[zone])
            else:
                buckets = list(self._buckets)

        # Strip internal sets before serialising; freeze into plain counts
        def _clean(b: dict) -> dict:
            return {
                "ts":               b["ts"],
                "total":            b["total"],
                "degraded":         b["degraded"],
                "events":           b["events"],
                "nacp_events":      b.get("nacp_events",      0),
                "nic_events":       b.get("nic_events",       0),
                "freeze_events":    b.get("freeze_events",    0),
                "gap_events":       b.get("gap_events",       0),
                "adsb_loss_events": b.get("adsb_loss_events", 0),
                "fl_bands":         dict(b["fl_bands"]),
                "method":           b.get("method", 1),
            }

        cleaned = [_clean(b) for b in buckets]

        # Per-day, per-band aircraft counts and signal mix for the heatmap's
        # "% of aircraft degraded" mode and hover text (from band_detail; the
        # hour in progress is computed live).  Distinct aircraft are counted
        # per hour, so the day sums are aircraft-hours.
        band_days: dict = {}
        hm_cutoff = _bucket_hour(time.time()) - (HEATMAP_MAX_BUCKETS - 1) * BUCKET_SEC
        for b in buckets:
            if b["ts"] < hm_cutoff:
                continue
            det = b.get("band_detail")
            if det is None and "_band_seen" in b:
                det = _band_detail(b)
            if not det:
                continue
            day = str(int(b["ts"] // 86400 * 86400))
            dd = band_days.setdefault(day, {})
            for lbl, n in (det.get("ac") or {}).items():
                dd.setdefault(lbl, {"ac": 0, "deg": 0, "sig": {}})["ac"] += n
            for lbl, n in (det.get("deg") or {}).items():
                dd.setdefault(lbl, {"ac": 0, "deg": 0, "sig": {}})["deg"] += n
            for lbl, n in (det.get("sev") or {}).items():
                e = dd.setdefault(lbl, {"ac": 0, "deg": 0, "sig": {}})
                e["sev"] = e.get("sev", 0) + n
            for lbl, sig in (det.get("sig") or {}).items():
                tgt = dd.setdefault(lbl, {"ac": 0, "deg": 0, "sig": {}})["sig"]
                for k, n in sig.items():
                    tgt[k] = tgt.get(k, 0) + n

        # Heatmap only ever displays the most recent 14 days client-side, so
        # cap its payload independently rather than sending up to 6 months
        # of buckets on every 30-second poll.
        heatmap_cleaned = cleaned[-HEATMAP_MAX_BUCKETS:]

        # Last 24 hours for stats
        now_hour = _bucket_hour(time.time())
        ts_24h   = [b for b in cleaned
                    if b["ts"] >= now_hour - (23 * BUCKET_SEC)]

        # Severely degraded aircraft-hours over the last 24 h (recorded from
        # 2026-10-09; None while the whole window is older)
        severe_24h = None
        for b in buckets:
            if b["ts"] < now_hour - 23 * BUCKET_SEC or b["ts"] < FINE_DETAIL_SINCE:
                continue
            det = b.get("band_detail") or {}
            if "_sev" in b:
                n = len(b["_sev"])
            elif det.get("sevn") is not None:
                n = det["sevn"]
            else:           # first hours of 9 Oct: distinct per band only
                n = max((det.get("sev") or {"": 0}).values())
            severe_24h = (severe_24h or 0) + n

        # Stats over last 24 h
        events_24h   = sum(b["events"]   for b in ts_24h)
        degraded_24h = sum(b["degraded"] for b in ts_24h)
        peak_hour    = None
        if ts_24h:
            peak = max(ts_24h, key=lambda b: b["events"])
            if peak["events"] > 0:
                import datetime
                peak_hour = datetime.datetime.utcfromtimestamp(
                    peak["ts"]
                ).strftime("%H:00 UTC")

        return {
            "live":        self._live_events,
            "time_series": cleaned,
            "heatmap":     heatmap_cleaned,
            "band_days":   band_days,
            "fl_bands":    FL_BAND_LABELS,
            "zone":        zone,
            "stats": {
                "events_24h":   events_24h,
                "degraded_24h": degraded_24h,
                "severe_24h":   severe_24h,
                "peak_hour":    peak_hour,
            },
        }
