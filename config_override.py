"""
config_override.py — per-machine settings from config_local.py (from 2026-10-27).

config.py is kept in git and is the same on every machine.  The settings in
which one machine differs from the others (the AWS cloud server reads the
Radarcape through a tunnel on 127.0.0.1 and serves the pages through nginx,
the home station reads the receiver on the local network) go into an optional
file config_local.py next to config.py.  It is listed in .gitignore, so it is
never committed and `git pull` never touches it.

Every UPPERCASE name in config_local.py replaces the setting of the same name
in Config, or adds it when config.py does not have it (the optional settings
read with getattr, such as RADARCAPE_STATUS_URL or WEB_BEHIND_PROXY).  Without
the file nothing changes.  A mistake in the file (a syntax error) stops the
start-up with the error, instead of running quietly with the wrong settings.

Applied once, by run.py right after `from config import Config` — before any
other module reads the settings (none copies them at import time).
See config_local.py.example.
"""

from __future__ import annotations

import importlib.util
import os

LOCAL_FILE = "config_local.py"

_applied: list | None = None


def apply(cls, root: str | None = None) -> list:
    """Copy the UPPERCASE names of config_local.py onto the class cls.
    Returns the names that were set (an empty list without the file).
    Only the first call reads the file; later calls return the same names."""
    global _applied
    if _applied is not None:
        return _applied
    root = root or os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(root, LOCAL_FILE)
    names: list = []
    if os.path.isfile(path):
        spec = importlib.util.spec_from_file_location("config_local", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        for k, v in vars(mod).items():
            if k.isupper() and not k.startswith("_"):
                setattr(cls, k, v)
                names.append(k)
    _applied = sorted(names)
    return _applied
