"""OEE ve raporlar için veritabanı okumaları."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, time
from zoneinfo import ZoneInfo

import pymssql
from fastapi import HTTPException, status

from mes_api.db import fetch_all, fetch_one
from mes_api.oee.calendar import PlannedStopDef, ShiftDef
from mes_api.oee.engine import Downtime, MachineData, OrderRun

Scope = str  # "plant" | "area" | "line" | "machine"


@dataclass(frozen=True)
class MachineInfo:
    id: int
    code: str
    name: str
    line_id: int
    line_name: str
    area_id: int
    area_name: str
    scrap_source: str


def plant_timezone(conn: pymssql.Connection) -> ZoneInfo:
    row = fetch_one(conn, "SELECT value FROM dbo.plant_settings WHERE [key] = 'timezone'")
    return ZoneInfo(row["value"] if row else "Europe/Istanbul")


def _time(v) -> time:
    """pymssql TIME kolonlarını sürücü/TDS sürümüne göre time veya str döndürebilir."""
    return v if isinstance(v, time) else time.fromisoformat(str(v)[:8])


def load_shifts(conn: pymssql.Connection) -> list[ShiftDef]:
    shifts = fetch_all(conn, "SELECT id, name, start_local, end_local, days_mask FROM dbo.shift_definitions WHERE is_active = 1")
    stops = fetch_all(conn, "SELECT shift_definition_id, name, start_local, duration_minutes FROM dbo.planned_stop_definitions")
    by_shift: dict[int, list[PlannedStopDef]] = defaultdict(list)
    for s in stops:
        by_shift[s["shift_definition_id"]].append(PlannedStopDef(s["name"], _time(s["start_local"]), s["duration_minutes"]))
    return [ShiftDef(s["id"], s["name"], _time(s["start_local"]), _time(s["end_local"]), s["days_mask"], tuple(by_shift[s["id"]])) for s in shifts]


def resolve_machines(conn: pymssql.Connection, scope: Scope, scope_id: int | None) -> list[MachineInfo]:
    base = """
        SELECT m.id, m.code, m.name, m.line_id, l.name AS line_name, l.area_id, a.name AS area_name, m.scrap_source
        FROM dbo.machines m JOIN dbo.lines l ON l.id = m.line_id JOIN dbo.areas a ON a.id = l.area_id"""
    if scope == "plant":
        rows = fetch_all(conn, base + " WHERE m.is_active = 1 ORDER BY a.sort_order, l.sort_order, m.sort_order, m.code")
    else:
        if scope_id is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f'"{scope}" kapsamı için id gerekli')
        column = {"area": "l.area_id", "line": "m.line_id", "machine": "m.id"}.get(scope)
        if column is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "scope: plant, area, line veya machine olmalı")
        active = "" if scope == "machine" else " AND m.is_active = 1"
        rows = fetch_all(conn, base + f" WHERE {column} = %s{active} ORDER BY l.sort_order, m.sort_order, m.code", (scope_id,))
        if scope == "machine" and not rows:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Makine bulunamadı")
    return [MachineInfo(**r) for r in rows]


def _in(ids: list[int]) -> str:
    return ", ".join(str(int(i)) for i in ids)   # tamsayılar; enjeksiyon riski yok


def load_machine_data(conn: pymssql.Connection, machines: list[MachineInfo], start: datetime, end: datetime) -> dict[int, MachineData]:
    if not machines:
        return {}
    ids = _in([m.id for m in machines])
    rng = {"start": start, "end": end}

    data = {
        m.id: MachineData(m.id, m.scrap_source, [], [], {}, {}, [], [], {}) for m in machines
    }
    for r in fetch_all(conn, f"""
            SELECT machine_id, start_ts, end_ts FROM dbo.machine_state_intervals
            WHERE machine_id IN ({ids}) AND start_ts < %(end)s AND (end_ts IS NULL OR end_ts > %(start)s)""", rng):
        data[r["machine_id"]].state_intervals.append((r["start_ts"], r["end_ts"]))

    for r in fetch_all(conn, f"""
            SELECT d.machine_id, d.start_ts, d.end_ts, d.reason_id, dr.category
            FROM dbo.downtime_logs d LEFT JOIN dbo.downtime_reasons dr ON dr.id = d.reason_id
            WHERE d.machine_id IN ({ids}) AND d.start_ts < %(end)s AND (d.end_ts IS NULL OR d.end_ts > %(start)s)""", rng):
        data[r["machine_id"]].downtimes.append(Downtime(r["start_ts"], r["end_ts"], r["category"], r["reason_id"]))

    for r in fetch_all(conn, f"""
            SELECT machine_id, bucket_ts, role, delta FROM dbo.counter_deltas_1m
            WHERE machine_id IN ({ids}) AND bucket_ts >= %(start)s AND bucket_ts < %(end)s""", rng):
        target = data[r["machine_id"]].total_buckets if r["role"] == "total_count" else data[r["machine_id"]].scrap_buckets
        target[r["bucket_ts"]] = int(r["delta"])

    for r in fetch_all(conn, f"""
            SELECT machine_id, ts, qty FROM dbo.manual_scrap_entries
            WHERE machine_id IN ({ids}) AND ts >= %(start)s AND ts < %(end)s""", rng):
        data[r["machine_id"]].manual_scrap.append((r["ts"], r["qty"]))

    for r in fetch_all(conn, f"""
            SELECT r.machine_id, r.start_ts, r.end_ts, o.product_id
            FROM dbo.production_order_runs r JOIN dbo.production_orders o ON o.id = r.production_order_id
            WHERE r.machine_id IN ({ids}) AND r.start_ts < %(end)s AND (r.end_ts IS NULL OR r.end_ts > %(start)s)""", rng):
        data[r["machine_id"]].order_runs.append(OrderRun(r["start_ts"], r["end_ts"], r["product_id"]))

    for r in fetch_all(conn, f"SELECT machine_id, product_id, ideal_cycle_seconds FROM dbo.product_machine_rates WHERE machine_id IN ({ids})"):
        data[r["machine_id"]].ideal_cycle_by_product[r["product_id"]] = float(r["ideal_cycle_seconds"])

    return data
