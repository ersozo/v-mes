import random

import pytest

from snap7 import util

from simulator.model import DB_SIZE, DINT_MAX, OFFSET_STATIONS, MachineConfig, MachineModel, ProcessSignal, StationLine


def make(**overrides) -> MachineModel:
    cfg = MachineConfig(code="m", port=0, ideal_cycle_seconds=10, speed_factor=1.0, scrap_rate=0,
                        mtbf_minutes=0, micro_stops_per_hour=0, initial_count=1000)
    for k, v in overrides.items():
        setattr(cfg, k, v)
    return MachineModel(cfg, random.Random(1))


def run(model: MachineModel, seconds: float, dt: float = 0.1) -> None:
    for _ in range(round(seconds / dt)):
        model.step(dt)


def test_counts_at_ideal_rate():
    m = make()
    run(m, 100)
    assert m.total_count == 1010


def test_speed_factor_reduces_output():
    m = make(speed_factor=0.5)
    run(m, 100)
    assert m.total_count == 1005


def test_forced_stop_halts_production_then_resumes():
    m = make()
    m.force_stop(30)
    run(m, 29.5)
    assert m.total_count == 1000 and not m.running
    run(m, 10.6)
    assert m.running and m.total_count == 1001


def test_indefinite_stop_until_resume():
    m = make()
    m.force_stop(None)
    run(m, 600)
    assert not m.running and m.total_count == 1000
    m.resume()
    run(m, 10.05)
    assert m.total_count == 1001


def test_counter_reset_and_dint_wrap():
    m = make()
    m.reset_counters()
    assert m.total_count == 0
    m.total_count = DINT_MAX
    run(m, 10.05)
    assert m.total_count == 0


def test_random_stops_happen_and_end():
    m = make(mtbf_minutes=1, mean_stop_minutes=0.5)
    states = set()
    for _ in range(36000):
        m.step(0.1)
        states.add(m.running)
    assert states == {True, False}


def test_db_layout_matches_seed():
    m = make(process=[ProcessSignal("t", running_value=50, idle_value=20)])
    m.total_count, m.scrap_count, m.state_code = 123456, 789, 1
    m.process_values[0] = 42.5
    db = bytearray(DB_SIZE)
    m.write_db(db)
    assert util.get_dint(db, 0) == 123456
    assert util.get_dint(db, 4) == 789
    assert util.get_bool(db, 8, 0) is True
    assert util.get_int(db, 10) == 1
    assert util.get_real(db, 12) == 42.5


def test_process_signal_respects_min_value():
    sig = ProcessSignal("load", running_value=0, idle_value=0, noise=5, min_value=0)
    rng = random.Random(3)
    assert all(sig.step(0.1, False, rng) >= 0 for _ in range(500))


def test_station_line_bottleneck_runs_longest_and_sets_throughput():
    line = StationLine([10, 20, 12], jitter=0)
    rng = random.Random(1)
    run_time = [0.0, 0.0, 0.0]
    out = 0
    for _ in range(36_000):              # 1 saat, dt = 0.1
        out += line.step(0.1, True, rng)
        for i, on in enumerate(line.running):
            run_time[i] += 0.1 if on else 0.0
    # Hattın hızı en yavaş istasyon (20 sn): saatte ~180 parça; darboğaz neredeyse sürekli çalışır
    assert 175 <= out <= 181
    assert run_time[1] / 3600 > 0.97
    assert run_time[0] / 3600 == pytest.approx(0.5, abs=0.02) and run_time[2] / 3600 == pytest.approx(0.6, abs=0.02)


def test_station_line_stops_with_machine_and_writes_bits():
    m = make(station_cycles=[5.0, 8.0])
    m.stations = StationLine([5.0, 8.0], jitter=0)
    run(m, 60)
    assert m.total_count > 1000
    db = bytearray(DB_SIZE)
    m.write_db(db)
    assert util.get_bool(db, OFFSET_STATIONS, 1) == m.stations.running[1]
    m.force_stop(None)
    run(m, 1)
    m.write_db(db)
    assert not any(m.stations.running) and not util.get_bool(db, OFFSET_STATIONS, 0) and not util.get_bool(db, OFFSET_STATIONS, 1)
