"""
beast_sig.py — the signal-level byte of the Beast frames for the Statistics
page (from 2026-10-25).

pyModeS's NetworkSource parses the Radarcape Beast feed
(<0x1a> <type> <MLAT 6 bytes> <signal 1 byte> <payload>) but yields only
(hex, timestamp): the signal byte is dropped.  To read it without changing
the decoding path, ``install()`` wraps pyModeS's buffer parser: the original
parser still produces the frames (exactly as before), and a second, light
scan of the same buffer collects (hex, signal) for the same frames.  If the
two do not agree frame for frame, the burst is skipped (no signal values) —
the decoding never depends on this module.

The collector then calls ``pop(msg_hex)`` once per frame it receives: the
frames of one receive burst are yielded in order after that burst has been
parsed, so the queue is in step with them; each popped entry is checked
against the frame's hex and the queue is cleared on any mismatch.

The signal byte is the receiver's peak amplitude of the reply, 0–255
(dump1090 / readsb treat it as linear amplitude: dBFS = 20·log10(byte / 255)).
It is not calibrated in dBm, but it is consistent for one receiver, which is
what the histogram needs.

Cost: one bytes.find() scan per receive burst and one tuple per frame
(about half of pyModeS's own parsing: 1.5 µs per frame on a desktop CPU, a few µs on a Raspberry Pi 4).  Off with
MSG_STATS_SIGNAL = False in config.py.
"""

from __future__ import annotations

import logging
from collections import deque

from collector import traffic

log = logging.getLogger(__name__)

_Q: deque = deque(maxlen=4096)
_STATE = {"installed": False, "reason": "not installed", "bursts": 0, "skipped": 0, "signal": True,
          "misaligned": 0}

_LEN = {0x32: 14, 0x33: 21}        # MLAT(6) + SIG(1) + payload (7 / 14)
_LEN_AC = 9                        # Mode A/C: MLAT(6) + SIG(1) + 2


def _walk(buf: bytes, start: int, n: int):
    """Un-escape n body bytes from buf[start]: (body, next) / (None, -1) when
    incomplete / (None, j) when an unescaped marker interrupts the body."""
    end = start + n
    chunk = buf[start:end]
    if len(chunk) == n and 0x1A not in chunk:
        return chunk, end                      # fast path: nothing escaped
    body = bytearray()
    j, L = start, len(buf)
    while j < L and len(body) < n:
        b = buf[j]
        if b == 0x1A:
            if j + 1 >= L:
                return None, -1
            if buf[j + 1] == 0x1A:
                body.append(0x1A)
                j += 2
                continue
            return None, j
        body.append(b)
        j += 1
    if len(body) < n:
        return None, -1
    return bytes(body), j


def scan(buf: bytes) -> list:
    """(hex, signal byte) of the complete Mode S frames in a Beast buffer."""
    out = []
    i, L = 0, len(buf)
    while True:
        i = buf.find(b"\x1a", i)
        if i < 0 or i + 1 >= L:
            break
        t = buf[i + 1]
        n = _LEN.get(t)
        if n is None:
            if t == 0x31:
                body, j = _walk(buf, i + 2, _LEN_AC)
                if j == -1:
                    break
                i = j
            elif t == 0x34:                     # status frame: to the next unescaped marker
                j = i + 2
                while True:
                    j = buf.find(b"\x1a", j)
                    if j < 0:
                        return out
                    if j + 1 < L and buf[j + 1] == 0x1A:
                        j += 2
                        continue
                    break
                i = j
            else:
                i += 1 if t == 0x1A else 2
            continue
        body, j = _walk(buf, i + 2, n)
        if j == -1:
            break
        if body is None:
            i = j
            continue
        out.append((body[7:].hex().upper(), body[6]))
        i = j
    return out


def install(signal: bool = True) -> bool:
    """Wrap pyModeS's Beast parser.  False (and the reason in state()) when
    this pyModeS version has no such parser.  The wrapper also counts the
    bytes of the Beast stream for the data transfer counters (from
    2026-10-27, collector/traffic.py) — every byte the parser consumed, once;
    with signal=False (MSG_STATS_SIGNAL = False) it only counts."""
    _STATE["signal"] = bool(signal)
    if _STATE["installed"]:
        return True
    try:
        from pyModeS.cli import _source as src
        orig = getattr(src, "_parse_beast_buffer")
    except Exception as exc:                    # noqa: BLE001
        _STATE["reason"] = f"pyModeS Beast parser not found ({exc.__class__.__name__})"
        log.info("Signal levels not available: %s", _STATE["reason"])
        return False
    if getattr(orig, "_modes_wind_sig", False):
        _STATE["installed"] = True
        return True

    def wrapped(buf):
        frames, remainder = orig(buf)
        try:
            traffic.add("beast", len(buf) - len(remainder))
        except Exception:                       # noqa: BLE001
            pass
        if frames and _STATE["signal"]:
            _STATE["bursts"] += 1
            try:
                sig = scan(buf)
            except Exception:                   # noqa: BLE001
                sig = None
            if sig is not None and len(sig) == len(frames) and all(
                    s[0] == f[1] for s, f in zip(sig, frames)):
                _Q.extend(sig)
            else:
                _STATE["skipped"] += 1
                _Q.extend((f[1], None) for f in frames)
        return frames, remainder

    wrapped._modes_wind_sig = True               # type: ignore[attr-defined]
    src._parse_beast_buffer = wrapped
    _STATE["installed"] = True
    _STATE["reason"] = ""
    log.info("Beast %s enabled for the Statistics page",
             "signal levels and byte counts" if signal else "byte counts")
    return True


def reset() -> None:
    """New connection: forget queued values."""
    _Q.clear()


def pop(msg_hex: str):
    """Signal byte (0–255) of the frame just received, or None."""
    if not _Q:
        return None
    h, s = _Q.popleft()
    if h != msg_hex:
        _STATE["misaligned"] += 1
        _Q.clear()
        return None
    return s


def state() -> dict:
    return dict(_STATE)
