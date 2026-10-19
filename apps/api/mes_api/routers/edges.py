"""Edge cihazları (ör. her makinedeki HUBBOX içinde çalışan Node-RED)."""

from __future__ import annotations

from typing import Annotated

import pymssql
from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from mes_api import crud
from mes_api.db import fetch_all
from mes_api.deps import any_user, can_configure, get_db
from mes_api.flows import service
from mes_api.flows.repository import EdgeRow
from mes_api.types import UtcDatetime

router = APIRouter(prefix="/api/edges", tags=["edges"])

Code = Annotated[str, Field(pattern=r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")]
Url = Annotated[str, Field(pattern=r"^https?://[A-Za-z0-9.\-]+(:\d{1,5})?(/.*)?$", max_length=300)]


class EdgeIn(BaseModel):
    code: Code
    name: Annotated[str, Field(min_length=1, max_length=100)]
    nodered_url: Url
    is_active: bool = True
    notes: str | None = Field(default=None, max_length=500)


class EdgePatch(BaseModel):
    """Kod değiştirilemez: heartbeat topic'inde ve Node-RED'deki sekme kimliklerinde kullanılır."""

    name: Annotated[str, Field(min_length=1, max_length=100)] | None = None
    nodered_url: Url | None = None
    is_active: bool | None = None
    notes: str | None = Field(default=None, max_length=500)


class EdgeOut(EdgeIn):
    id: int
    created_at: UtcDatetime
    machine_count: int
    machines: list[str]


_SELECT = """
SELECT e.id, e.code, e.name, e.nodered_url, e.is_active, e.notes, e.created_at,
       (SELECT COUNT(*) FROM dbo.machine_plc_configs c WHERE c.edge_id = e.id) AS machine_count,
       ISNULL((SELECT STRING_AGG(m.code, ',') WITHIN GROUP (ORDER BY m.code)
               FROM dbo.machine_plc_configs c JOIN dbo.machines m ON m.id = c.machine_id WHERE c.edge_id = e.id), '') AS machines
FROM dbo.edges e
"""


def _out(row: dict) -> dict:
    return {**row, "machines": [m for m in row["machines"].split(",") if m]}


def _get(conn: pymssql.Connection, edge_id: int) -> dict:
    rows = fetch_all(conn, _SELECT + " WHERE e.id = %s", (edge_id,))
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Edge bulunamadı")
    return _out(rows[0])


@router.get("", response_model=list[EdgeOut], dependencies=[Depends(any_user)])
def list_edges(conn: pymssql.Connection = Depends(get_db)) -> list[dict]:
    return [_out(r) for r in fetch_all(conn, _SELECT + " ORDER BY e.code")]


@router.post("", response_model=EdgeOut, status_code=201, dependencies=[Depends(can_configure)])
def create_edge(body: EdgeIn, conn: pymssql.Connection = Depends(get_db)) -> dict:
    new_id = crud.insert(conn, "edges", body.model_dump())
    conn.commit()
    return _get(conn, new_id)


@router.patch("/{edge_id}", response_model=EdgeOut, dependencies=[Depends(can_configure)])
def update_edge(edge_id: int, body: EdgePatch, conn: pymssql.Connection = Depends(get_db)) -> dict:
    _get(conn, edge_id)
    crud.update(conn, "edges", edge_id, body.model_dump(exclude_unset=True, exclude_none=True))
    conn.commit()
    return _get(conn, edge_id)


@router.delete("/{edge_id}", status_code=204, dependencies=[Depends(can_configure)])
def delete_edge(edge_id: int, conn: pymssql.Connection = Depends(get_db)) -> Response:
    """Makine atanmış edge silinemez (409); önce makineleri başka edge'e taşıyın veya edge'i pasifleştirin."""
    crud.delete(conn, "edges", edge_id, "Edge")
    conn.commit()
    return Response(status_code=204)


@router.post("/{edge_id}/check", dependencies=[Depends(can_configure)])
async def check(edge_id: int, conn: pymssql.Connection = Depends(get_db)) -> dict:
    """Edge'deki Node-RED'i inceler (salt okunur): erişim, sürümler, S7 paketi, mevcut sekmeler."""
    row = await run_in_threadpool(_get, conn, edge_id)
    edge = EdgeRow(id=row["id"], code=row["code"], name=row["name"], nodered_url=row["nodered_url"], is_active=row["is_active"])
    return await run_in_threadpool(service.check_edge, edge)
