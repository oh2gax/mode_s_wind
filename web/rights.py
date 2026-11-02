"""
web/rights.py — which receivers a web user may see one by one (from 2026-11-02).

With more receivers (EXTRA_RECEIVERS, collector/multirx.py) the Statistics page
(and the phone's Statistics view) has a tab per receiver.  Everyone sees
"All receivers" (the merged replies the weather is computed from); a single
receiver's own statistics, its feed in the system health and its own coverage
line on the Live Map are shown only to

  * its owners — the users it is earmarked to (a user may own several);
  * the users with Full view — every receiver;
  * the maintenance user (dbadmin) — always Full view.

A user can own receivers and have Full view at the same time.  The built-in
user of config.py (the shared test login) and everyone else see All receivers
only.  The rights are set on the Maintenance page (maintenance login only) and
kept per server in webrights.json next to the users file (webusers.txt), or
WEB_RIGHTS_FILE:

    {"version": 1,
     "users": {"alice": {"full": false, "own": ["MODES-RX-02"]},
               "bob":   {"full": true,  "own": ["MODES-RX-01"]}}}

The file is re-read when it changes (checked at most every 2 s) and written
only from the Maintenance page (atomic replace, mode 600).  Receivers that are
not configured on this server keep their owners (shown as such on the
Maintenance page).  Removing a user removes its rights.  The pages only show
what the server sends: the filtering is done in the API answers
(/api/msgstats, /api/health, /api/coverage — web/app.py).
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from typing import Optional

log = logging.getLogger("modes.web")

FILE_NAME = "webrights.json"
RECHECK_SEC = 2.0
RX_RE = re.compile(r"^[A-Za-z0-9._-]{1,40}$")

_lock = threading.Lock()
_st = {"path": None, "key": None, "checked": 0.0, "users": {}}


def path(cfg) -> Optional[str]:
    p = getattr(cfg, "WEB_RIGHTS_FILE", "") or ""
    if p:
        return p
    from web import users as web_users
    up = web_users.users_path(cfg)
    return os.path.join(os.path.dirname(os.path.abspath(up)), FILE_NAME) if up else None


def _mtime(p):
    try:
        s = os.stat(p) if p else None
        return (s.st_mtime_ns, s.st_size) if s else None
    except OSError:
        return None


def _clean(entry) -> dict:
    if not isinstance(entry, dict):
        return {"full": False, "own": []}
    own = entry.get("own") or []
    own = sorted({str(x) for x in own if isinstance(x, str) and RX_RE.match(x)}) if isinstance(own, list) else []
    return {"full": bool(entry.get("full")), "own": own}


def _load(cfg, force: bool = False) -> dict:
    """The users' rights {username: {"full", "own"}} (re-read when the file changed)."""
    now = time.monotonic()
    with _lock:
        if not force and _st["key"] is not None and now - _st["checked"] < RECHECK_SEC:
            return _st["users"]
        p = path(cfg)
        key = (p, _mtime(p))
        _st["checked"] = now
        if force or key != _st["key"]:
            users = {}
            if p and key[1] is not None:
                try:
                    with open(p, encoding="utf-8") as f:
                        d = json.load(f) or {}
                    for u, e in (d.get("users") or {}).items():
                        e = _clean(e)
                        if e["full"] or e["own"]:
                            users[str(u)] = e
                except (OSError, ValueError, AttributeError) as exc:
                    log.warning("Rights file not read: %s", exc)
            _st.update(path=p, key=key, users=users)
        return _st["users"]


def _save(cfg, users: dict) -> None:
    from web import users as web_users
    p = path(cfg)
    if not p:
        raise OSError("no users file folder: set MAINTENANCE_AUTH_FILE (or WEB_USERS_FILE) in config.py")
    data = {"version": 1, "users": {u: users[u] for u in sorted(users, key=str.lower)}}
    web_users._write_atomic(p, json.dumps(data, indent=1, ensure_ascii=False) + "\n")
    _load(cfg, force=True)


def of_user(cfg, username: Optional[str]) -> dict:
    """{"full": bool, "own": [receiver ids], "maint": bool} of a logged-in user;
    the maintenance user always has Full view."""
    from web import users as web_users
    u = username or ""
    if u and web_users.is_maint(cfg, u):
        return {"full": True, "own": list(_load(cfg).get(u, {}).get("own", [])), "maint": True}
    if not u or u == str(getattr(cfg, "WEB_USER", "")):
        return {"full": False, "own": [], "maint": False}
    e = _load(cfg).get(u)
    return {"full": bool(e and e["full"]), "own": list(e["own"]) if e else [], "maint": False}


def visible(r: dict, rx_id: str) -> bool:
    """Whether a user with the rights r may see the receiver rx_id one by one."""
    return bool(r.get("full")) or rx_id in (r.get("own") or [])


def all_rights(cfg) -> dict:
    """Every user's rights (the Maintenance page)."""
    return {u: dict(e) for u, e in _load(cfg, force=True).items()}


def set_rights(cfg, username: str, full: bool, own) -> None:
    """Full view and the own receivers of a user of the users file."""
    from web import users as web_users
    if not web_users.is_file_user(cfg, username):
        raise ValueError(f"no personal user {username} (the built-in and the maintenance user have fixed rights)")
    own = own if isinstance(own, list) else []
    bad = [x for x in own if not (isinstance(x, str) and RX_RE.match(x))]
    if bad:
        raise ValueError("not a receiver id: " + ", ".join(map(str, bad))[:80])
    e = _clean({"full": full, "own": own})
    users = dict(_load(cfg, force=True))
    if e["full"] or e["own"]:
        users[username] = e
    else:
        users.pop(username, None)
    _save(cfg, users)
    log.info("Web user rights changed: %s", username)


def remove(cfg, username: str) -> None:
    """A removed user's rights (web/users.py remove_user)."""
    users = dict(_load(cfg, force=True))
    if username in users:
        users.pop(username)
        _save(cfg, users)


# ── Filtering the API answers (web/app.py) ─────────────────────────────────

def level(r: dict) -> str:
    return "full" if r.get("full") else ("own" if r.get("own") else "all")


def filter_msgstats(out: dict, r: dict, all_ids: list) -> dict:
    """/api/msgstats for a user without Full view: only the tabs the user may
    see; on the All receivers tab the receivers it may not see are summed up
    ("N other receivers") and the who-heard-it counts grouped without their
    names; the Radarcape's own status only with the main receiver.  `out` is
    the user's own copy.  all_ids: every receiver's id (the main one first)."""
    own = [x for x in (r.get("own") or []) if x in all_ids]
    out["access"] = {"level": level(r), "own": own}
    out["rx_count"] = len(all_ids)
    if r.get("full"):
        return out
    recs = out.get("receivers") or []
    out["rx_live"] = sum(1 for x in recs if x.get("type") != "merged" and x.get("live"))
    out["receivers"] = [x for x in recs if x.get("sel", "") == "" or visible(r, x.get("id", ""))]
    rx = out.get("rx") or {}
    if rx.get("view") == "all":
        lst = rx.get("receivers") or []
        vis = [x for x in lst if visible(r, x.get("id", ""))]
        hid = [x for x in lst if not visible(r, x.get("id", ""))]
        bits = {str(x.get("bit")): x.get("id") for x in lst}
        rows = list(vis)
        if hid:
            rates = [x.get("rate") for x in hid if x.get("rate") is not None]
            rows.append({"id": "OTHER", "other": len(hid), "name": "", "type": "other",
                         "live": any(x.get("live") for x in hid), "n_live": sum(1 for x in hid if x.get("live")),
                         "rate": sum(rates) if rates else None, "clock": "merged", "delay": None, "cmp": None,
                         "frames": None, "bit": None})
        groups: dict = {}
        mg = dict(rx.get("merged") or {})
        for m, n in (mg.get("masks") or {}).items():
            try:
                ids = [bits.get(str(b)) for b in range(32) if (int(m) >> b) & 1]
            except ValueError:
                continue
            if len(ids) > 1:
                lbl, k = "heard by more than one receiver", 2
            elif ids and ids[0] and visible(r, ids[0]):
                lbl, k = "only " + ids[0], 1
            elif not vis:
                lbl, k = "heard by one receiver only", 1
            else:
                lbl, k = ("only the other receiver" if len(hid) == 1 else "only the other receivers"), 1
            g = groups.setdefault(lbl, [lbl, 0, k])
            g[1] += n
        mg.pop("masks", None)
        mg["groups"] = sorted(groups.values(), key=lambda g: (-g[2], -g[1]))
        rx = dict(rx, receivers=rows, merged=mg)
        out["rx"] = rx
        if all_ids and not visible(r, all_ids[0]):
            out["radarcape"] = None
    return out


def filter_health(h: dict, r: dict, main_id: str, extra_ids: list) -> dict:
    """/api/health for a user without Full view: the feed dots of the receivers
    it may not see become one "Feeds" line (the worst state of them); the
    overall state and the counts still count every feed."""
    if r.get("full") or not extra_ids:
        return h
    keyid = {"feed": main_id}
    keyid.update({"rx:" + x: x for x in extra_ids})
    hidden = {k for k, i in keyid.items() if not visible(r, i)}
    if not hidden:
        return h
    rank = {"off": 0, "ok": 1, "warn": 2, "err": 3}
    items, summary = [], None
    hid_items = [i for i in h.get("items", []) if i.get("key") in hidden]
    for it in h.get("items", []):
        if it.get("key") not in hidden:
            items.append(it)
            continue
        if summary is None:
            n, live = len(hid_items), sum(1 for i in hid_items if i.get("state") == "ok")
            worst = max(hid_items, key=lambda i: rank.get(i.get("state"), 0))
            other = len(hidden) < len(keyid)
            word = ("other receiver" if n == 1 else "other receivers") if other else ("receiver" if n == 1 else "receivers")
            summary = {"key": "feeds", "label": "Other feeds" if other else "Feeds",
                       "title": "The receivers' Beast feeds (the details only for their owners)",
                       "state": worst.get("state"),
                       "text": f"{n} {word}, {live} live" if live < n or n > 1 else f"{n} {word}, live",
                       "detail": [], "since": min((i.get("since") or 0) for i in hid_items) or None}
            items.append(summary)
    changes = []
    for c in h.get("changes", []):
        if c.get("key") in hidden:
            c = dict(c, key="feeds", label="Feeds", text="a receiver feed")
        changes.append(c)
    return dict(h, items=items, changes=changes)


def _xy(lat, lon, lat0, lon0):
    import math
    return ((lon - lon0) * math.cos(math.radians(lat0)) * 60.0, (lat - lat0) * 60.0)


def combined_outline(recs: list, step: float = 5.0):
    """The outline of the union of the receivers' coverage areas, seen from the
    first receiver's antenna: per `step`° bearing the farthest crossing of the
    ray with any receiver's outline (NM).  For the users who may not see the
    receivers' own lines (the Live Map draws this one line instead)."""
    import math
    from collector.msg_stats import _dest
    polys = [x for x in recs if x.get("outline") and len(x["outline"]) >= 3]
    if not polys or recs[0].get("lat") is None:
        return None
    lat0, lon0 = recs[0]["lat"], recs[0]["lon"]
    segs = []
    for pr in polys:
        pts = [_xy(a, b, lat0, lon0) for a, b in pr["outline"]]
        secs = [s for s in (pr.get("sectors") or []) if s]
        for i in range(len(pts)):
            a, b = pts[i], pts[(i + 1) % len(pts)]
            alt_a = secs[i]["alt"] if i < len(secs) else None
            alt_b = secs[(i + 1) % len(pts)]["alt"] if (i + 1) % len(pts) < len(secs) else None
            segs.append((a, b, alt_a, alt_b))
    outline, sectors = [], []
    n = int(round(360 / step))
    for k in range(n):
        brg = (k + 0.5) * step
        dx, dy = math.sin(math.radians(brg)), math.cos(math.radians(brg))
        best = None
        for (ax, ay), (bx, by), alt_a, alt_b in segs:
            ex, ey = bx - ax, by - ay
            den = dx * ey - dy * ex
            if abs(den) < 1e-12:
                continue
            t = (ax * ey - ay * ex) / den
            u = (ax * dy - ay * dx) / den
            if t > 0 and -1e-9 <= u <= 1 + 1e-9 and (best is None or t > best[0]):
                best = (t, alt_a if u < 0.5 else alt_b)
        if best is None:
            continue
        plat, plon = _dest(lat0, lon0, brg, best[0])
        outline.append([round(plat, 4), round(plon, 4)])
        sectors.append({"brg": brg, "nm": round(best[0], 1), "alt": best[1], "band": None})
    if len(outline) < 3:
        return None
    far = max(sectors, key=lambda s: s["nm"])
    return {"id": "ALL", "name": "All receivers", "type": "merged", "lat": None, "lon": None,
            "step": step, "outline": outline, "sectors": sectors, "farthest": far}


def filter_coverage(out: dict, r: dict) -> dict:
    """/api/coverage for a user without Full view: every receiver keeps its
    marker (id, name, type, position to 0.01°); the outlines only of the
    receivers it may see, and one combined outline ("combined") of all."""
    recs = out.get("receivers") or []
    if r.get("full") or len(recs) < 2:
        return out
    comb = combined_outline(recs)
    keep = []
    for x in recs:
        if visible(r, x.get("id", "")):
            keep.append(x)
        else:
            keep.append({k: x.get(k) for k in ("id", "name", "type", "lat", "lon", "src")} | {"outline": [], "sectors": [], "farthest": None})
    return dict(out, receivers=keep, combined=comb, restricted=True)
