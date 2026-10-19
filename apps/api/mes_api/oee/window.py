"""Rapor zaman penceresi: açık from/to veya hazır seçenekler (fabrika yerel saatine göre)."""

from __future__ import annotations

from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

from fastapi import HTTPException, status

from mes_api.oee.calendar import ShiftDef, shift_instances, to_local

PRESETS = ("current_shift", "today", "yesterday", "last_24h", "last_7_days", "this_week", "this_month")
MAX_WINDOW = timedelta(days=400)


def utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None, microsecond=0)


def parse_ts(value: str) -> datetime:
    """ISO-8601; ofset/Z yoksa UTC kabul edilir. Naive UTC döner."""
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f'"{value}" geçerli bir ISO-8601 zaman damgası değil')
    return dt.astimezone(UTC).replace(tzinfo=None) if dt.tzinfo else dt


def _local_midnight_utc(d, tz: ZoneInfo) -> datetime:
    return datetime.combine(d, time(0), tzinfo=tz).astimezone(UTC).replace(tzinfo=None)


def resolve_window(
    preset: str | None, start: str | None, end: str | None, tz: ZoneInfo, shifts: list[ShiftDef], now: datetime | None = None,
) -> tuple[datetime, datetime, str]:
    now = now or utcnow()
    if preset:
        today = to_local(now, tz).date()
        if preset == "current_shift":
            current = [i for i in shift_instances(shifts, now - timedelta(days=1), now + timedelta(seconds=1), tz) if i.start <= now < i.end]
            if not current:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Şu anda aktif bir vardiya yok")
            return current[-1].start, current[-1].end, current[-1].label
        if preset == "today":
            return _local_midnight_utc(today, tz), _local_midnight_utc(today + timedelta(days=1), tz), today.isoformat()
        if preset == "yesterday":
            y = today - timedelta(days=1)
            return _local_midnight_utc(y, tz), _local_midnight_utc(today, tz), y.isoformat()
        if preset == "last_24h":
            return now - timedelta(hours=24), now, "son 24 saat"
        if preset == "last_7_days":
            return _local_midnight_utc(today - timedelta(days=6), tz), _local_midnight_utc(today + timedelta(days=1), tz), "son 7 gün"
        if preset == "this_week":
            monday = today - timedelta(days=today.weekday())
            return _local_midnight_utc(monday, tz), _local_midnight_utc(monday + timedelta(days=7), tz), f"{monday.isocalendar().week}. hafta"
        if preset == "this_month":
            first = today.replace(day=1)
            nxt = (first + timedelta(days=32)).replace(day=1)
            return _local_midnight_utc(first, tz), _local_midnight_utc(nxt, tz), first.strftime("%Y-%m")
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"preset şunlardan biri olmalı: {', '.join(PRESETS)}")

    if not start or not end:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "from ve to, ya da preset verilmeli")
    s, e = parse_ts(start), parse_ts(end)
    if e <= s:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "to, from'dan sonra olmalı")
    if e - s > MAX_WINDOW:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "en fazla 400 günlük aralık sorgulanabilir")
    return s, e, "özel aralık"


def iso(dt: datetime | None) -> str | None:
    return None if dt is None else dt.replace(tzinfo=UTC).isoformat().replace("+00:00", "Z")
