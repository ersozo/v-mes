"""S7 PLC simülatörü: her makine için ayrı portta bir S7 sunucusu açar ve DB1'i günceller.

Kontrol API'si (geliştirme/test için, varsayılan port 8090):
    GET  /machines                          → anlık durum
    POST /machines/{code}/stop?seconds=60   → duruş başlat (seconds yoksa süresiz)
    POST /machines/{code}/resume            → çalışmaya devam
    POST /machines/{code}/reset-counters    → sayaç sıfırlanması
    POST /machines/{code}/disconnect?seconds=20 → S7 sunucusunu geçici olarak kapat
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import snap7
import yaml
from snap7.type import SrvArea

from simulator.model import DB_SIZE, MachineConfig, MachineModel, ProcessSignal

log = logging.getLogger("simulator")
TICK_SECONDS = 0.1


class SimulatedPlc:
    def __init__(self, model: MachineModel) -> None:
        self.model = model
        self.db = bytearray(DB_SIZE)
        self.lock = threading.Lock()
        self.server: snap7.Server | None = None
        self.offline_until = 0.0

    @property
    def code(self) -> str:
        return self.model.config.code

    def start_server(self) -> None:
        server = snap7.Server(log=False)
        server.register_area(SrvArea.DB, 1, self.db)
        server.start(tcp_port=self.model.config.port)
        self.server = server
        log.info("%s: S7 sunucusu port %d üzerinde", self.code, self.model.config.port)

    def stop_server(self) -> None:
        if self.server is not None:
            self.server.stop()
            self.server.destroy()
            self.server = None

    def disconnect(self, seconds: float) -> None:
        with self.lock:
            self.stop_server()
            self.offline_until = time.monotonic() + seconds
        log.info("%s: %d sn bağlantı kesintisi", self.code, seconds)

    def tick(self, dt: float) -> None:
        with self.lock:
            self.model.step(dt)
            if self.server is None and time.monotonic() >= self.offline_until:
                self.start_server()
            if self.server is not None:
                self.server.lock_area(SrvArea.DB, 1)
                try:
                    self.model.write_db(self.db)
                finally:
                    self.server.unlock_area(SrvArea.DB, 1)

    def snapshot(self) -> dict:
        m = self.model
        return {
            "code": self.code,
            "port": m.config.port,
            "online": self.server is not None,
            "running": m.running,
            "state_code": m.state_code,
            "total_count": m.total_count,
            "scrap_count": m.scrap_count,
            "process": [round(v, 2) for v in m.process_values],
            **({"stations_running": m.stations.running} if m.stations else {}),
        }


def load_config(path: Path) -> list[MachineConfig]:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    machines = []
    for item in raw["machines"]:
        process = [ProcessSignal(**p) for p in item.pop("process", [])]
        machines.append(MachineConfig(**item, process=process))
    return machines


def make_handler(plcs: dict[str, SimulatedPlc]) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: object) -> None:
            log.debug(fmt, *args)

        def _send(self, status: int, body: object) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            if urlparse(self.path).path == "/machines":
                self._send(200, [p.snapshot() for p in plcs.values()])
            else:
                self._send(404, {"error": "bulunamadı"})

        def do_POST(self) -> None:
            url = urlparse(self.path)
            parts = url.path.strip("/").split("/")
            query = parse_qs(url.query)
            if len(parts) != 3 or parts[0] != "machines" or parts[1] not in plcs:
                self._send(404, {"error": "bulunamadı"})
                return
            plc, action = plcs[parts[1]], parts[2]
            seconds = float(query["seconds"][0]) if "seconds" in query else None
            with plc.lock:
                if action == "stop":
                    plc.model.force_stop(seconds, code=int(query.get("code", ["101"])[0]))
                elif action == "resume":
                    plc.model.resume()
                elif action == "reset-counters":
                    plc.model.reset_counters()
                elif action != "disconnect":
                    self._send(400, {"error": f"bilinmeyen işlem: {action}"})
                    return
            if action == "disconnect":
                plc.disconnect(seconds or 20)
            self._send(200, plc.snapshot())

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path("machines.yaml"))
    parser.add_argument("--control-port", type=int, default=8090)
    parser.add_argument("--seed", type=int, default=None, help="tekrarlanabilir senaryo için rastgele tohum")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    rng = random.Random(args.seed)
    plcs = {cfg.code: SimulatedPlc(MachineModel(cfg, random.Random(rng.random()))) for cfg in load_config(args.config)}
    for plc in plcs.values():
        plc.start_server()

    http = ThreadingHTTPServer(("0.0.0.0", args.control_port), make_handler(plcs))
    threading.Thread(target=http.serve_forever, daemon=True).start()
    log.info("kontrol API'si port %d üzerinde", args.control_port)

    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())

    last = time.monotonic()
    while not stop.wait(TICK_SECONDS):
        now = time.monotonic()
        for plc in plcs.values():
            plc.tick(now - last)
        last = now

    http.shutdown()
    for plc in plcs.values():
        with plc.lock:
            plc.stop_server()
    log.info("durduruldu")


if __name__ == "__main__":
    main()
