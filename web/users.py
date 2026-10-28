"""
web/users.py — web page users (from 2026-10-23).

Who may open the web pages:
  * the built-in user of config.py (WEB_USER / WEB_PASS) — fixed, not editable
    from the pages; off when WEB_PASS is empty, and on a server behind a public
    reverse proxy (WEB_BEHIND_PROXY) also when WEB_PASS is a default one
    (cfg_login_allowed, from 2026-10-27);
  * the maintenance user of MAINTENANCE_AUTH_FILE (the dbadmin login) — also
    the only user of the Maintenance page; its password can be changed on the
    Maintenance page (it is then stored hashed);
  * the users of the users file, managed on the Maintenance page (add, new
    password, remove) — web pages only.

Users file: WEB_USERS_FILE, or webusers.txt next to MAINTENANCE_AUTH_FILE
when not set.  One user per line:
    username:changed (Unix s):pbkdf2_sha256$iterations$salt$hash
'#' lines are comments.  Passwords are never stored or shown in clear.  The
file is re-read when it changes (checked at most every 2 s), so changes take
effect at the next request without a restart; it is written only when a user
is added, changed or removed (atomic replace, mode 600).

The maintenance file keeps its format  username:password ; the password may
be in clear (as before) or a pbkdf2_sha256$… hash.

First and last names of the users (from 2026-10-28) are kept encrypted in
webnames.txt next to the users file, with a key from the maintenance password
(web/user_names.py): shown only on the Maintenance page.

Basic authentication sends the password with every request, so a checked
username / password pair is remembered in memory (as a salted digest, for the
current file contents) and the slow hash is computed only once per pair.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import re
import threading
import time
from typing import Optional

from web import user_names

log = logging.getLogger("modes.web")

HASH_PREFIX = "pbkdf2_sha256$"
ITERATIONS = 150_000
USER_RE = re.compile(r"^[A-Za-z0-9._@-]{1,32}$")
PASS_MIN, PASS_MAX = 8, 128
RECHECK_SEC = 2.0

_lock = threading.Lock()
_state = {"key": None, "checked": 0.0, "users": {}, "maint": None}
_ok_cache: dict = {}          # (user, digest of password) → True, for the current file contents
_SALT = os.urandom(16)        # for the in-memory digests only


# ── Password hashes ─────────────────────────────────────────────────────────

def hash_password(password: str, iterations: int = ITERATIONS) -> str:
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    return f"{HASH_PREFIX}{iterations}${salt.hex()}${dk.hex()}"


def check_hash(password: str, stored: str) -> bool:
    try:
        _, it, salt, dk = stored.split("$")
        calc = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(it))
        return hmac.compare_digest(calc.hex(), dk)
    except (ValueError, TypeError):
        return False


def _check_stored(password: str, stored: str) -> bool:
    """Stored value: a pbkdf2 hash, or (maintenance file only) the password in clear."""
    if stored.startswith(HASH_PREFIX):
        return check_hash(password, stored)
    return hmac.compare_digest(password.encode(), stored.encode())


# ── Files ───────────────────────────────────────────────────────────────────

def users_path(cfg) -> Optional[str]:
    p = getattr(cfg, "WEB_USERS_FILE", "") or ""
    if p:
        return p
    m = getattr(cfg, "MAINTENANCE_AUTH_FILE", "") or ""
    return os.path.join(os.path.dirname(os.path.abspath(m)), "webusers.txt") if m else None


def _mtime(path: Optional[str]):
    try:
        st = os.stat(path) if path else None
        return (st.st_mtime_ns, st.st_size) if st else None
    except OSError:
        return None


def _read_users(path: Optional[str]) -> dict:
    out = {}
    if not path or not os.path.exists(path):
        return out
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split(":", 2)
                if len(parts) != 3 or not USER_RE.match(parts[0]) or not parts[2].startswith(HASH_PREFIX):
                    continue
                try:
                    changed = int(float(parts[1]))
                except ValueError:
                    changed = None
                out[parts[0]] = {"hash": parts[2], "changed": changed}
    except OSError as exc:
        log.warning("Users file not readable: %s", exc)
    return out


def _read_maint(path: str):
    """(username, stored password) of the maintenance file, or None."""
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            line = f.read().strip()
        u, p = line.split(":", 1)
        return u.strip(), p.strip()
    except (OSError, ValueError):
        return None


def _write_atomic(path: str, text: str) -> None:
    d = os.path.dirname(os.path.abspath(path))
    tmp = os.path.join(d, "." + os.path.basename(path) + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _load(cfg, force: bool = False) -> dict:
    """Current users and maintenance login (re-read when a file changed)."""
    now = time.monotonic()
    with _lock:
        if not force and now - _state["checked"] < RECHECK_SEC and _state["key"] is not None:
            return _state
        up, mp = users_path(cfg), getattr(cfg, "MAINTENANCE_AUTH_FILE", "") or ""
        key = (up, _mtime(up), mp, _mtime(mp))
        _state["checked"] = now
        if force or key != _state["key"]:
            _state["key"] = key
            _state["users"] = _read_users(up)
            _state["maint"] = _read_maint(mp)
            _ok_cache.clear()
        return _state


def _cached_check(user: str, password: str, stored: str) -> bool:
    k = (user, hashlib.sha256(_SALT + user.encode() + b"\0" + password.encode()).hexdigest())
    if k in _ok_cache:
        return True
    ok = _check_stored(password, stored)
    if ok:
        if len(_ok_cache) > 200:
            _ok_cache.clear()
        _ok_cache[k] = True
    return ok


# ── Checks ──────────────────────────────────────────────────────────────────

# Passwords that make the built-in config.py user unusable on a public server
TRIVIAL_PASSWORDS = ("admin123", "admin", "password")


def cfg_login_allowed(cfg) -> bool:
    """Whether the built-in user of config.py (WEB_USER / WEB_PASS) may log in
    (from 2026-10-27): never with an empty WEB_PASS, and not with a default /
    trivial one when the server runs behind a public reverse proxy
    (WEB_BEHIND_PROXY) — config.py is public in git, so its default login must
    not open a server on the internet.  The personal users and the
    maintenance user are not affected."""
    pw = str(getattr(cfg, "WEB_PASS", "") or "")
    if not pw:
        return False
    if getattr(cfg, "WEB_BEHIND_PROXY", False) and (
            pw in TRIVIAL_PASSWORDS or pw == str(getattr(cfg, "WEB_USER", ""))):
        return False
    return True


def check_web(cfg, username: str, password: str) -> bool:
    """Web pages: the config.py user, the maintenance user or a user of the users file."""
    username, password = username or "", password or ""
    cfg_ok = (cfg_login_allowed(cfg)
              & hmac.compare_digest(username.encode(), str(cfg.WEB_USER).encode())
              & hmac.compare_digest(password.encode(), str(cfg.WEB_PASS).encode()))
    if cfg_ok:
        return True
    st = _load(cfg)
    m = st["maint"]
    if m and hmac.compare_digest(username.encode(), m[0].encode()):
        return _cached_check(username, password, m[1])
    u = st["users"].get(username)
    return bool(u) and _cached_check(username, password, u["hash"])


def check_maint(cfg, username: str, password: str) -> bool:
    """Maintenance page: the maintenance user only."""
    m = _load(cfg)["maint"]
    if not m:
        return False
    username, password = (username or "").strip(), (password or "").strip()
    return hmac.compare_digest(username.encode(), m[0].encode()) and _cached_check(username, password, m[1])


# ── Management (Maintenance page) ───────────────────────────────────────────

def _valid_password(pw: str) -> Optional[str]:
    if not isinstance(pw, str) or not (PASS_MIN <= len(pw) <= PASS_MAX):
        return f"the password must have {PASS_MIN}–{PASS_MAX} characters"
    if any(c in pw for c in "\r\n\t") or pw != pw.strip():
        return "the password may not contain line breaks, tabs or spaces at its ends"
    return None


def names_file(cfg) -> Optional[str]:
    return user_names.names_path(users_path(cfg))


def list_users(cfg, maint_password: Optional[str] = None) -> dict:
    """The users for the Maintenance page; with the maintenance password also
    the users' names (decrypted for this answer only) and "names": state."""
    st = _load(cfg, force=True)
    up = users_path(cfg)
    nm = user_names.read_all(names_file(cfg), maint_password) if maint_password else {"state": "none", "names": {}}
    rows = [{"user": str(cfg.WEB_USER), "kind": "config", "changed": None}]
    if st["maint"]:
        mp = getattr(cfg, "MAINTENANCE_AUTH_FILE", "")
        try:
            mch = int(os.path.getmtime(mp))
        except OSError:
            mch = None
        rows.append({"user": st["maint"][0], "kind": "maintenance", "changed": mch,
                     "hashed": st["maint"][1].startswith(HASH_PREFIX)})
    for name in sorted(st["users"], key=str.lower):
        row = {"user": name, "kind": "user", "changed": st["users"][name]["changed"]}
        n = nm["names"].get(name)
        if n:
            row.update(first=n["first"], last=n["last"])
        rows.append(row)
    d = os.path.dirname(os.path.abspath(up)) if up else None
    return {"file": up, "writable": bool(d and os.access(d, os.W_OK)), "users": rows, "names": nm["state"]}


def _save_users(cfg, users: dict) -> None:
    up = users_path(cfg)
    if not up:
        raise ValueError("no users file: set MAINTENANCE_AUTH_FILE (or WEB_USERS_FILE) in config.py")
    lines = ["# MODE-S Wind web users — managed on the Maintenance page; passwords are hashed",
             "# username:changed:hash"]
    for name in sorted(users, key=str.lower):
        lines.append(f"{name}:{users[name]['changed'] or 0}:{users[name]['hash']}")
    _write_atomic(up, "\n".join(lines) + "\n")


def add_user(cfg, username: str, password: str, first: Optional[str] = None, last: Optional[str] = None,
             maint_password: Optional[str] = None) -> None:
    """A new user of the users file; with the maintenance password also its
    first and last name (both required then)."""
    username = (username or "").strip()
    if not USER_RE.match(username):
        raise ValueError("the username may have 1–32 letters, digits and . _ @ - (no spaces)")
    err = _valid_password(password)
    if err:
        raise ValueError(err)
    if maint_password is not None:
        first, last = user_names.clean(first, last)
        if user_names.read_all(names_file(cfg), maint_password)["state"] == "locked":
            raise ValueError("the stored names were written with another maintenance password — start the names again first")
    st = _load(cfg, force=True)
    taken = {str(cfg.WEB_USER).lower()} | ({st["maint"][0].lower()} if st["maint"] else set())
    if username.lower() in taken or username.lower() in {u.lower() for u in st["users"]}:
        raise ValueError(f"the user {username} already exists")
    users = dict(st["users"])
    users[username] = {"hash": hash_password(password), "changed": int(time.time())}
    _save_users(cfg, users)
    _load(cfg, force=True)
    log.info("Web user added: %s", username)
    if maint_password is not None:
        user_names.set_name(names_file(cfg), maint_password, username, first, last, _write_atomic)


def set_name(cfg, username: str, first: str, last: str, maint_password: str) -> None:
    """First and last name of a user of the users file (encrypted; never logged)."""
    st = _load(cfg, force=True)
    if username not in st["users"]:
        raise ValueError(f"no user {username}")
    try:
        user_names.set_name(names_file(cfg), maint_password, username, first, last, _write_atomic)
    except user_names.Locked:
        raise ValueError("the stored names were written with another maintenance password — start the names again first")
    log.info("Web user name changed: %s", username)


def reset_names(cfg) -> None:
    user_names.reset(names_file(cfg), _write_atomic)
    log.info("Web user names started again")


def set_password(cfg, username: str, password: str, old_maint_password: Optional[str] = None) -> str:
    """New password for a user of the users file or the maintenance user; returns its kind.
    A new maintenance password re-encrypts the users' names (old_maint_password)."""
    err = _valid_password(password)
    if err:
        raise ValueError(err)
    st = _load(cfg, force=True)
    if username == str(cfg.WEB_USER):
        raise ValueError("the built-in user is set in config.py (WEB_USER / WEB_PASS)")
    if st["maint"] and username == st["maint"][0]:
        mp = getattr(cfg, "MAINTENANCE_AUTH_FILE", "")
        nf = names_file(cfg)
        renamed = user_names.rekey(nf, old_maint_password, password) if old_maint_password else None
        _write_atomic(mp, f"{username}:{hash_password(password)}\n")
        if renamed is not None:
            _write_atomic(nf, renamed)
        _load(cfg, force=True)
        log.info("Maintenance password changed")
        return "maintenance"
    if username not in st["users"]:
        raise ValueError(f"no user {username}")
    users = dict(st["users"])
    users[username] = {"hash": hash_password(password), "changed": int(time.time())}
    _save_users(cfg, users)
    _load(cfg, force=True)
    log.info("Web user password changed: %s", username)
    return "user"


def remove_user(cfg, username: str) -> None:
    st = _load(cfg, force=True)
    if username == str(cfg.WEB_USER):
        raise ValueError("the built-in user is set in config.py and cannot be removed here")
    if st["maint"] and username == st["maint"][0]:
        raise ValueError("the maintenance user cannot be removed")
    if username not in st["users"]:
        raise ValueError(f"no user {username}")
    users = {k: v for k, v in st["users"].items() if k != username}
    _save_users(cfg, users)
    _load(cfg, force=True)
    user_names.remove(names_file(cfg), username, _write_atomic)
    log.info("Web user removed: %s", username)
