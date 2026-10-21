"""Makine davranış modeli (S7 sunucusundan bağımsız, saf ve test edilebilir).

DB1 düzeni (S7-1200/1500, optimize edilmemiş blok) — db/seed ile aynı:
    DBD0   DINT  total_count
    DBD4   DINT  scrap_count
    DBX8.0 BOOL  running
    DBW10  INT   state_code   (0 = beklemede, 1 = çalışıyor, >=100 = arıza/duruş kodu)
    DBD12  REAL  proses sinyali 1
    DBD16  REAL  proses sinyali 2
    DBX20.0 … BOOL  istasyon koşu bitleri (yalnızca seri istasyonlu makinelerde; 1. istasyon 20.0, 9. istasyon 21.0)
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field

from snap7 import util

DB_SIZE = 22
OFFSET_TOTAL = 0
OFFSET_SCRAP = 4
OFFSET_RUNNING = 8
OFFSET_STATE = 10
OFFSET_PROCESS = (12, 16)
OFFSET_STATIONS = 20
MAX_STATIONS = 16

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
class StationLine:
    """Seri istasyonlar: parça istasyonlardan sırayla geçer, istasyonlar arasında tampon yoktur.

    Bir istasyon parçasını bitirince sonraki istasyon boşalana kadar bekler (bloke); önceki istasyondan
    parça gelmeden çalışamaz (aç). Böylece en yavaş istasyon en uzun çalışır — darboğaz analizinin
    görmesi gereken davranış budur.
    """

    cycles: list[float]                 # istasyon başına çevrim süresi (sn)
    jitter: float = 0.1                 # çevrim süresi ± oranı
    has_part: list[bool] = field(default_factory=list)
    remaining: list[float] = field(default_factory=list)
    running: list[bool] = field(default_factory=list)

    def __post_init__(self) -> None:
        n = len(self.cycles)
        if not 1 <= n <= MAX_STATIONS:
            raise ValueError(f"istasyon sayısı 1–{MAX_STATIONS} olmalı")
        self.has_part = [False] * n
        self.remaining = [0.0] * n
        self.running = [False] * n

    def _load(self, i: int, rng: random.Random) -> None:
        self.has_part[i] = True
        self.remaining[i] = self.cycles[i] * rng.uniform(1 - self.jitter, 1 + self.jitter)

    def step(self, dt: float, line_running: bool, rng: random.Random) -> int:
        """Bir adım ilerletir; son istasyondan çıkan parça sayısını döndürür."""
        if not line_running:
            self.running = [False] * len(self.cycles)
            return 0
        out = 0
        last = len(self.cycles) - 1
        # Sondan başa: önce aşağı akış boşalır, böylece aynı adımda parça ilerleyebilir
        for i in range(last, -1, -1):
            if self.has_part[i] and self.remaining[i] > 0:
                self.remaining[i] -= dt
            if self.has_part[i] and self.remaining[i] <= 0:
                if i == last:
                    out += 1
                    self.has_part[i] = False
                elif not self.has_part[i + 1]:
                    self._load(i + 1, rng)
                    self.has_part[i] = False
            if i == 0 and not self.has_part[0]:
                self._load(0, rng)
        self.running = [self.has_part[i] and self.remaining[i] > 0 for i in range(len(self.cycles))]
        return out


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
    # Doluysa üretim adedi son istasyondan çıkan parçalardır (ideal_cycle_seconds/speed_factor yerine)
    station_cycles: list[float] = field(default_factory=list)


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
    stations: StationLine | None = None

    def __post_init__(self) -> None:
        self.total_count = self.config.initial_count
        self.scrap_count = self.config.initial_count // 50
        self.process_values = [0.0] * len(OFFSET_PROCESS)
        if self.config.station_cycles:
            self.stations = StationLine(list(self.config.station_cycles))

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

        if self.stations is not None:
            produced = self.stations.step(dt, self.running, self.rng)
        else:
            produced = 0
            if self.running:
                self._progress += dt * cfg.speed_factor / cfg.ideal_cycle_seconds
                while self._progress >= 1.0:
                    self._progress -= 1.0
                    produced += 1
        for _ in range(produced):
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
        if self.stations is not None:
            for i, on in enumerate(self.stations.running):
                util.set_bool(db, OFFSET_STATIONS + i // 8, i % 8, on)
