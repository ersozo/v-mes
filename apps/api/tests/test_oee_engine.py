"""OEE motoru — beklenen değerler elle hesaplanmıştır."""

from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest

from mes_api.oee import intervals as iv
from mes_api.oee.calendar import PlannedStopDef, ShiftDef, planned_windows, shift_instances
from mes_api.oee.engine import Downtime, MachineData, OrderRun, compute, periods

IST = ZoneInfo("Europe/Istanbul")   # UTC+3, yaz saati yok
BER = ZoneInfo("Europe/Berlin")     # 2026-10-25 03:00'te yaz saati biter


def utc(h, m=0, day=19):
    return datetime(2026, 10, day, h, m)


DAY_SHIFT = ShiftDef(1, "Gündüz", time(8), time(16), 127, (PlannedStopDef("Yemek", time(12), 30),))


def windows(shifts, start, end, tz=IST):
    return planned_windows(shift_instances(shifts, start, end, tz))


def machine(**overrides) -> MachineData:
    # Yerel 08:00–16:00 = UTC 05:00–13:00; yemek UTC 09:00–09:30
    base = dict(
        machine_id=1,
        scrap_source="plc",
        state_intervals=[(utc(5), utc(13))],
        downtimes=[
            Downtime(utc(6), utc(6, 30), "unplanned"),
            Downtime(utc(7), utc(7, 20), None),              # nedeni atanmamış
            Downtime(utc(8), utc(8, 10), "changeover"),
            Downtime(utc(10), utc(10, 30), "planned"),        # planlı bakım
        ],
        total_buckets={utc(5, 30): 600, utc(9, 10): 50},     # 09:10 yemek molasında
        scrap_buckets={utc(5, 31): 30},
        manual_scrap=[],
        order_runs=[OrderRun(utc(5), None, product_id=7)],
        ideal_cycle_by_product={7: 30.0},
    )
    base.update(overrides)
    return MachineData(**base)


def run(data, start=utc(-3 + 24, day=18), end=utc(21), now=utc(23)):
    shifts, stops = windows([DAY_SHIFT], start, end)
    return compute(data, (start, end), shifts, stops, now)


def test_full_day_hand_calculated():
    r = run(machine())
    # Vardiya 480 dk; planlı = 480 − 30 yemek − 30 planlı bakım = 420 dk
    assert r.shift_seconds == 480 * 60
    assert r.planned_seconds == 420 * 60
    # Kayıplar: 30 plansız + 20 atanmamış + 10 ürün değişimi = 60 dk → çalışma 360 dk
    assert (r.unplanned_downtime_seconds, r.unassigned_downtime_seconds, r.changeover_seconds) == (1800, 1200, 600)
    assert r.run_seconds == 360 * 60
    assert r.total_count == 600 and r.off_plan_count == 50 and r.scrap_count == 30
    assert r.availability == pytest.approx(360 / 420)
    assert r.performance == pytest.approx(600 * 30 / (360 * 60))     # 300 / 360
    assert r.quality == pytest.approx(570 / 600)
    assert r.oee == pytest.approx((360 / 420) * (300 / 360) * 0.95)
    d = r.as_dict()
    assert d["losses"] == {"availability_seconds": 3600, "performance_seconds": 3600,
                           "quality_seconds": 900, "fully_productive_seconds": 17100}


def test_no_data_is_excluded_not_penalized():
    r = run(machine(state_intervals=[(utc(5), utc(12))]))        # 12:00–13:00 veri yok
    assert r.no_data_seconds == 3600
    assert r.planned_seconds == 360 * 60
    assert r.run_seconds == 300 * 60
    assert any("veri yok" in w for w in r.as_dict()["warnings"])


def test_open_downtime_and_future_are_clipped_to_now():
    data = machine(downtimes=[Downtime(utc(12), None, "unplanned")], state_intervals=[(utc(5), None)])
    r = run(data, now=utc(12, 30))
    # Vardiya şimdiye kadar: 05:00–12:30 = 450 dk, yemek 30 → planlı 420, açık duruş 30 dk
    assert r.planned_seconds == 420 * 60
    assert r.run_seconds == 390 * 60


def test_without_order_performance_is_unknown():
    r = run(machine(order_runs=[]))
    assert r.unattributed_count == 600
    assert r.performance is None and r.oee is None
    assert r.availability is not None
    assert "performans hesaplanamadı" in r.as_dict()["warnings"][0]


def test_product_change_uses_each_products_ideal_cycle():
    data = machine(
        total_buckets={utc(5, 30): 100, utc(11, 0): 200},
        scrap_buckets={},
        order_runs=[OrderRun(utc(5), utc(10), 7), OrderRun(utc(10), None, 8)],
        ideal_cycle_by_product={7: 30.0, 8: 10.0},
    )
    r = run(data)
    assert r.ideal_output_seconds == 100 * 30 + 200 * 10


def test_manual_scrap_source():
    data = machine(scrap_source="manual", scrap_buckets={utc(5, 31): 999}, manual_scrap=[(utc(6, 5), 12), (utc(9, 5), 5)])
    r = run(data)
    assert r.scrap_count == 12   # 09:05 yemek molasında → dahil değil; PLC sayacı yok sayılır


def test_no_production_gives_zero_oee():
    r = run(machine(total_buckets={}, scrap_buckets={}))
    assert r.performance == 0 and r.quality is None and r.oee == 0


def test_aggregation_is_time_weighted():
    a = run(machine())
    b = run(machine(downtimes=[], total_buckets={utc(5, 30): 720}, scrap_buckets={}))
    total = a + b
    assert total.machine_count == 2
    assert total.availability == pytest.approx((a.run_seconds + b.run_seconds) / (a.planned_seconds + b.planned_seconds))
    assert total.availability != pytest.approx((a.availability + b.availability) / 2)


def test_outside_shift_window_is_empty():
    shifts, stops = windows([DAY_SHIFT], utc(14), utc(20))
    r = compute(machine(), (utc(14), utc(20)), shifts, stops, utc(23))
    assert r.planned_seconds == 0 and r.availability is None


# --- Takvim ---------------------------------------------------------------------

def test_night_shift_crosses_midnight_with_planned_stop():
    night = ShiftDef(2, "Gece", time(22), time(6), 127, (PlannedStopDef("Yemek", time(2), 30),))
    inst = shift_instances([night], utc(0), utc(23, 59), IST)
    i = next(x for x in inst if x.local_date.isoformat() == "2026-10-19")
    assert (i.start, i.end) == (utc(19), utc(3, day=20))
    assert i.planned_stops == ((utc(23), utc(23, 30)),)


def test_days_mask_respected():
    weekdays = ShiftDef(1, "Gündüz", time(8), time(16), 0b0011111, ())   # Pzt–Cum
    inst = shift_instances([weekdays], datetime(2026, 10, 19), datetime(2026, 10, 26), IST)  # Pzt–Pzt
    assert [i.local_date.weekday() for i in inst] == [0, 1, 2, 3, 4]


def test_dst_end_night_shift_is_nine_hours():
    night = ShiftDef(2, "Gece", time(22), time(6), 127, ())
    inst = shift_instances([night], datetime(2026, 10, 24, 12), datetime(2026, 10, 25, 12), BER)
    i = next(x for x in inst if x.local_date.isoformat() == "2026-10-24")
    assert i.end - i.start == timedelta(hours=9)


def test_periods_day_hour_week_and_dst():
    day = periods(datetime(2026, 10, 24, 22), datetime(2026, 10, 26, 23), "day", BER)
    lengths = {p.label: (p.end - p.start).total_seconds() / 3600 for p in day}
    assert lengths["2026-10-25"] == 25
    hours = periods(utc(5), utc(8), "hour", IST)
    assert [p.label for p in hours] == ["2026-10-19 08:00", "2026-10-19 09:00", "2026-10-19 10:00"]
    weeks = periods(datetime(2026, 10, 19), datetime(2026, 11, 2), "week", IST)
    assert [p.label for p in weeks] == ["2026-W43", "2026-W44", "2026-W45"]


# --- Aralık işlemleri ---------------------------------------------------------------

def test_interval_operations():
    a = [(utc(1), utc(5)), (utc(4), utc(6)), (utc(8), utc(9))]
    assert iv.normalize(a) == [(utc(1), utc(6)), (utc(8), utc(9))]
    assert iv.subtract([(utc(1), utc(10))], [(utc(2), utc(3)), (utc(5), utc(6))]) == [(utc(1), utc(2)), (utc(3), utc(5)), (utc(6), utc(10))]
    assert iv.intersect([(utc(1), utc(5))], [(utc(3), utc(8))]) == [(utc(3), utc(5))]
    norm = iv.normalize(a)
    assert iv.contains(norm, utc(5, 59)) and not iv.contains(norm, utc(6)) and not iv.contains(norm, utc(7))


def test_month_of_hourly_periods_is_fast():
    import time as _t
    start = datetime(2026, 9, 30, 21)
    buckets = {start + timedelta(minutes=i): 2 for i in range(31 * 24 * 60)}
    data = machine(state_intervals=[(start, None)], downtimes=[], total_buckets=buckets, scrap_buckets={})
    end = start + timedelta(days=31)
    shifts, stops = windows([DAY_SHIFT], start, end)
    t0 = _t.perf_counter()
    total = sum(compute(data, (p.start, p.end), shifts, stops, end).total_count for p in periods(start, end, "hour", IST))
    assert _t.perf_counter() - t0 < 3.0
    assert total == 31 * (480 - 30) * 2   # yalnızca planlı süredeki adetler
