"""Vardiya takvimi: yerel saatle tanımlı vardiyalardan UTC aralıkları üretir (yaz saati geçişlerine dayanıklı)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from mes_api.oee.intervals import Interval, normalize


@dataclass(frozen=True)
class PlannedStopDef:
    name: str
    start_local: time
    duration_minutes: int


@dataclass(frozen=True)
class ShiftDef:
    id: int
    name: str
    start_local: time
    end_local: time
    days_mask: int  # bit0 = Pazartesi … bit6 = Pazar (vardiyanın başladığı gün)
    planned_stops: tuple[PlannedStopDef, ...] = ()


@dataclass(frozen=True)
class ShiftInstance:
    shift_id: int
    name: str
    local_date: date          # vardiyanın başladığı yerel gün
    start: datetime           # UTC (naive)
    end: datetime             # UTC (naive)
    planned_stops: tuple[Interval, ...]

    @property
    def label(self) -> str:
        return f"{self.local_date.isoformat()} {self.name}"


def _to_utc(local_date: date, t: time, tz: ZoneInfo) -> datetime:
    # fold=0: yaz saatinden dönüşte tekrarlanan saatte ilk geçiş kullanılır
    return datetime.combine(local_date, t, tzinfo=tz).astimezone(UTC).replace(tzinfo=None)


def to_local(dt_utc: datetime, tz: ZoneInfo) -> datetime:
    return dt_utc.replace(tzinfo=UTC).astimezone(tz)


def shift_instances(shifts: list[ShiftDef], start: datetime, end: datetime, tz: ZoneInfo) -> list[ShiftInstance]:
    """[start, end) UTC aralığıyla kesişen tüm vardiya örnekleri (başlangıca göre sıralı)."""
    first = to_local(start, tz).date() - timedelta(days=1)
    last = to_local(end, tz).date()
    result: list[ShiftInstance] = []
    d = first
    while d <= last:
        for s in shifts:
            if not s.days_mask & (1 << d.weekday()):
                continue
            end_date = d if s.end_local > s.start_local else d + timedelta(days=1)
            s_start, s_end = _to_utc(d, s.start_local, tz), _to_utc(end_date, s.end_local, tz)
            if s_end <= start or s_start >= end:
                continue
            stops = []
            for p in s.planned_stops:
                p_date = d if p.start_local >= s.start_local else d + timedelta(days=1)
                p_start = _to_utc(p_date, p.start_local, tz)
                stops.append((p_start, p_start + timedelta(minutes=p.duration_minutes)))
            result.append(ShiftInstance(s.id, s.name, d, s_start, s_end, tuple(normalize(stops))))
        d += timedelta(days=1)
    return sorted(result, key=lambda i: (i.start, i.shift_id))


def planned_windows(instances: list[ShiftInstance]) -> tuple[list[Interval], list[Interval]]:
    """(vardiya aralıkları, planlı duruş aralıkları) — ikisi de birleştirilmiş."""
    return normalize((i.start, i.end) for i in instances), normalize(p for i in instances for p in i.planned_stops)
