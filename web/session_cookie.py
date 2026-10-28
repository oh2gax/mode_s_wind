"""
web/session_cookie.py — the remembered login (from 2026-10-28).

The pages use HTTP Basic authentication.  A browser keeps Basic credentials
only in memory, so a phone that closes the browser in the background (Chrome
on Android after the screen has been off) asks for the login again.  After a
successful login the server therefore also sets a signed cookie that lets the
same browser in for REMEMBER_DAYS (renewed while the site is used); the login
dialog is unchanged and still used whenever there is no valid cookie.

Cookie  msw_login = <user, base64url>.<expiry, Unix s>.<HMAC-SHA256>
The HMAC covers the user, the expiry and a digest of the user's stored
password hash, with a random key of this server (websession.key next to the
users file, mode 600, created on first use).  So the cookie
  * holds no password and cannot be made or altered without the key,
  * stops working when the user's password is changed or the user removed,
  * is valid only on the server that issued it (each server has its own key);
deleting websession.key ends every remembered login at once.
Only the users of the users file get one — not the maintenance user (dbadmin)
nor the built-in config.py user.  The cookie is HttpOnly, SameSite=Lax and,
over HTTPS, Secure; the Maintenance page's actions still need the
maintenance password.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
import secrets
import threading
import time
from typing import Optional

from web import users as web_users

log = logging.getLogger("modes.web")

COOKIE = "msw_login"
REMEMBER_DAYS = 30
MAX_AGE = REMEMBER_DAYS * 86400
RENEW_AFTER = 86400            # a cookie older than a day is renewed (sliding 30 days)
KEY_FILE = "websession.key"

_lock = threading.Lock()
_key = {"path": None, "key": None, "warned": False}


def _key_path(cfg) -> Optional[str]:
    up = web_users.users_path(cfg)
    return os.path.join(os.path.dirname(os.path.abspath(up)), KEY_FILE) if up else None


def _secret(cfg) -> Optional[bytes]:
    """This server's key (created once, mode 600); None when it cannot be kept."""
    path = _key_path(cfg)
    if not path:
        return None
    with _lock:
        if _key["path"] == path and _key["key"]:
            return _key["key"]
        key = None
        try:
            with open(path, encoding="ascii") as f:
                key = bytes.fromhex(f.read().strip())
        except FileNotFoundError:
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "w", encoding="ascii") as f:
                    f.write(secrets.token_hex(32) + "\n")
                log.info("Remembered login: new key file created")
                with open(path, encoding="ascii") as f:
                    key = bytes.fromhex(f.read().strip())
            except FileExistsError:                       # made by another thread just now
                with open(path, encoding="ascii") as f:
                    key = bytes.fromhex(f.read().strip())
            except OSError as exc:
                if not _key["warned"]:
                    log.warning("Remembered login off: key file not writable (%s)", exc)
                    _key["warned"] = True
        except (OSError, ValueError) as exc:
            if not _key["warned"]:
                log.warning("Remembered login off: key file not readable (%s)", exc)
                _key["warned"] = True
        if key is not None and len(key) < 16:
            key = None
        _key.update(path=path, key=key)
        return key


def _b64(s: str) -> str:
    return base64.urlsafe_b64encode(s.encode()).decode().rstrip("=")


def _unb64(s: str) -> str:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4)).decode()


def _mac(key: bytes, user_b64: str, exp: int, fp: str) -> str:
    msg = f"{user_b64}.{exp}.".encode() + hashlib.sha256(fp.encode()).digest()
    return hmac.new(key, msg, hashlib.sha256).hexdigest()


def issue(cfg, user: str, now: Optional[float] = None) -> Optional[str]:
    """The cookie value for a user that has just logged in (None: not for this user)."""
    fp = web_users.login_fingerprint(cfg, user)
    key = _secret(cfg) if fp else None
    if not key:
        return None
    ub, exp = _b64(user), int(now or time.time()) + MAX_AGE
    return f"{ub}.{exp}.{_mac(key, ub, exp, fp)}"


def check(cfg, value: Optional[str], now: Optional[float] = None):
    """(user, expiry) of a valid cookie, None otherwise."""
    if not value or len(value) > 300:
        return None
    try:
        ub, exp_s, mac = value.split(".")
        exp, user = int(exp_s), _unb64(ub)
    except (ValueError, UnicodeDecodeError):
        return None
    now = now or time.time()
    if exp <= now or exp > now + MAX_AGE + 60:
        return None
    fp = web_users.login_fingerprint(cfg, user)
    key = _secret(cfg) if fp else None
    if not key or not hmac.compare_digest(mac, _mac(key, ub, exp, fp)):
        return None
    return user, exp


def needs_renewal(exp: int, now: Optional[float] = None) -> bool:
    return exp - (now or time.time()) < MAX_AGE - RENEW_AFTER
