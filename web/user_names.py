"""
web/user_names.py — first and last names of the web users (from 2026-10-28).

The names are shown only on the Maintenance page.  They are kept encrypted in
their own file, webnames.txt next to the users file (mode 600, outside git and
the database), with a key derived from the maintenance password: the server
itself cannot read them — they are decrypted only for a request that carries
the maintenance login, and re-encrypted when the maintenance password is
changed on the Maintenance page.  If the maintenance password is replaced by
hand (by editing the maintenance login file), the stored names can no longer
be read; the page then offers to start the names again.

File format (one entry per line, '#' lines are comments):
    !names:v1:<salt hex>:<check hex>
    username:<nonce hex>:<ciphertext hex>:<tag hex>

Key: PBKDF2-HMAC-SHA256(maintenance password, salt, ITERATIONS) → master key;
from it (HMAC-SHA256 with fixed labels) an encryption key, a MAC key and the
check value that tells whether a password opens the file.  Each name is
encrypted with a fresh 16-byte nonce: keystream = HMAC-SHA256(enc key, nonce ||
counter) blocks (a PRF in counter mode), then the tag = HMAC-SHA256(MAC key,
username || nonce || ciphertext) (encrypt-then-MAC), so a name can be neither
read nor altered or moved to another user without the key.  Only the Python
standard library is used (no extra package on the Raspberry Pi).

The derived key of a password is kept in RAM for KEY_TTL_SEC (keyed by a
salted digest, never the password), so the slow derivation runs once per
maintenance session rather than once per request.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import threading
import time
from typing import Optional

log = logging.getLogger("modes.web")

ITERATIONS = 200_000
KEY_TTL_SEC = 600.0
NAME_MAX = 40
NAME_RE = re.compile(r"^[^\x00-\x1f\x7f]{1,%d}$" % NAME_MAX)
_HDR = "!names"
_VER = "v1"

_lock = threading.Lock()
_keys: dict = {}              # (salt hex, digest of password) → (master key, time)
_RAM_SALT = os.urandom(16)


class Locked(Exception):
    """The names file was written with another maintenance password."""


# ── Crypto (standard library only) ──────────────────────────────────────────

def _sub(master: bytes, label: str) -> bytes:
    return hmac.new(master, label.encode(), hashlib.sha256).digest()


def _master(password: str, salt: bytes) -> bytes:
    k = (salt.hex(), hmac.new(_RAM_SALT, password.encode(), hashlib.sha256).hexdigest())
    now = time.time()
    with _lock:
        for kk in [kk for kk, (_, t) in _keys.items() if now - t > KEY_TTL_SEC]:
            del _keys[kk]
        hit = _keys.get(k)
        if hit:
            return hit[0]
    m = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ITERATIONS)
    with _lock:
        _keys[k] = (m, now)
    return m


def _stream(key: bytes, nonce: bytes, n: int) -> bytes:
    out = bytearray()
    ctr = 0
    while len(out) < n:
        out += hmac.new(key, nonce + ctr.to_bytes(8, "big"), hashlib.sha256).digest()
        ctr += 1
    return bytes(out[:n])


def _encrypt(master: bytes, user: str, text: str) -> str:
    nonce = os.urandom(16)
    pt = text.encode("utf-8")
    ct = bytes(a ^ b for a, b in zip(pt, _stream(_sub(master, "names-enc"), nonce, len(pt))))
    tag = hmac.new(_sub(master, "names-mac"), user.encode() + b"\x00" + nonce + ct, hashlib.sha256).hexdigest()
    return f"{nonce.hex()}:{ct.hex()}:{tag}"


def _decrypt(master: bytes, user: str, blob: str) -> Optional[str]:
    try:
        nh, ch, tag = blob.split(":")
        nonce, ct = bytes.fromhex(nh), bytes.fromhex(ch)
    except ValueError:
        return None
    calc = hmac.new(_sub(master, "names-mac"), user.encode() + b"\x00" + nonce + ct, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(calc, tag):
        return None
    pt = bytes(a ^ b for a, b in zip(ct, _stream(_sub(master, "names-enc"), nonce, len(ct))))
    try:
        return pt.decode("utf-8")
    except UnicodeDecodeError:
        return None


def _check(master: bytes) -> str:
    return _sub(master, "names-check").hex()


# ── File ────────────────────────────────────────────────────────────────────

def names_path(users_file: Optional[str]) -> Optional[str]:
    if not users_file:
        return None
    return os.path.join(os.path.dirname(os.path.abspath(users_file)), "webnames.txt")


def _read(path: Optional[str]) -> tuple:
    """(header (salt bytes, check hex) or None, {username: blob})."""
    hdr, rows = None, {}
    if not path or not os.path.exists(path):
        return hdr, rows
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith(_HDR + ":"):
                    p = line.split(":")
                    if len(p) == 4 and p[1] == _VER:
                        try:
                            hdr = (bytes.fromhex(p[2]), p[3])
                        except ValueError:
                            hdr = None
                    continue
                user, _, blob = line.partition(":")
                if user and blob:
                    rows[user] = blob
    except OSError as exc:
        log.warning("Names file not readable: %s", exc)
    return hdr, rows


def _write(path: str, salt: bytes, master: bytes, rows: dict, write_atomic) -> None:
    lines = ["# MODE-S Wind web users' names — encrypted with a key from the maintenance password; managed on the Maintenance page",
             f"{_HDR}:{_VER}:{salt.hex()}:{_check(master)}"]
    for user in sorted(rows, key=str.lower):
        lines.append(f"{user}:{rows[user]}")
    write_atomic(path, "\n".join(lines) + "\n")


def _open(path: Optional[str], password: str):
    """(salt, master, rows) for this password; Locked when the file belongs to another password."""
    hdr, rows = _read(path)
    if hdr is None:
        if rows:
            raise Locked()
        return None, None, {}
    salt, check = hdr
    master = _master(password, salt)
    if not hmac.compare_digest(_check(master), check):
        raise Locked()
    return salt, master, rows


# ── API used by web/users.py and web/app.py ─────────────────────────────────

def clean(first: str, last: str) -> tuple:
    first, last = " ".join(str(first or "").split()), " ".join(str(last or "").split())
    if not first or not last:
        raise ValueError("enter the first and the last name")
    if not NAME_RE.match(first) or not NAME_RE.match(last):
        raise ValueError(f"the first and the last name may have at most {NAME_MAX} characters each")
    return first, last


def read_all(path: Optional[str], password: str) -> dict:
    """{"state": "none" | "ok" | "locked", "names": {user: {"first", "last"}}}."""
    try:
        salt, master, rows = _open(path, password)
    except Locked:
        return {"state": "locked", "names": {}}
    if master is None:
        return {"state": "none", "names": {}}
    out = {}
    for user, blob in rows.items():
        txt = _decrypt(master, user, blob)
        if txt is None:
            continue
        try:
            d = json.loads(txt)
            out[user] = {"first": str(d.get("f", "")), "last": str(d.get("l", ""))}
        except (ValueError, AttributeError):
            continue
    return {"state": "ok", "names": out}


def set_name(path: str, password: str, user: str, first: str, last: str, write_atomic) -> None:
    first, last = clean(first, last)
    salt, master, rows = _open(path, password)         # Locked propagates
    if master is None:
        salt = os.urandom(16)
        master = _master(password, salt)
    rows = dict(rows)
    rows[user] = _encrypt(master, user, json.dumps({"f": first, "l": last}, ensure_ascii=False))
    _write(path, salt, master, rows, write_atomic)


def remove(path: Optional[str], user: str, write_atomic) -> None:
    """Drop a user's entry (no key needed: the line is removed as it is)."""
    if not path or not os.path.exists(path):
        return
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError:
        return
    keep = [ln for ln in lines if not (ln.strip() and not ln.startswith(("#", _HDR + ":")) and ln.partition(":")[0] == user)]
    if len(keep) != len(lines):
        write_atomic(path, "\n".join(keep) + "\n")


def rekey(path: Optional[str], old_password: str, new_password: str) -> Optional[str]:
    """The names file text re-encrypted for a new maintenance password (None when
    there are no names, or when they cannot be read with the old password)."""
    try:
        salt, master, rows = _open(path, old_password)
    except Locked:
        return None
    if master is None:
        return None
    plain = {u: _decrypt(master, u, b) for u, b in rows.items()}
    nsalt = os.urandom(16)
    nmaster = _master(new_password, nsalt)
    lines = ["# MODE-S Wind web users' names — encrypted with a key from the maintenance password; managed on the Maintenance page",
             f"{_HDR}:{_VER}:{nsalt.hex()}:{_check(nmaster)}"]
    for u in sorted(plain, key=str.lower):
        if plain[u] is not None:
            lines.append(f"{u}:{_encrypt(nmaster, u, plain[u])}")
    return "\n".join(lines) + "\n"


def reset(path: Optional[str], write_atomic) -> None:
    """Start the names again (the old ones cannot be read with the current password)."""
    if path and os.path.exists(path):
        write_atomic(path, "# MODE-S Wind web users' names — started again\n")
