"""Makine davranış modeli (S7 sunucusundan bağımsız, saf ve test edilebilir).

DB1 düzeni (S7-1200/1500, optimize edilmemiş blok) — db/seed ile aynı:
    DBD0   DINT  total_count
    DBD4   DINT  scrap_count
    DBX8.0 BOOL  running
    DBW10  INT   state_code   (0 = beklemede, 1 = çalışıyor, >=100 = arıza/duruş kodu)
    DBD12  REAL  proses sinyali 1
    DBD16  REAL  proses sinyali 2
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field

from snap7 import util

DB_SIZE = 20
OFFSET_TOTAL = 0
OFFSET_SCRAP = 4
OFFSET_RUNNING = 8
OFFSET_STATE = 10
OFFSET_PROCESS = (12, 16)

STATE_IDLE = 0
STATE_RUNNING = 1
STOP_CODES = (101, 102, 103, 104)  # mekanik, elektrik, malzeme, operatör

DINT_MAX = 2**31 - 1


@dataclass
class ProcessSignal:
    """Çalışırken ``running_value``, dururken ``idle_value`` değerine birinci dereceden yaklaşan sinyal."""

    name: str
    running_value: float
    idle_value: float
    noise: float = 0.0
    tau_seconds: float = 60.0
    min_value: float | None = None      # fiziksel alt sınır (ör. yük/tonaj eksi olamaz)
    value: float | None = None

    def step(self, dt: float, running: bool, rng: random.Random) -> float:
        target = self.running_value if running else self.idle_value
        if self.value is None:
            self.value = self.idle_value
        alpha = min(1.0, dt / max(self.tau_seconds, 1e-6))
        self.value += (target - self.value) * alpha
        out = self.value + (rng.gauss(0, self.noise) if self.noise else 0.0)
        return out if self.min_value is None else max(self.min_value, out)


@dataclass
class MachineConfig:
    code: str
    port: int
    ideal_cycle_seconds: float
    speed_factor: float = 0.92          # gerçek hız / ideal hız (Performance)
    scrap_rate: float = 0.02            # hurda olasılığı (Quality)
    mtbf_minutes: float = 25.0          # ortalama arızasız çalışma süresi
    mean_stop_minutes: float = 3.0      # ortalama duruş süresi
    micro_stops_per_hour: float = 6.0   # 10–45 sn'lik kısa duruşlar
    initial_count: int = 100_000
    process: list[ProcessSignal] = field(default_factory=list)


@dataclass
class MachineModel:
    config: MachineConfig
    rng: random.Random
    total_count: int = 0
    scrap_count: int = 0
    running: bool = True
    state_code: int = STATE_RUNNING
    stop_remaining: float = 0.0
    forced_stop: bool = False           # kontrol API'si ile süresiz durdurma
    _progress: float = 0.0
    process_values: list[float] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.total_count = self.config.initial_count
        self.scrap_count = self.config.initial_count // 50
        self.process_values = [0.0] * len(OFFSET_PROCESS)

    # --- dış komutlar -------------------------------------------------------
    def force_stop(self, seconds: float | None, code: int = 101) -> None:
        """``seconds`` None ise ``resume`` çağrılana kadar durur."""
        self.running = False
        self.state_code = code
        self.forced_stop = seconds is None
        self.stop_remaining = seconds or 0.0

    def resume(self) -> None:
        self.forced_stop = False
        self.stop_remaining = 0.0
        self.running = True
        self.state_code = STATE_RUNNING

    def reset_counters(self) -> None:
        """PLC'de sayaç sıfırlanmasını taklit eder."""
        self.total_count = 0
        self.scrap_count = 0
        self._progress = 0.0

    # --- simülasyon adımı ---------------------------------------------------
    def step(self, dt: float) -> None:
        cfg = self.config
        if self.running:
            self._maybe_start_random_stop(dt)
        elif not self.forced_stop:
            self.stop_remaining -= dt
            if self.stop_remaining <= 0:
                self.resume()

        if self.running:
            self._progress += dt * cfg.speed_factor / cfg.ideal_cycle_seconds
            while self._progress >= 1.0:
                self._progress -= 1.0
                self.total_count = self.total_count + 1 if self.total_count < DINT_MAX else 0
                if self.rng.random() < cfg.scrap_rate:
                    self.scrap_count = self.scrap_count + 1 if self.scrap_count < DINT_MAX else 0

        for i, signal in enumerate(cfg.process[: len(OFFSET_PROCESS)]):
            self.process_values[i] = signal.step(dt, self.running, self.rng)

    def _maybe_start_random_stop(self, dt: float) -> None:
        cfg = self.config
        # Poisson süreci: dt içinde olay olasılığı ≈ dt / ortalama aralık
        if cfg.mtbf_minutes > 0 and self.rng.random() < dt / (cfg.mtbf_minutes * 60):
            duration = self.rng.expovariate(1 / (cfg.mean_stop_minutes * 60))
            self.force_stop(max(30.0, duration), code=self.rng.choice(STOP_CODES))
        elif cfg.micro_stops_per_hour > 0 and self.rng.random() < dt * cfg.micro_stops_per_hour / 3600:
            self.force_stop(self.rng.uniform(10, 45), code=STATE_IDLE)

    # --- PLC belleği --------------------------------------------------------
    def write_db(self, db: bytearray) -> None:
        util.set_dint(db, OFFSET_TOTAL, self.total_count)
        util.set_dint(db, OFFSET_SCRAP, self.scrap_count)
        util.set_bool(db, OFFSET_RUNNING, 0, self.running)
        util.set_int(db, OFFSET_STATE, self.state_code)
        for offset, value in zip(OFFSET_PROCESS, self.process_values):
            util.set_real(db, offset, value)
