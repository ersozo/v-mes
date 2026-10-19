import random

from snap7 import util

from simulator.model import DB_SIZE, DINT_MAX, MachineConfig, MachineModel, ProcessSignal


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
