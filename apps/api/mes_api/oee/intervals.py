"""Zaman aralığı kümesi işlemleri. Tüm aralıklar yarı açık [başlangıç, bitiş) ve naive UTC datetime'dır."""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime

Interval = tuple[datetime, datetime]


def normalize(items: Iterable[Interval]) -> list[Interval]:
    """Boş aralıkları atar, sıralar ve örtüşen/bitişik aralıkları birleştirir."""
    result: list[Interval] = []
    for start, end in sorted((s, e) for s, e in items if e > s):
        if result and start <= result[-1][1]:
            if end > result[-1][1]:
                result[-1] = (result[-1][0], end)
        else:
            result.append((start, end))
    return result


def union(*sets: Iterable[Interval]) -> list[Interval]:
    return normalize(i for s in sets for i in s)


def intersect(a: Iterable[Interval], b: Iterable[Interval]) -> list[Interval]:
    a, b = normalize(a), normalize(b)
    result: list[Interval] = []
    i = j = 0
    while i < len(a) and j < len(b):
        start = max(a[i][0], b[j][0])
        end = min(a[i][1], b[j][1])
        if end > start:
            result.append((start, end))
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return result


def subtract(a: Iterable[Interval], b: Iterable[Interval]) -> list[Interval]:
    b = normalize(b)
    result: list[Interval] = []
    for start, end in normalize(a):
        cursor = start
        for bs, be in b:
            if be <= cursor or bs >= end:
                continue
            if bs > cursor:
                result.append((cursor, bs))
            cursor = max(cursor, be)
            if cursor >= end:
                break
        if cursor < end:
            result.append((cursor, end))
    return result


def total_seconds(items: Iterable[Interval]) -> float:
    return sum((e - s).total_seconds() for s, e in normalize(items))


def contains(items: list[Interval], t: datetime) -> bool:
    """``items`` normalize edilmiş olmalı."""
    lo, hi = 0, len(items)
    while lo < hi:
        mid = (lo + hi) // 2
        s, e = items[mid]
        if t < s:
            hi = mid
        elif t >= e:
            lo = mid + 1
        else:
            return True
    return False
