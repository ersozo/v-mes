"""OEE hesap motoru (saf; I/O yapmaz). ARCHITECTURE.md §9.

Tanımlar (bir makine, bir zaman penceresi için):
    Vardiya süresi   = vardiya aralıkları ∩ pencere (gelecek hariç)
    Planlı süre      = vardiya süresi − planlı duruş tanımları − "planned" kategorili duruşlar − verisiz süre
    Çalışma süresi   = planlı süre − plansız duruşlar (unplanned + changeover + nedeni atanmamış)
    A = çalışma / planlı
    P = Σ(ideal çevrim × adet) / çalışma       (adet, o anda çalışan iş emrinin ürününe göre)
    Q = iyi / toplam
    OEE = A × P × Q

- Mikro duruşlar duruş kaydı açmadığı için çalışma süresinde kalır ve performans kaybı olarak görünür.
- Verisiz süre (hiç durum aralığı olmayan zaman, ör. ingestion kapalıyken) makineye ne kayıp ne
  kazanç yazılır; planlı süreden düşülür ve ayrıca raporlanır.
- Planlı süre dışında üretilen adetler OEE'ye girmez; ``off_plan_count`` olarak raporlanır.
- Toplama (hat/alan/fabrika veya çok dönemli özet) süre ve adetlerin toplanmasıyla yapılır,
  oranların ortalaması alınmaz.
"""

from __future__ import annotations

from bisect import bisect_left
from dataclasses import dataclass, field
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

from mes_api.oee import intervals as iv
from mes_api.oee.calendar import to_local
from mes_api.oee.intervals import Interval

BUCKET = timedelta(minutes=1)


@dataclass(frozen=True)
class Downtime:
    start: datetime
    end: datetime | None          # açık duruş → ``now`` ile kırpılır
    category: str | None          # None = neden atanmamış
    reason_id: int | None = None


@dataclass(frozen=True)
class OrderRun:
    start: datetime
    end: datetime | None
    product_id: int


@dataclass
class MachineData:
    machine_id: int
    scrap_source: str                                   # "plc" | "manual"
    state_intervals: list[tuple[datetime, datetime | None]]
    downtimes: list[Downtime]
    total_buckets: dict[datetime, int]                  # dakika başlangıcı → adet
    scrap_buckets: dict[datetime, int]                  # PLC hurda sayacı
    manual_scrap: list[tuple[datetime, int]]
    order_runs: list[OrderRun]
    ideal_cycle_by_product: dict[int, float]            # bu makine için
    _index: dict = field(default_factory=dict, repr=False, compare=False)

    def events_in(self, name: str, start: datetime, end: datetime) -> list[tuple[datetime, int]]:
        """[start, end) aralığındaki (zaman, adet) olayları — sıralı indeks üzerinden ikili arama."""
        idx = self._index.get(name)
        if idx is None:
            source = {"total": self.total_buckets.items(), "scrap": self.scrap_buckets.items(), "manual": self.manual_scrap}[name]
            events = sorted(source)
            idx = self._index[name] = ([t for t, _ in events], events)
        keys, events = idx
        return events[bisect_left(keys, start):bisect_left(keys, end)]


@dataclass
class OeeResult:
    shift_seconds: float = 0.0
    planned_stop_seconds: float = 0.0
    no_data_seconds: float = 0.0
    planned_seconds: float = 0.0
    unplanned_downtime_seconds: float = 0.0
    changeover_seconds: float = 0.0
    unassigned_downtime_seconds: float = 0.0
    run_seconds: float = 0.0
    total_count: int = 0
    scrap_count: int = 0
    off_plan_count: int = 0
    unattributed_count: int = 0                         # iş emri/çevrim süresi olmayan adet
    ideal_output_seconds: float = 0.0                   # Σ ideal × toplam adet (atanabilenler)
    ideal_good_seconds: float = 0.0                     # Σ ideal × iyi adet
    machine_count: int = 1

    # --- türetilmiş metrikler ---------------------------------------------------
    @property
    def good_count(self) -> int:
        return max(self.total_count - self.scrap_count, 0)

    @property
    def availability(self) -> float | None:
        return self.run_seconds / self.planned_seconds if self.planned_seconds > 0 else None

    @property
    def performance(self) -> float | None:
        if self.run_seconds <= 0 or self.unattributed_count > 0:
            return None
        return self.ideal_output_seconds / self.run_seconds

    @property
    def quality(self) -> float | None:
        return self.good_count / self.total_count if self.total_count > 0 else None

    @property
    def oee(self) -> float | None:
        a, p, q = self.availability, self.performance, self.quality
        if a is None or p is None:
            return None
        # Hiç üretim yoksa kalite tanımsızdır ama OEE sıfırdır (P = 0)
        return a * p * (q if q is not None else 1.0)

    def __add__(self, other: OeeResult) -> OeeResult:
        result = OeeResult()
        for f in self.__dataclass_fields__:
            setattr(result, f, getattr(self, f) + getattr(other, f))
        return result

    def as_dict(self) -> dict:
        warnings = []
        if self.unattributed_count:
            warnings.append(f"{self.unattributed_count} adet iş emri veya ideal çevrim süresi olmadan üretildi; performans hesaplanamadı")
        if self.performance is not None and self.performance > 1.0:
            warnings.append("Performans %100'ün üzerinde: ideal çevrim süresi gerçekten kısa olabilir")
        if self.no_data_seconds > 0:
            if self.machine_count > 1:
                warnings.append(f"Toplam {duration_text(self.no_data_seconds)} makine-süresi boyunca veri yok (makineler toplamı); bu süre hesaba katılmadı")
            else:
                warnings.append(f"{duration_text(self.no_data_seconds)} boyunca veri yok; bu süre hesaba katılmadı")
        return {
            "availability": _r(self.availability),
            "performance": _r(self.performance),
            "quality": _r(self.quality),
            "oee": _r(self.oee),
            "shift_seconds": round(self.shift_seconds),
            "planned_stop_seconds": round(self.planned_stop_seconds),
            "no_data_seconds": round(self.no_data_seconds),
            "planned_seconds": round(self.planned_seconds),
            "run_seconds": round(self.run_seconds),
            "unplanned_downtime_seconds": round(self.unplanned_downtime_seconds),
            "changeover_seconds": round(self.changeover_seconds),
            "unassigned_downtime_seconds": round(self.unassigned_downtime_seconds),
            "total_count": self.total_count,
            "good_count": self.good_count,
            "scrap_count": self.scrap_count,
            "off_plan_count": self.off_plan_count,
            "unattributed_count": self.unattributed_count,
            # Kayıp şelalesi (saniye): planlı → çalışma → net (ideal × toplam) → tam verimli (ideal × iyi)
            "losses": {
                "availability_seconds": round(self.planned_seconds - self.run_seconds),
                "performance_seconds": round(self.run_seconds - self.ideal_output_seconds) if self.performance is not None else None,
                "quality_seconds": round(self.ideal_output_seconds - self.ideal_good_seconds) if self.performance is not None else None,
                "fully_productive_seconds": round(self.ideal_good_seconds) if self.performance is not None else None,
            },
            "machine_count": self.machine_count,
            "warnings": warnings,
        }


def duration_text(seconds: float) -> str:
    minutes = round(seconds / 60)
    if minutes < 60:
        return f"{minutes} dk"
    hours, rest = divmod(minutes, 60)
    return f"{hours} sa {rest} dk" if rest else f"{hours} sa"


def _r(v: float | None) -> float | None:
    return None if v is None else round(v, 4)


def _closed(items: list[tuple[datetime, datetime | None]], now: datetime) -> list[Interval]:
    return iv.normalize((s, e if e is not None else now) for s, e in items)


def compute(
    data: MachineData,
    window: Interval,
    shift_windows: list[Interval],
    planned_stops: list[Interval],
    now: datetime,
) -> OeeResult:
    start, end = window[0], min(window[1], now)
    if end <= start:
        return OeeResult()
    win = [(start, end)]

    shift_time = iv.intersect(shift_windows, win)
    stop_time = iv.intersect(planned_stops, shift_time)

    downtimes = [(d, (d.start, d.end or now)) for d in data.downtimes if d.start < end and (d.end is None or d.end > start)]
    planned_dt = iv.normalize(i for d, i in downtimes if d.category == "planned")
    covered = _closed([(s, e) for s, e in data.state_intervals if s < end and (e is None or e > start)], now)
    no_data = iv.subtract(iv.subtract(shift_time, stop_time), covered)

    planned = iv.subtract(iv.subtract(iv.subtract(shift_time, stop_time), planned_dt), no_data)

    def loss(pred) -> list[Interval]:
        return iv.intersect(iv.normalize(i for d, i in downtimes if pred(d)), planned)

    unplanned = loss(lambda d: d.category == "unplanned")
    changeover = loss(lambda d: d.category == "changeover")
    unassigned = loss(lambda d: d.category is None)
    all_losses = iv.union(unplanned, changeover, unassigned)

    r = OeeResult(
        shift_seconds=iv.total_seconds(shift_time),
        planned_stop_seconds=iv.total_seconds(iv.union(stop_time, iv.intersect(planned_dt, shift_time))),
        no_data_seconds=iv.total_seconds(no_data),
        planned_seconds=iv.total_seconds(planned),
        unplanned_downtime_seconds=iv.total_seconds(unplanned),
        changeover_seconds=iv.total_seconds(changeover),
        unassigned_downtime_seconds=iv.total_seconds(unassigned),
        run_seconds=iv.total_seconds(iv.subtract(planned, all_losses)),
    )

    # Adetler: dakika kovası, başlangıcı planlı sürede ise OEE'ye dahildir.
    runs = sorted(data.order_runs, key=lambda o: o.start)

    def ideal_at(t: datetime) -> float | None:
        for o in runs:
            if o.start <= t and (o.end is None or t < o.end):
                return data.ideal_cycle_by_product.get(o.product_id)
        return None

    for bucket, count in data.events_in("total", start, end):
        if not iv.contains(planned, bucket):
            r.off_plan_count += count
            continue
        r.total_count += count
        ideal = ideal_at(bucket)
        if ideal is None:
            r.unattributed_count += count
        else:
            r.ideal_output_seconds += ideal * count

    scrap_ideal_seconds = 0.0
    for ts, qty in data.events_in("scrap" if data.scrap_source == "plc" else "manual", start, end):
        if iv.contains(planned, ts):
            r.scrap_count += qty
            scrap_ideal_seconds += (ideal_at(ts) or 0.0) * qty
    r.scrap_count = min(r.scrap_count, r.total_count)
    r.ideal_good_seconds = max(r.ideal_output_seconds - scrap_ideal_seconds, 0.0)
    return r


@dataclass
class Period:
    start: datetime
    end: datetime
    label: str
    shift_id: int | None = None
    extra: dict = field(default_factory=dict)


def periods(start: datetime, end: datetime, group_by: str, tz: ZoneInfo, instances: list | None = None) -> list[Period]:
    """Raporlama dönemleri. Saat/gün/hafta sınırları fabrika yerel saatine göredir (yaz saati güvenli)."""
    if group_by == "none":
        return [Period(start, end, "toplam")]
    if group_by == "shift":
        return [Period(max(i.start, start), min(i.end, end), i.label, i.shift_id) for i in (instances or [])]

    result: list[Period] = []
    local = to_local(start, tz)
    if group_by == "hour":
        # Saat adımları UTC'de atılır; etiket yerel saattir.
        cursor = local.replace(minute=0, second=0, microsecond=0).astimezone(UTC).replace(tzinfo=None)
        while cursor < end:
            nxt = cursor + timedelta(hours=1)
            result.append(Period(max(cursor, start), min(nxt, end), to_local(cursor, tz).strftime("%Y-%m-%d %H:00")))
            cursor = nxt
        return result

    if group_by == "day":
        day = local.date()
        step, fmt = timedelta(days=1), "%Y-%m-%d"
    elif group_by == "week":
        day = local.date() - timedelta(days=local.weekday())
        step, fmt = timedelta(days=7), "%G-W%V"
    else:
        raise ValueError(f"geçersiz group_by: {group_by}")

    def midnight_utc(d) -> datetime:
        return datetime.combine(d, time(0), tzinfo=tz).astimezone(UTC).replace(tzinfo=None)

    while (p_start := midnight_utc(day)) < end:
        p_end = midnight_utc(day + step)
        result.append(Period(max(p_start, start), min(p_end, end), day.strftime(fmt)))
        day += step
    return result
