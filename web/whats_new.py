"""
whats_new.py — version number and the "What's new" notes of the web pages
(from 2026-10-22).

Version: one per day of development, v.DDMMYYYY, taken from the newest date
heading of CHANGELOG.md ("## v.22102026 — 2026-10-22 (…)" or the older form
"## 2026-10-22 (…)"), so it changes by itself with the changelog.

Notes: doc/whats_new.md, short user-oriented notes per version:

    ## v.22102026 — title
    - bullet (**bold**, *italic*, `code`)
      - sub-bullet
    plain paragraph

Both files are read again only when they change (mtime).
"""

from __future__ import annotations

import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHANGELOG = os.path.join(ROOT, "CHANGELOG.md")
NOTES = os.path.join(ROOT, "doc", "whats_new.md")
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


_VER = re.compile(r"^##\s+v\.(\d{2})(\d{2})(\d{4})\b", re.M)
_DATE = re.compile(r"^##\s+(?:v\.\d{8}\s+[—-]\s+)?(\d{4})-(\d{2})-(\d{2})\b", re.M)


def _parse_version(text: str):
    m = _VER.search(text)
    if m:
        return f"v.{m.group(1)}{m.group(2)}{m.group(3)}"
    m = _DATE.search(text)
    if m:
        return f"v.{m.group(3)}{m.group(2)}{m.group(1)}"
    return None


def version() -> str:
    """v.DDMMYYYY of the newest CHANGELOG entry ('' when not found)."""
    return _cached(CHANGELOG, _parse_version) or ""


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
