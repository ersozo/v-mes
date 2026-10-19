"""Gerçek S7 protokolü üzerinden uçtan uca okuma (sunucu + istemci aynı süreçte)."""

import random
import socket

import snap7
from snap7 import util

from simulator.main import SimulatedPlc
from simulator.model import MachineConfig, MachineModel


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_client_reads_db1_like_a_s7_1500():
    port = free_port()
    cfg = MachineConfig(code="m", port=port, ideal_cycle_seconds=1, speed_factor=1, scrap_rate=0,
                        mtbf_minutes=0, micro_stops_per_hour=0, initial_count=500)
    plc = SimulatedPlc(MachineModel(cfg, random.Random(1)))
    plc.start_server()
    try:
        plc.tick(2.0)
        client = snap7.Client()
        client.connect("127.0.0.1", 0, 1, port)  # S7-1200/1500: rack 0, slot 1
        data = client.db_read(1, 0, 20)
        assert util.get_dint(data, 0) == 502
        assert util.get_bool(data, 8, 0) is True
        client.disconnect()
    finally:
        plc.stop_server()
