"""
Airport low-level profile (from 2026-10-11).

Pools the 200 ft band profiles of the landings (approach_history.prof_json,
collector/windshear.py) and departures (departure_profiles.prof_json,
collector/departures.py) of the last N minutes into one temperature / wind
profile from 200 to 3 000 ft MSL near the airport (from 30 Oct 2026 up to
5 000 ft: above 3 000 ft from the departures only, collector/departures.py
DEP_BANDS).  Each band profile was
built from every raw BDS 5,0 / 6,0 reply on final or in the climb (not the
30 s stored observations), so a busy hour gives some hundred replies per
200 ft band — enough to resolve low-level inversions that the 1 000 ft layers
of the area profile smooth out.

Per band: temperature = reply-weighted mean of the per-flight trimmed means,
temp_p10 / temp_p90 over the flights, temp_count = number of flights (the
uncertainty the Skew-T analysis uses), temp_replies = replies; wind = vector
mean of the per-flight band winds weighted by their pairs, wind_sd = RMS
spread between flights.  Heights: the bands are MSL (METAR QNH at the time of
the flight); `altitude` is the pressure altitude (QNH-corrected back) and
`pressure` its ISA pressure, as in the area profile, so both plot on the same
Skew-T axes.
"""

from __future__ import annotations

import json
import math
import time

from collector.atmos import isa_pressure_hpa

QNH_FT_PER_HPA = 27.0          # as collector/windshear.py


def _pct(v, q):
    v = sorted(v)
    if not v:
        return None
    k = (len(v) - 1) * q
    i = int(k)
    return v[i] if i + 1 >= len(v) else v[i] + (v[i + 1] - v[i]) * (k - i)


def lowlevel_profile(db, minutes: int = 60, now: float | None = None) -> dict:
    now = now or time.time()
    minutes = max(10, min(int(minutes or 60), 360))
    t0 = now - minutes * 60
    recs = []
    for src, sql in (("arr", "SELECT ts, qnh_hpa, prof_json FROM approach_history "
                             "WHERE ts >= ? AND ts <= ? AND prof_json IS NOT NULL"),
                     ("dep", "SELECT ts, qnh_hpa, prof_json FROM departure_profiles "
                             "WHERE ts >= ? AND ts <= ?")):
        try:
            for ts, qnh, pj in db.execute(sql, (t0, now)):
                try:
                    recs.append((src, qnh, json.loads(pj)))
                except (TypeError, ValueError):
                    pass
        except Exception:
            pass                                   # table missing on an old DB
    bands: dict[int, dict] = {}
    for src, qnh, prof in recs:
        corr = (1013.25 - qnh) * QNH_FT_PER_HPA if qnh else 0.0
        for b, d in (prof or {}).items():
            try:
                band = int(b)
            except ValueError:
                continue
            B = bands.setdefault(band, {"t": [], "tn": [], "u": [], "v": [], "wn": [],
                                        "pa": [], "arr": 0, "dep": 0})
            B["pa"].append(band + corr)
            B[src] += 1
            if d.get("t") is not None and d.get("tn"):
                B["t"].append(float(d["t"]))
                B["tn"].append(int(d["tn"]))
            if d.get("ws") is not None and d.get("wd") is not None and d.get("n"):
                r = math.radians(d["wd"])
                B["u"].append(-d["ws"] * math.sin(r))
                B["v"].append(-d["ws"] * math.cos(r))
                B["wn"].append(int(d["n"]))
    levels = []
    for band in sorted(bands):
        B = bands[band]
        pa = sum(B["pa"]) / len(B["pa"])
        lv = {"alt_msl": band, "altitude": round(pa), "pressure": round(isa_pressure_hpa(pa), 1),
              "alt_lo": band - 100, "alt_hi": band + 100,
              "n_arr": B["arr"], "n_dep": B["dep"]}
        if B["t"]:
            w = sum(B["tn"])
            lv["temp"] = round(sum(t * n for t, n in zip(B["t"], B["tn"])) / w, 2)
            lv["temp_p10"] = round(_pct(B["t"], 0.1), 1)
            lv["temp_p90"] = round(_pct(B["t"], 0.9), 1)
            lv["temp_count"] = len(B["t"])
            lv["temp_replies"] = w
        if B["u"]:
            w = sum(B["wn"])
            um = sum(u * n for u, n in zip(B["u"], B["wn"])) / w
            vm = sum(v * n for v, n in zip(B["v"], B["wn"])) / w
            lv["wind_spd"] = round(math.hypot(um, vm), 1)
            lv["wind_dir"] = round((math.degrees(math.atan2(-um, -vm)) + 360) % 360, 1)
            lv["wind_count"] = len(B["u"])
            lv["wind_sd"] = round(math.sqrt(sum((u - um) ** 2 + (v - vm) ** 2
                                                for u, v in zip(B["u"], B["v"])) / len(B["u"])), 1)
        levels.append(lv)
    return {
        "window_min": minutes,
        "generated_at": now,
        "arrivals": sum(1 for r in recs if r[0] == "arr"),
        "departures": sum(1 for r in recs if r[0] == "dep"),
        "levels": levels,
    }
