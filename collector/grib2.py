"""
collector/grib2.py — a small GRIB2 reader for the GFS cut-outs (from 2026-11-05).

Plain Python (no eccodes / numpy), only what NOAA's GRIB filter
(nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl) delivers for a lat / lon
box of the 0.25° GFS: grid template 3.0 (regular latitude / longitude),
product templates 4.0 (instantaneous) and 4.8 (accumulated / averaged over
an interval) and data template 5.0 (simple packing — the filter repacks the
cut-out this way; checked on 5 Nov 2026), with or without a bitmap.  Anything
else raises Grib2Error, so a change at NOAA is reported, not misread.

records(data, want) → [Record], one per GRIB message; the values of a
message are unpacked only when want(record) is true (the others cost only
their header).  Values are floats in the GRIB units (Pa, K, m/s, kg/m², %,
gpm), row by row in the scanning order of the grid; None where the bitmap
says missing.
"""

from __future__ import annotations

import struct


class Grib2Error(Exception):
    """A message this reader does not understand."""


def _u(b, o, n):
    return int.from_bytes(b[o:o + n], "big")


def _sm(b, o, n):
    """Sign-and-magnitude integer (GRIB's signed numbers)."""
    v = int.from_bytes(b[o:o + n], "big")
    m = 1 << (8 * n - 1)
    return -(v & (m - 1)) if v & m else v


class Record:
    __slots__ = ("discipline", "category", "number", "pdt", "level_type", "level", "ft", "ft_unit",
                 "stat_hours", "ni", "nj", "la1", "lo1", "la2", "lo2", "di", "dj", "scan",
                 "n", "_pack", "_bitmap", "_data", "values")

    def __init__(self):
        self.values = None
        self.stat_hours = None
        self._bitmap = None

    @property
    def key(self):
        """(discipline, category, number, level type, level value)"""
        return (self.discipline, self.category, self.number, self.level_type, self.level)

    def __repr__(self):
        return (f"<GRIB2 {self.discipline}.{self.category}.{self.number} lev {self.level_type}/{self.level} "
                f"pdt {self.pdt} ft {self.ft}{'' if self.stat_hours is None else ' +' + str(self.stat_hours) + ' h'} "
                f"{self.ni}x{self.nj}>")


def _unpack(rec: Record) -> list:
    """Simple packing: Y = (R + X · 2^E) / 10^D, X = nbits-wide unsigned integers."""
    R, E, D, nb = rec._pack
    data = rec._data
    f2, f10 = 2.0 ** E, 10.0 ** (-D)
    npk = rec.n if rec._bitmap is None else sum(rec._bitmap)
    if nb == 0:
        packed = [R * f10] * npk
    else:
        packed = []
        ap = packed.append
        mask = (1 << nb) - 1
        full = npk // 8                       # 8 values = exactly nb bytes
        for g in range(full):
            v = int.from_bytes(data[g * nb:(g + 1) * nb], "big")
            for s in range(7, -1, -1):
                ap((R + ((v >> (s * nb)) & mask) * f2) * f10)
        rest = npk - full * 8
        if rest:
            tail = data[full * nb:full * nb + (rest * nb + 7) // 8]
            v = int.from_bytes(tail, "big")
            bits = len(tail) * 8
            for i in range(rest):
                ap((R + ((v >> (bits - (i + 1) * nb)) & mask) * f2) * f10)
    if rec._bitmap is None:
        return packed
    out, it = [], iter(packed)
    for b in rec._bitmap:
        out.append(next(it) if b else None)
    return out


def _bitmap(b, o, n):
    bits = []
    for byte in b[o:o + (n + 7) // 8]:
        for s in range(7, -1, -1):
            bits.append((byte >> s) & 1)
    return bits[:n]


def records(data: bytes, want=lambda r: True) -> list:
    out = []
    o = 0
    L = len(data)
    while o + 16 <= L:
        if data[o:o + 4] != b"GRIB":
            raise Grib2Error(f"no GRIB message at byte {o}")
        if data[o + 7] != 2:
            raise Grib2Error("not GRIB edition 2")
        disc = data[o + 6]
        end = o + _u(data, o + 8, 8)
        p = o + 16
        rec = Record()
        rec.discipline = disc
        while p < end - 4:
            sl = _u(data, p, 4)
            sn = data[p + 4]
            if sn == 3:
                tmpl = _u(data, p + 12, 2)
                if tmpl != 0:
                    raise Grib2Error(f"grid template 3.{tmpl}")
                t = p + 14
                rec.ni, rec.nj = _u(data, t + 16, 4), _u(data, t + 20, 4)
                rec.la1, rec.lo1 = _sm(data, t + 32, 4) / 1e6, _u(data, t + 36, 4) / 1e6
                rec.la2, rec.lo2 = _sm(data, t + 41, 4) / 1e6, _u(data, t + 45, 4) / 1e6
                rec.di, rec.dj = _u(data, t + 49, 4) / 1e6, _u(data, t + 53, 4) / 1e6
                rec.scan = data[t + 57]
            elif sn == 4:
                rec.pdt = _u(data, p + 7, 2)
                if rec.pdt not in (0, 8):
                    raise Grib2Error(f"product template 4.{rec.pdt}")
                t = p + 9
                rec.category, rec.number = data[t], data[t + 1]
                rec.ft_unit, rec.ft = data[t + 8], _u(data, t + 9, 4)
                rec.level_type = data[t + 13]
                sc, sv = data[t + 14], _sm(data, t + 15, 4)
                rec.level = sv / (10 ** sc) if sc not in (0, 255) else sv
                if rec.pdt == 8:
                    # octets 47–53 of the section (the first time range): statistical
                    # process, type of increment, unit of time, length of the range
                    unit, length = data[p + 48], _u(data, p + 49, 4)
                    rec.stat_hours = length if unit == 1 else None
            elif sn == 5:
                rec.n = _u(data, p + 5, 4)
                tmpl = _u(data, p + 9, 2)
                if tmpl != 0:
                    raise Grib2Error(f"data template 5.{tmpl} (only simple packing is read)")
                R = struct.unpack(">f", data[p + 11:p + 15])[0]
                rec._pack = (R, _sm(data, p + 15, 2), _sm(data, p + 17, 2), data[p + 19])
            elif sn == 6:
                ind = data[p + 5]
                if ind == 0:
                    rec._bitmap = _bitmap(data, p + 6, rec.ni * rec.nj)
                elif ind != 255:
                    raise Grib2Error(f"bitmap indicator {ind}")
            elif sn == 7:
                rec._data = data[p + 5:p + sl]
            p += sl
        if want(rec):
            rec.values = _unpack(rec)
        rec._data = None
        out.append(rec)
        o = end
    return out
