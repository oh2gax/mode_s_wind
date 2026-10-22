"""
whats_new.py — version number and the "What's new" notes of the web pages
(from 2026-10-22).

Version: one per day of development, v.DDMMYYYY — the newest version in
doc/whats_new.md or CHANGELOG.md ("## v.22102026 — 2026-10-22 (…)" or the older
form "## 2026-10-22 (…)"), whichever is newer, so it changes by itself with the
notes (the CHANGELOG need not be copied to the device).

Notes: doc/whats_new.md, short user-oriented notes per version:

    ## v.22102026 — title
    - bullet (**bold**, *italic*, `code`)
      - sub-bullet
    plain paragraph

User guides: doc/guides.md lists the PDF guides of the User guides tab
(title, file, version, date, pages, the pages whose ? button opens it, and a
description). Only the files listed there are served (/doc/<file>).

The files are read again only when they change (mtime).
"""

from __future__ import annotations

import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHANGELOG = os.path.join(ROOT, "CHANGELOG.md")
DOC_DIR = os.path.join(ROOT, "doc")
NOTES = os.path.join(DOC_DIR, "whats_new.md")
GUIDES = os.path.join(DOC_DIR, "guides.md")
MAX_ENTRIES = 10

_cache: dict = {}


def _cached(path: str, parse):
    try:
        mt = os.path.getmtime(path)
    except OSError:
        return None
    c = _cache.get(path)
    if c and c[0] == mt:
        return c[1]
    try:
        with open(path, encoding="utf-8") as f:
            val = parse(f.read())
    except OSError:
        val = None
    _cache[path] = (mt, val)
    return val


_HEAD = re.compile(r"^##\s+(?:v\.(\d{2})(\d{2})(\d{4})\b|(\d{4})-(\d{2})-(\d{2})\b)", re.M)


def _parse_version(text: str):
    """Newest version among the '## v.DDMMYYYY' / '## YYYY-MM-DD' headings."""
    vs = [f"v.{m[1]}{m[2]}{m[3]}" if m[1] else f"v.{m[6]}{m[5]}{m[4]}" for m in _HEAD.finditer(text)]
    return max(vs, key=lambda v: v[6:10] + v[4:6] + v[2:4]) if vs else None


def _key(v: str) -> str:
    return v[6:10] + v[4:6] + v[2:4]                 # v.DDMMYYYY -> YYYYMMDD


def version() -> str:
    """v.DDMMYYYY of the newest entry of doc/whats_new.md or CHANGELOG.md ('' when none)."""
    cands = [e["version"] for e in (_cached(NOTES, _parse_notes) or [])[:1]]
    cands.append(_cached(CHANGELOG, _parse_version))
    cands = [v for v in cands if v]
    return max(cands, key=_key) if cands else ""


def _parse_notes(text: str) -> list:
    out, cur = [], None
    for line in text.splitlines():
        m = re.match(r"^##\s+(v\.\d{8})\s*(?:[—-]\s*(.*))?$", line.strip())
        if m:
            cur = {"version": m.group(1), "title": (m.group(2) or "").strip(), "lines": []}
            out.append(cur)
            continue
        if cur is not None:
            cur["lines"].append(line.rstrip())
    for e in out:                                   # trim blank lines at the ends
        while e["lines"] and not e["lines"][-1].strip():
            e["lines"].pop()
        while e["lines"] and not e["lines"][0].strip():
            e["lines"].pop(0)
        d = e["version"][2:]
        e["date"] = f"{d[4:]}-{d[2:4]}-{d[:2]}"
    out.sort(key=lambda e: e["date"], reverse=True)    # newest first, whatever the file order
    return out


def entries(n: int = MAX_ENTRIES) -> list:
    """The newest n notes: [{"version", "date", "title", "lines": [markdown lines]}]."""
    return (_cached(NOTES, _parse_notes) or [])[:n]


# ── User guides (doc/guides.md) ──────────────────────────────────────────────

_KEYS = ("file", "version", "date", "pages", "open")


def _parse_guides(text: str) -> list:
    out, cur, in_head = [], None, False
    for line in text.splitlines():
        m = re.match(r"^##\s+(.+?)\s*$", line)
        if m:
            cur = {"title": m.group(1), "lines": []}
            out.append(cur)
            in_head = True
            continue
        if cur is None:
            continue
        if in_head:
            kv = re.match(r"^(\w+)\s*:\s*(.*?)\s*$", line)
            if kv and kv.group(1).lower() in _KEYS:
                cur[kv.group(1).lower()] = kv.group(2)
                continue
            if not line.strip():
                continue
            in_head = False
        cur["lines"].append(line.rstrip())
    good = []
    for g in out:
        f = os.path.basename(g.get("file", ""))
        if not f.lower().endswith(".pdf"):
            continue
        while g["lines"] and not g["lines"][-1].strip():
            g["lines"].pop()
        opens = {}
        for item in (g.pop("open", "") or "").split(","):
            key, _, page = item.strip().partition("@")
            if key:
                opens[key.lower()] = int(page) if page.isdigit() else None
        g["file"], g["open"] = f, opens
        good.append(g)
    return good


def guides() -> list:
    """The guides of doc/guides.md that exist:
    [{"title", "file", "url", "version", "date", "pages", "size", "lines", "open"}]."""
    out = []
    for g in _cached(GUIDES, _parse_guides) or []:
        path = os.path.join(DOC_DIR, g["file"])
        try:
            size = os.path.getsize(path)
        except OSError:
            continue                                   # listed but not on this device
        out.append(dict(g, url="/doc/" + g["file"], size=size))
    return out


def guide_file(name: str):
    """Absolute path of a listed guide, None for anything else."""
    for g in _cached(GUIDES, _parse_guides) or []:
        if g["file"] == name:
            path = os.path.join(DOC_DIR, name)
            return path if os.path.isfile(path) else None
    return None


def guide_links() -> dict:
    """{page key: URL of its guide (with #page=N)} for the ? buttons of the pages."""
    links = {}
    for g in guides():
        for key, page in g["open"].items():
            links.setdefault(key, g["url"] + (f"#page={page}" if page else ""))
    return links
