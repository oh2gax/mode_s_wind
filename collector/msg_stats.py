"""
msg_stats.py — Mode S / ADS-B message statistics for the Statistics page
(from 2026-10-25).

Counts, in RAM only (no database writes), what the collector receives from the
Radarcape Beast feed and the JSON poller:

  • feed      — messages (short 56-bit / long 112-bit), decode errors, blocked
                addresses, last message time, connection count
  • DF        — downlink formats 0 / 4 / 5 / 11 / 16 / 17 / 18 / 20 / 21 / 24
  • ADS-B     — DF17 type codes, velocity subtypes, ADS-B version (TC 31),
                velocity messages carrying the GNSS − baro height difference
  • Comm-B    — DF20/21 registers as inferred by pyModeS (BDS 1,0 … 6,0),
                ambiguous inferences (more than one candidate), replies whose
                address could not be verified
  • cadence   — time between successive replies of the same aircraft for BDS
                5,0 / 6,0 / 4,0 / 2,0, the surveillance replies DF4/5 and the
                ADS-B position / velocity squitters, by flight phase (final
                approach, terminal area, en route); near-duplicate replies
                (< 0.5 s) are counted apart, gaps over 60 s are not intervals
  • interrogators — DF11 all-call replies: the CRC remainder of a DF11 reply is
                its interrogator identifier (II code 1–15, or SI code 1–63;
                0 = acquisition squitter, not a reply), so the replies show which
                ground interrogators are active; the UM field of DF4/5/20/21
                (IIS / IDS: interrogator holding a reservation, its type)
  • meteo     — per new BDS 5,0 / 6,0 reply: a wind computed, a partner too
                old, or no wind (no partner in time / rejected by the checks);
                MRAR (BDS 4,4) and MHR (BDS 4,5) reports
  • JSON      — MLAT and ADS-B positions in the Radarcape aircraft list, WAM
                ground stations (blocked addresses such as T40…) it lists

Windows: one record per minute (counters, interval histograms, aircraft sets)
for the last hour, a compact per-minute vector of the main series for 24 h,
and the message count per 10 s for the last hour (rate sparkline).  About
2–4 MB of RAM in daytime traffic.  The counting costs a few microseconds per
message (dictionary increments; one CRC per DF11 reply).

Thread safety: the collector thread and the JSON poller write, the web thread
reads a snapshot (one lock; held only for increments and the snapshot copy).
"""

from __future__ import annotations

import math
import threading
import time
from collections import Counter, deque

# Interval histogram edges (s): bin i holds edges[i-1] <= dt < edges[i]
CAD_EDGES = (0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0, 15.0, 20.0, 30.0, 60.0)
CAD_DUP_SEC = 0.5          # closer replies of the same register: near-duplicates
CAD_GAP_SEC = 60.0         # longer: a gap, not an interval
CAD_KINDS = ("5,0", "6,0", "4,0", "2,0", "surv", "es_pos", "es_vel")
PHASES = ("final", "terminal", "enroute")
FINAL_ALT_FT, FINAL_NM = 5_000.0, 25.0
TERM_ALT_FT, TERM_NM = 10_000.0, 60.0
EHS_SILENT_SEC = 30.0      # an EHS aircraft with no BDS 5,0 for this long is "silent"
MINUTES_DETAIL = 60        # full minute records kept (1 h)
MINUTES_TREND = 1440       # compact minute vectors kept (24 h)

# compact 24 h series (per minute)
TREND_KEYS = ("msgs", "df4", "df5", "df11", "df17", "df20", "df21", "bds50", "bds60",
              "bds40", "bds20", "bds44", "ac", "ehs", "iid_n", "wind", "cad50_final",
              "cad50_term", "cad50_enr")

_EFHK = (60.3172, 24.9633)

# CRC-24 (Mode S, polynomial 0xFFF409), own table so it does not depend on the
# pyModeS version
_CRC_TABLE: list[int] = []
for _i in range(256):
    _c = _i << 16
    for _ in range(8):
        _c = ((_c << 1) ^ 0xFFF409) if _c & 0x800000 else (_c << 1)
    _CRC_TABLE.append(_c & 0xFFFFFF)


def crc_remainder(msg_hex: str) -> int | None:
    """Mode S CRC remainder of a 56- or 112-bit message (hex)."""
    try:
        n = int(msg_hex, 16)
    except ValueError:
        return None
    bits = len(msg_hex) * 4
    if bits not in (56, 112):
        return None
    crc, shift = 0, bits - 8
    for _ in range((bits - 24) // 8):
        crc = ((crc << 8) & 0xFFFFFF) ^ _CRC_TABLE[((crc >> 16) ^ (n >> shift)) & 0xFF]
        shift -= 8
    return crc ^ (n & 0xFFFFFF)


def df11_iid(msg_hex: str) -> tuple[str, int] | None:
    """Interrogator of a DF11 all-call reply: ("II", 1–15), ("SI", 1–63),
    ("SQ", 0) for an acquisition squitter, None when the remainder is not a
    valid interrogator code (a corrupted reply)."""
    r = crc_remainder(msg_hex)
    if r is None or r & ~0x7F:
        return None
    if r == 0:
        return ("SQ", 0)
    if r < 16:
        return ("II", r)
    return ("SI", r - 16)


def _dist_nm(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 3440.065 * 2 * math.asin(min(1.0, math.sqrt(a)))


def _new_minute(t0: float) -> dict:
    return {"t0": t0, "c": Counter(), "h": {}, "ac": {}, "ivar": {}}


def _hist_quantile(hist: list, q: float) -> float | None:
    n = sum(hist)
    if n == 0:
        return None
    target, acc = q * n, 0.0
    lo = CAD_DUP_SEC
    for i, k in enumerate(hist):
        hi = CAD_EDGES[i + 1] if i + 1 < len(CAD_EDGES) else CAD_GAP_SEC
        if acc + k >= target and k > 0:
            return round(lo + (hi - lo) * (target - acc) / k, 2)
        acc += k
        lo = hi
    return round(lo, 2)


class MsgStats:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.airport = _EFHK
        self.started = time.time()
        self.connects = 0
        self.connected_ts: float | None = None
        self.last_msg_ts: float | None = None
        self.total_msgs = 0
        self._min: dict = _new_minute(self._minute_of(time.time()))
        self._minutes: deque = deque(maxlen=MINUTES_DETAIL)
        self._trend: deque = deque(maxlen=MINUTES_TREND)
        self._ten: deque = deque(maxlen=360)          # [t0, msgs] per 10 s
        self._ten_cur = [self._ten_of(time.time()), 0]
        self._last: dict = {}        # (icao, kind) → time of the last reply
        self._seen: dict = {}        # icao → time of the last message (any)
        self._b50: dict = {}         # icao → time of the last BDS 5,0 reply
        self._iid_seen: dict = {}    # ("II", n) → [first, last]
        self._json: dict = {"ts": None, "entries": 0, "mlat": 0, "adsb": 0, "other": 0,
                            "polls": 0, "errors": 0, "stations": {}}

    # ── time slots ──────────────────────────────────────────────────────────
    @staticmethod
    def _minute_of(t: float) -> float:
        return float(int(t // 60) * 60)

    @staticmethod
    def _ten_of(t: float) -> float:
        return float(int(t // 10) * 10)

    def _roll(self, now: float) -> None:
        """Close the minute / 10-s slots that have ended (lock held)."""
        t10 = self._ten_of(now)
        if t10 != self._ten_cur[0]:
            self._ten.append(tuple(self._ten_cur))
            # empty 10-s slots in between (feed stalled)
            t = self._ten_cur[0] + 10
            while t < t10 and len(self._ten) < 400:
                self._ten.append((t, 0))
                t += 10
            self._ten_cur = [t10, 0]
        tm = self._minute_of(now)
        if tm != self._min["t0"]:
            m = self._min
            self._minutes.append(m)
            self._trend.append(self._compact(m))
            self._min = _new_minute(tm)
            # forget per-aircraft state of aircraft not heard for 10 min
            if len(self._seen) > 50:
                cut = now - 600
                for icao in [i for i, t in self._seen.items() if t < cut]:
                    self._seen.pop(icao, None)
                    self._b50.pop(icao, None)
                for k in [k for k, t in self._last.items() if t < cut]:
                    del self._last[k]

    def _compact(self, m: dict) -> list:
        c = m["c"]
        def med(kind, ph):
            h = m["h"].get((kind, ph))
            return _hist_quantile(h, 0.5) if h else None
        ac = m["ac"]
        return [m["t0"], c["msgs"], c[("df", 4)], c[("df", 5)], c[("df", 11)], c[("df", 17)],
                c[("df", 20)], c[("df", 21)], c[("bds", "5,0")], c[("bds", "6,0")],
                c[("bds", "4,0")], c[("bds", "2,0")], c[("bds", "4,4")],
                len(ac.get("all", ())), len(ac.get("ehs", ())),
                len({k for k in c if isinstance(k, tuple) and k[0] == "iid" and k[1] != "SQ"}),
                c[("met", "wind")], med("5,0", "final"), med("5,0", "terminal"), med("5,0", "enroute")]

    # ── feed events (collector thread) ──────────────────────────────────────
    def connected(self) -> None:
        with self._lock:
            self.connects += 1
            self.connected_ts = time.time()

    def raw(self, ts: float, msg_hex: str) -> None:
        """Every frame from the feed, before decoding."""
        now = time.time()
        with self._lock:
            self._roll(now)
            self.total_msgs += 1
            self.last_msg_ts = now
            self._ten_cur[1] += 1
            c = self._min["c"]
            c["msgs"] += 1
            c["short" if len(msg_hex) <= 14 else "long"] += 1

    def count(self, key) -> None:
        with self._lock:
            self._min["c"][key] += 1

    def _ac(self, cat, icao) -> None:
        s = self._min["ac"].get(cat)
        if s is None:
            s = self._min["ac"][cat] = set()
        s.add(icao)

    def _cadence(self, icao: str, kind: str, ts: float, phase: str | None) -> None:
        key = (icao, kind)
        prev = self._last.get(key)
        self._last[key] = ts
        if prev is None or phase is None:
            return
        dt = ts - prev
        c = self._min["c"]
        if dt < 0:
            return
        if dt < CAD_DUP_SEC:
            c[("dup", kind)] += 1
            c[("dup_ph", kind, phase)] += 1
            self._last[key] = prev      # keep the first of the pair as the reference
            return
        c[("cad_n", kind, phase)] += 1
        if dt >= CAD_GAP_SEC:
            c[("gap", kind, phase)] += 1
            return
        h = self._min["h"].get((kind, phase))
        if h is None:
            h = self._min["h"][(kind, phase)] = [0] * len(CAD_EDGES)
        i = 0
        while i + 1 < len(CAD_EDGES) and dt >= CAD_EDGES[i + 1]:
            i += 1
        h[i] += 1

    def message(self, ts: float, msg_hex: str, result: dict, alt, lat, lon) -> None:
        """One decoded, not blocked message (collector thread)."""
        df = result.get("df")
        icao = result.get("icao") or ""
        phase = None
        if alt is not None and lat is not None and lon is not None:
            d = _dist_nm(lat, lon, *self.airport)
            phase = ("final" if alt < FINAL_ALT_FT and d <= FINAL_NM else
                     "terminal" if alt < TERM_ALT_FT and d <= TERM_NM else "enroute")
        iid = df11_iid(msg_hex) if df == 11 else None
        with self._lock:
            c = self._min["c"]
            c[("df", df)] += 1
            self._ac("all", icao)
            self._ac(("df", df), icao)
            self._seen[icao] = ts
            if df == 17:
                tc = result.get("typecode")
                c[("tc", tc)] += 1
                self._ac("df17", icao)
                if tc is not None and (9 <= tc <= 18 or 20 <= tc <= 22):
                    self._cadence(icao, "es_pos", ts, phase)
                elif tc == 19:
                    c[("v19", result.get("subtype"))] += 1
                    if result.get("geo_minus_baro") is not None:
                        c["gmb"] += 1
                    self._cadence(icao, "es_vel", ts, phase)
                elif tc == 31 and result.get("version") is not None:
                    c[("ver", result.get("version"))] += 1
                    self._ac(("ver", result.get("version")), icao)
            elif df in (20, 21):
                bds = result.get("bds") or "?"
                c[("bds", bds)] += 1
                self._ac(("bds", bds), icao)
                self._ac("commb", icao)
                cand = result.get("bds_candidates")
                if cand and len(cand) > 1:
                    c["ambig"] += 1
                if result.get("icao_verified") is False:
                    c["unverified"] += 1
                if bds in ("5,0", "6,0"):
                    self._ac("ehs", icao)
                    if bds == "5,0":
                        self._b50[icao] = ts
                if bds in ("5,0", "6,0", "4,0", "2,0"):
                    self._cadence(icao, bds, ts, phase)
            elif df == 11:
                if iid is None:
                    c["df11_bad"] += 1
                else:
                    c[("iid",) + iid] += 1
                    if iid[0] != "SQ":
                        self._ac(("iid",) + iid, icao)
                        fl = self._iid_seen.get(iid)
                        if fl is None:
                            self._iid_seen[iid] = [ts, ts]
                        else:
                            fl[1] = ts
            if df in (4, 5, 20, 21):
                um = result.get("utility_message")
                if um:
                    c[("um", um >> 2, um & 3)] += 1
                if df in (4, 5):
                    self._cadence(icao, "surv", ts, phase)

    def meteo(self, kind: str) -> None:
        """Per new BDS 5,0 / 6,0 reply: 'wind' (a wind computed and stored),
        'wind_old' (its partner reply older than WIND_MAX_AGE_SEC), 'nowind'
        (no partner within WIND_MAX_PAIR_AGE, or rejected by the checks: roll,
        track rate, speed); 'temp' (Mach/TAS temperature with the wind);
        'mrar' / 'mhr' per BDS 4,4 / 4,5 report."""
        with self._lock:
            self._min["c"][("met", kind)] += 1

    # ── JSON poller ──────────────────────────────────────────────────────────
    def json_poll(self, entries: int, mlat: int, adsb: int, other: int,
                  stations: dict | None = None) -> None:
        now = time.time()
        with self._lock:
            j = self._json
            j.update(ts=now, entries=entries, mlat=mlat, adsb=adsb, other=other)
            j["polls"] += 1
            for code, info in (stations or {}).items():
                s = j["stations"].setdefault(code, {"first": now})
                s.update(info)
                s["last"] = now
            self._min["c"]["json_polls"] += 1
            self._min["c"]["json_mlat"] += mlat

    def json_error(self) -> None:
        with self._lock:
            self._json["errors"] += 1

    # ── snapshot (web thread) ───────────────────────────────────────────────
    def snapshot(self, window_min: int = 10) -> dict:
        now = time.time()
        window_min = max(1, min(60, int(window_min)))
        with self._lock:
            self._roll(now)
            mins = list(self._minutes)[-(window_min - 1):] if window_min > 1 else []
            mins = mins + [self._min]
            c = Counter()
            hist: dict = {}
            ac: dict = {}
            for m in mins:
                c.update(m["c"])
                for k, h in m["h"].items():
                    t = hist.setdefault(k, [0] * len(CAD_EDGES))
                    for i, v in enumerate(h):
                        t[i] += v
                for k, s in m["ac"].items():
                    ac.setdefault(k, set()).update(s)
            secs = max(1.0, now - mins[0]["t0"])
            ten = list(self._ten)[-360:]
            trend = list(self._trend)
            iid_seen = {k: list(v) for k, v in self._iid_seen.items()}
            js = dict(self._json, stations={k: dict(v) for k, v in self._json["stations"].items()})
            # EHS aircraft heard in the last 10 s whose last BDS 5,0 is older than 30 s
            recent = {i for i, t in self._seen.items() if now - t <= 10}
            silent = sum(1 for i in recent if i in self._b50 and now - self._b50[i] > EHS_SILENT_SEC
                         and now - self._b50[i] <= 600)
            ehs_now = sum(1 for i in recent if i in self._b50 and now - self._b50[i] <= EHS_SILENT_SEC)
            feed = {"started": self.started, "connects": self.connects,
                    "connected_ts": self.connected_ts, "last_msg_ts": self.last_msg_ts,
                    "total_msgs": self.total_msgs}
        rate = lambda n: round(n / secs, 2)
        n_ac = lambda k: len(ac.get(k, ()))
        # downlink formats
        dfs = []
        for df in (0, 4, 5, 11, 16, 17, 18, 19, 20, 21, 24):
            n = c[("df", df)]
            if n or df in (0, 4, 5, 11, 16, 17, 18, 20, 21):
                dfs.append({"df": df, "n": n, "rate": rate(n), "ac": n_ac(("df", df))})
        # ADS-B type codes
        tcs = sorted(((k[1], v) for k, v in c.items() if isinstance(k, tuple) and k[0] == "tc"),
                     key=lambda x: (x[0] is None, x[0] or 0))
        v19 = {str(k[1]): v for k, v in c.items() if isinstance(k, tuple) and k[0] == "v19"}
        ver = {str(k[1]): {"n": v, "ac": n_ac(("ver", k[1]))}
               for k, v in c.items() if isinstance(k, tuple) and k[0] == "ver"}
        # Comm-B
        bds = sorted(((k[1], v) for k, v in c.items() if isinstance(k, tuple) and k[0] == "bds"),
                     key=lambda x: x[0])
        commb = c[("df", 20)] + c[("df", 21)]
        # cadence
        cad = []
        for kind in CAD_KINDS:
            for ph in PHASES:
                h = hist.get((kind, ph))
                n_int = sum(h) if h else 0
                dup = c[("dup_ph", kind, ph)]
                gaps = c[("gap", kind, ph)]
                if not (n_int or dup or gaps):
                    continue
                cad.append({"kind": kind, "phase": ph, "n": n_int, "dup": dup, "gaps": gaps,
                            "median": _hist_quantile(h, 0.5) if h else None,
                            "p90": _hist_quantile(h, 0.9) if h else None,
                            "hist": h or [0] * len(CAD_EDGES)})
        # interrogators
        iids = []
        for k, v in c.items():
            if isinstance(k, tuple) and k[0] == "iid":
                code = (k[1], k[2])
                fl = iid_seen.get(code)
                iids.append({"type": k[1], "code": k[2], "n": v, "rate": rate(v),
                             "ac": n_ac(("iid",) + code) if k[1] != "SQ" else None,
                             "first": fl[0] if fl else None, "last": fl[1] if fl else None})
        iids.sort(key=lambda x: (x["type"] == "SQ", -x["n"]))
        # interrogators heard earlier but not in this window
        in_win = {(x["type"], x["code"]) for x in iids}
        quiet = [{"type": k[0], "code": k[1], "first": v[0], "last": v[1]}
                 for k, v in iid_seen.items() if k not in in_win]
        um = sorted(({"iis": k[1], "ids": k[2], "n": v} for k, v in c.items()
                     if isinstance(k, tuple) and k[0] == "um"), key=lambda x: -x["n"])
        return {
            "now": now, "window_min": window_min, "window_sec": round(secs, 1),
            "feed": feed,
            "totals": {"msgs": c["msgs"], "rate": rate(c["msgs"]), "short": c["short"],
                       "long": c["long"], "dec_err": c["dec_err"], "err": c["err"],
                       "blocked": c["blocked"], "aircraft": n_ac("all"), "adsb": n_ac("df17"),
                       "ehs": n_ac("ehs"), "ehs_now": ehs_now, "ehs_silent": silent},
            "df": dfs,
            "adsb": {"tc": [{"tc": t, "n": v, "rate": rate(v)} for t, v in tcs], "v19": v19,
                     "gmb": c["gmb"], "ver": ver},
            "commb": {"total": commb, "ambig": c["ambig"], "unverified": c["unverified"],
                      "ehs_ac": n_ac("ehs"), "ac": n_ac("commb"),
                      "bds": [{"bds": b, "n": v, "rate": rate(v), "ac": n_ac(("bds", b))}
                              for b, v in bds]},
            "cadence": {"edges": list(CAD_EDGES), "rows": cad},
            "iid": {"rows": iids, "quiet": quiet, "df11_bad": c["df11_bad"], "um": um[:20]},
            "meteo": {k: c[("met", k)] for k in ("wind", "wind_old", "nowind", "temp", "mrar", "mhr")},
            "json": js,
            "ten": ten,
            "trend": {"keys": ["t0"] + list(TREND_KEYS), "rows": trend},
        }


_STATS = MsgStats()


def get() -> MsgStats:
    return _STATS
