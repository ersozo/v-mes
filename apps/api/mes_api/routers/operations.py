"""Operasyon: iş emirleri, duruş nedeni atama, manuel hurda girişi, operatör ekranı özeti."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Annotated, Literal

import pymssql
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field

from mes_api.db import execute, fetch_all, fetch_one
from mes_api.deps import any_user, can_configure, can_operate, get_db
from mes_api.oee.window import iso, parse_ts, utcnow
from mes_api.security import TokenUser

router = APIRouter(prefix="/api", tags=["operations"])

OrderStatus = Literal["planned", "running", "paused", "done", "cancelled"]


# --- İş emirleri -----------------------------------------------------------------

class OrderIn(BaseModel):
    order_no: Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$")]
    product_id: int
    machine_id: int
    target_qty: int = Field(gt=0, le=100_000_000)


class OrderPatch(BaseModel):
    product_id: int | None = None
    machine_id: int | None = None
    target_qty: int | None = Field(default=None, gt=0, le=100_000_000)


_ORDER_SELECT = """
SELECT o.id, o.order_no, o.product_id, p.code AS product_code, p.name AS product_name,
       o.machine_id, m.code AS machine_code, m.name AS machine_name, m.scrap_source,
       o.target_qty, o.status, o.created_at, o.started_at, o.ended_at, u.username AS created_by,
       r.ideal_cycle_seconds
FROM dbo.production_orders o
JOIN dbo.products p ON p.id = o.product_id
JOIN dbo.machines m ON m.id = o.machine_id
LEFT JOIN dbo.users u ON u.id = o.created_by
LEFT JOIN dbo.product_machine_rates r ON r.product_id = o.product_id AND r.machine_id = o.machine_id
"""

# İş emrinin çalıştığı aralıklardaki adetler (dakika kovası başlangıcı aralık içindeyse sayılır)
_PRODUCED = """
SELECT r.production_order_id AS id,
       SUM(CASE WHEN d.role = 'total_count' THEN d.delta ELSE 0 END) AS total,
       SUM(CASE WHEN d.role = 'scrap_count' THEN d.delta ELSE 0 END) AS plc_scrap
FROM dbo.production_order_runs r
JOIN dbo.counter_deltas_1m d ON d.machine_id = r.machine_id AND d.bucket_ts >= r.start_ts
     AND d.bucket_ts < ISNULL(r.end_ts, SYSUTCDATETIME())
WHERE r.production_order_id IN ({ids})
GROUP BY r.production_order_id
"""


def _with_progress(conn: pymssql.Connection, orders: list[dict]) -> list[dict]:
    if not orders:
        return []
    ids = ", ".join(str(int(o["id"])) for o in orders)
    produced = {r["id"]: r for r in fetch_all(conn, _PRODUCED.format(ids=ids))}
    manual = {r["id"]: r["qty"] for r in fetch_all(conn, f"""
        SELECT production_order_id AS id, SUM(qty) AS qty FROM dbo.manual_scrap_entries
        WHERE production_order_id IN ({ids}) GROUP BY production_order_id""")}
    for o in orders:
        p = produced.get(o["id"], {})
        total = int(p.get("total") or 0)
        scrap = int(p.get("plc_scrap") or 0) if o.pop("scrap_source") == "plc" else int(manual.get(o["id"]) or 0)
        good = max(total - min(scrap, total), 0)
        ideal = o.pop("ideal_cycle_seconds")
        o.update({
            "produced_qty": total, "scrap_qty": min(scrap, total), "good_qty": good,
            "progress": round(good / o["target_qty"], 4),
            "ideal_cycle_seconds": float(ideal) if ideal is not None else None,
            # Kalan iyi adet ideal hızda ne kadar sürer (tahmini; duruş/hız kaybı hariç)
            "remaining_ideal_seconds": round(max(o["target_qty"] - good, 0) * float(ideal)) if ideal is not None else None,
            "created_at": iso(o["created_at"]), "started_at": iso(o["started_at"]), "ended_at": iso(o["ended_at"]),
        })
    return orders


def _order(conn: pymssql.Connection, order_id: int) -> dict:
    rows = fetch_all(conn, _ORDER_SELECT + " WHERE o.id = %s", (order_id,))
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "İş emri bulunamadı")
    return _with_progress(conn, rows)[0]


@router.get("/production-orders", dependencies=[Depends(any_user)])
def list_orders(machine_id: int | None = None, status_: list[OrderStatus] | None = Query(default=None, alias="status"),
                limit: int = Query(default=200, ge=1, le=1000), conn: pymssql.Connection = Depends(get_db)) -> list[dict]:
    where, params = [], []
    if machine_id is not None:
        where.append("o.machine_id = %s")
        params.append(machine_id)
    if status_:
        where.append(f"o.status IN ({', '.join(['%s'] * len(status_))})")
        params.extend(status_)
    sql = _ORDER_SELECT + (" WHERE " + " AND ".join(where) if where else "") + \
        " ORDER BY CASE o.status WHEN 'running' THEN 0 WHEN 'paused' THEN 1 WHEN 'planned' THEN 2 ELSE 3 END, o.created_at DESC"
    sql = sql.replace("SELECT o.id", f"SELECT TOP ({limit}) o.id", 1)
    return _with_progress(conn, fetch_all(conn, sql, tuple(params)))


@router.get("/production-orders/{order_id}", dependencies=[Depends(any_user)])
def get_order(order_id: int, conn: pymssql.Connection = Depends(get_db)) -> dict:
    order = _order(conn, order_id)
    order["runs"] = [{"from": iso(r["start_ts"]), "to": iso(r["end_ts"])} for r in fetch_all(
        conn, "SELECT start_ts, end_ts FROM dbo.production_order_runs WHERE production_order_id = %s ORDER BY start_ts", (order_id,))]
    return order


@router.post("/production-orders", status_code=201)
def create_order(body: OrderIn, user: TokenUser = Depends(can_operate), conn: pymssql.Connection = Depends(get_db)) -> dict:
    row = fetch_one(conn, """
        INSERT INTO dbo.production_orders (order_no, product_id, machine_id, target_qty, created_by)
        OUTPUT inserted.id VALUES (%s, %s, %s, %s, %s)""", (body.order_no, body.product_id, body.machine_id, body.target_qty, user.id))
    conn.commit()
    return _order(conn, row["id"])


@router.patch("/production-orders/{order_id}", dependencies=[Depends(can_operate)])
def update_order(order_id: int, body: OrderPatch, conn: pymssql.Connection = Depends(get_db)) -> dict:
    order = _order(conn, order_id)
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    if not changes:
        return order
    if order["status"] != "planned" and ({"product_id", "machine_id"} & changes.keys()):
        raise HTTPException(status.HTTP_409_CONFLICT, "Başlamış bir iş emrinin ürünü veya makinesi değiştirilemez")
    if order["status"] in ("done", "cancelled"):
        raise HTTPException(status.HTTP_409_CONFLICT, "Kapanmış iş emri düzenlenemez")
    sets = ", ".join(f"{k} = %({k})s" for k in changes)
    execute(conn, f"UPDATE dbo.production_orders SET {sets} WHERE id = %(id)s", {**changes, "id": order_id})
    conn.commit()
    return _order(conn, order_id)


def _close_run(conn: pymssql.Connection, order_id: int, now: datetime) -> None:
    execute(conn, "UPDATE dbo.production_order_runs SET end_ts = %s WHERE production_order_id = %s AND end_ts IS NULL", (now, order_id))


@router.post("/production-orders/{order_id}/start", dependencies=[Depends(can_operate)])
def start_order(order_id: int, conn: pymssql.Connection = Depends(get_db)) -> dict:
    """Planlanmış veya duraklatılmış iş emrini makinede başlatır."""
    order = _order(conn, order_id)
    if order["status"] not in ("planned", "paused"):
        raise HTTPException(status.HTTP_409_CONFLICT, f'"{order["status"]}" durumundaki iş emri başlatılamaz')
    running = fetch_one(conn, "SELECT order_no FROM dbo.production_orders WHERE machine_id = %s AND status = 'running'", (order["machine_id"],))
    if running:
        raise HTTPException(status.HTTP_409_CONFLICT, f'Makinede çalışan iş emri var: {running["order_no"]}. Önce onu duraklatın veya tamamlayın.')
    now = utcnow()
    execute(conn, """UPDATE dbo.production_orders SET status = 'running', started_at = ISNULL(started_at, %s)
                     WHERE id = %s AND status IN ('planned', 'paused')""", (now, order_id))
    execute(conn, "INSERT INTO dbo.production_order_runs (production_order_id, machine_id, start_ts) VALUES (%s, %s, %s)",
            (order_id, order["machine_id"], now))
    conn.commit()
    return _order(conn, order_id)


@router.post("/production-orders/{order_id}/pause", dependencies=[Depends(can_operate)])
def pause_order(order_id: int, conn: pymssql.Connection = Depends(get_db)) -> dict:
    order = _order(conn, order_id)
    if order["status"] != "running":
        raise HTTPException(status.HTTP_409_CONFLICT, "Yalnızca çalışan iş emri duraklatılabilir")
    _close_run(conn, order_id, utcnow())
    execute(conn, "UPDATE dbo.production_orders SET status = 'paused' WHERE id = %s", (order_id,))
    conn.commit()
    return _order(conn, order_id)


@router.post("/production-orders/{order_id}/complete", dependencies=[Depends(can_operate)])
def complete_order(order_id: int, conn: pymssql.Connection = Depends(get_db)) -> dict:
    order = _order(conn, order_id)
    if order["status"] not in ("running", "paused"):
        raise HTTPException(status.HTTP_409_CONFLICT, "Yalnızca başlamış iş emri tamamlanabilir")
    now = utcnow()
    _close_run(conn, order_id, now)
    execute(conn, "UPDATE dbo.production_orders SET status = 'done', ended_at = %s WHERE id = %s", (now, order_id))
    conn.commit()
    return _order(conn, order_id)


@router.post("/production-orders/{order_id}/cancel", dependencies=[Depends(can_operate)])
def cancel_order(order_id: int, conn: pymssql.Connection = Depends(get_db)) -> dict:
    order = _order(conn, order_id)
    if order["status"] not in ("planned", "paused"):
        raise HTTPException(status.HTTP_409_CONFLICT, "Yalnızca planlanmış veya duraklatılmış iş emri iptal edilebilir")
    execute(conn, "UPDATE dbo.production_orders SET status = 'cancelled', ended_at = %s WHERE id = %s", (utcnow(), order_id))
    conn.commit()
    return _order(conn, order_id)


# --- Duruşlar ------------------------------------------------------------------------

class DowntimeAssign(BaseModel):
    reason_id: int | None = Field(description="null → nedeni kaldır")
    note: str | None = Field(default=None, max_length=500)


_DOWNTIME_SELECT = """
SELECT d.id, d.machine_id, m.code AS machine_code, m.name AS machine_name, m.line_id,
       d.start_ts, d.end_ts, DATEDIFF(second, d.start_ts, ISNULL(d.end_ts, SYSUTCDATETIME())) AS duration_seconds,
       d.reason_id, dr.code AS reason_code, dr.name AS reason_name, dr.category,
       d.note, u.username AS assigned_by, d.assigned_at
FROM dbo.downtime_logs d
JOIN dbo.machines m ON m.id = d.machine_id
LEFT JOIN dbo.downtime_reasons dr ON dr.id = d.reason_id
LEFT JOIN dbo.users u ON u.id = d.assigned_by
"""


def _fmt_downtime(r: dict) -> dict:
    return {**r, "start_ts": iso(r["start_ts"]), "end_ts": iso(r["end_ts"]), "assigned_at": iso(r["assigned_at"]),
            "open": r["end_ts"] is None, "category": r["category"] or "unassigned"}


@router.get("/downtimes", dependencies=[Depends(any_user)])
def list_downtimes(machine_id: int | None = None, line_id: int | None = None, unassigned: bool = False,
                   from_: str | None = Query(default=None, alias="from"), to: str | None = None,
                   limit: int = Query(default=200, ge=1, le=2000), conn: pymssql.Connection = Depends(get_db)) -> list[dict]:
    where, params = [], []
    if machine_id is not None:
        where.append("d.machine_id = %s")
        params.append(machine_id)
    if line_id is not None:
        where.append("m.line_id = %s")
        params.append(line_id)
    if unassigned:
        where.append("d.reason_id IS NULL")
    if from_:
        where.append("(d.end_ts IS NULL OR d.end_ts > %s)")
        params.append(parse_ts(from_))
    if to:
        where.append("d.start_ts < %s")
        params.append(parse_ts(to))
    sql = _DOWNTIME_SELECT.replace("SELECT d.id", f"SELECT TOP ({limit}) d.id", 1) + \
        (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY d.start_ts DESC"
    return [_fmt_downtime(r) for r in fetch_all(conn, sql, tuple(params))]


@router.patch("/downtimes/{downtime_id}")
def assign_downtime(downtime_id: int, body: DowntimeAssign, user: TokenUser = Depends(can_operate),
                    conn: pymssql.Connection = Depends(get_db)) -> dict:
    if fetch_one(conn, "SELECT id FROM dbo.downtime_logs WHERE id = %s", (downtime_id,)) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Duruş kaydı bulunamadı")
    if body.reason_id is not None:
        reason = fetch_one(conn, "SELECT is_active FROM dbo.downtime_reasons WHERE id = %s", (body.reason_id,))
        if reason is None or not reason["is_active"]:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Duruş nedeni bulunamadı veya pasif")
    execute(conn, """
        UPDATE dbo.downtime_logs SET reason_id = %s, note = %s,
               assigned_by = %s, assigned_at = SYSUTCDATETIME()
        WHERE id = %s""", (body.reason_id, body.note, user.id if body.reason_id is not None else None, downtime_id))
    conn.commit()
    return _fmt_downtime(fetch_one(conn, _DOWNTIME_SELECT + " WHERE d.id = %s", (downtime_id,)))


# --- Manuel hurda -----------------------------------------------------------------------

class ScrapIn(BaseModel):
    machine_id: int
    qty: int = Field(gt=0, le=1_000_000)
    reason: str | None = Field(default=None, max_length=200)
    ts: str | None = Field(default=None, description="ISO-8601; boşsa şimdi")
    production_order_id: int | None = Field(default=None, description="boşsa makinede çalışan iş emri")


@router.post("/scrap", status_code=201)
def add_scrap(body: ScrapIn, user: TokenUser = Depends(can_operate), conn: pymssql.Connection = Depends(get_db)) -> dict:
    now = utcnow()
    ts = parse_ts(body.ts) if body.ts else now
    if ts > now + timedelta(minutes=5) or ts < now - timedelta(days=7):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Hurda zamanı son 7 gün içinde olmalı")
    order_id = body.production_order_id
    if order_id is None:
        running = fetch_one(conn, "SELECT id FROM dbo.production_orders WHERE machine_id = %s AND status = 'running'", (body.machine_id,))
        order_id = running["id"] if running else None
    row = fetch_one(conn, """
        INSERT INTO dbo.manual_scrap_entries (machine_id, production_order_id, ts, qty, reason, entered_by)
        OUTPUT inserted.id, inserted.machine_id, inserted.production_order_id, inserted.ts, inserted.qty, inserted.reason
        VALUES (%s, %s, %s, %s, %s, %s)""", (body.machine_id, order_id, ts, body.qty, body.reason, user.id))
    conn.commit()
    return {**row, "ts": iso(row["ts"])}


@router.get("/scrap", dependencies=[Depends(any_user)])
def list_scrap(machine_id: int | None = None, limit: int = Query(default=200, ge=1, le=2000),
               conn: pymssql.Connection = Depends(get_db)) -> list[dict]:
    where, params = ("WHERE s.machine_id = %s", (machine_id,)) if machine_id is not None else ("", ())
    rows = fetch_all(conn, f"""
        SELECT TOP ({limit}) s.id, s.machine_id, m.code AS machine_code, s.production_order_id, o.order_no,
               s.ts, s.qty, s.reason, u.username AS entered_by
        FROM dbo.manual_scrap_entries s JOIN dbo.machines m ON m.id = s.machine_id
        LEFT JOIN dbo.production_orders o ON o.id = s.production_order_id
        LEFT JOIN dbo.users u ON u.id = s.entered_by {where} ORDER BY s.ts DESC""", params)
    return [{**r, "ts": iso(r["ts"])} for r in rows]


@router.delete("/scrap/{entry_id}", status_code=204, dependencies=[Depends(can_configure)])
def delete_scrap(entry_id: int, conn: pymssql.Connection = Depends(get_db)) -> Response:
    if execute(conn, "DELETE FROM dbo.manual_scrap_entries WHERE id = %s", (entry_id,)) == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Hurda kaydı bulunamadı")
    conn.commit()
    return Response(status_code=204)


# --- Operatör ekranı ------------------------------------------------------------------------

@router.get("/operator/machines/{machine_id}", dependencies=[Depends(any_user)])
def operator_view(machine_id: int, conn: pymssql.Connection = Depends(get_db)) -> dict:
    """Operatör ekranı için tek çağrı: aktif iş emri, sıradaki iş emirleri, nedeni atanmamış duruşlar."""
    machine = fetch_one(conn, "SELECT id, code, name, scrap_source FROM dbo.machines WHERE id = %s", (machine_id,))
    if machine is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Makine bulunamadı")
    orders = list_orders(machine_id=machine_id, status_=["running", "paused", "planned"], limit=20, conn=conn)
    since = utcnow() - timedelta(hours=24)
    downtimes = [_fmt_downtime(r) for r in fetch_all(conn, _DOWNTIME_SELECT + """
        WHERE d.machine_id = %s AND d.reason_id IS NULL AND (d.end_ts IS NULL OR d.end_ts > %s) ORDER BY d.start_ts DESC""",
        (machine_id, since))]
    return {
        "machine": machine,
        "active_order": next((o for o in orders if o["status"] == "running"), None),
        "queue": [o for o in orders if o["status"] in ("paused", "planned")],
        "unassigned_downtimes": downtimes,
    }
