"""ISA-95 hiyerarşisi (alan → hat → makine) ve makine PLC konfigürasyonu."""

from __future__ import annotations

import json
from typing import Annotated, Literal

import pymssql
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from mes_api import crud
from mes_api.db import execute, fetch_all, fetch_one
from mes_api.deps import any_user, can_configure, get_db
from mes_api.plc import TagDefinition, check_required_roles, find_overlapping_tags, validate_tag_list
from mes_api.security import TokenUser

router = APIRouter(prefix="/api", tags=["hierarchy"])

SLUG = r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$"
Slug = Annotated[str, Field(pattern=SLUG)]
Name = Annotated[str, Field(min_length=1, max_length=100)]
HOST = r"^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$"


# --- Alanlar ------------------------------------------------------------------

class AreaIn(BaseModel):
    slug: Slug
    name: Name
    sort_order: int = 0


class AreaPatch(BaseModel):
    slug: Slug | None = None
    name: Name | None = None
    sort_order: int | None = None


class AreaOut(AreaIn):
    id: int


_AREA_COLS = "id, slug, name, sort_order"


@router.get("/areas", response_model=list[AreaOut], dependencies=[Depends(any_user)])
def list_areas(conn: pymssql.Connection = Depends(get_db)) -> list[dict]:
    return fetch_all(conn, f"SELECT {_AREA_COLS} FROM dbo.areas ORDER BY sort_order, name")


@router.post("/areas", response_model=AreaOut, status_code=201, dependencies=[Depends(can_configure)])
def create_area(body: AreaIn, conn: pymssql.Connection = Depends(get_db)) -> dict:
    new_id = crud.insert(conn, "areas", body.model_dump())
    conn.commit()
    return crud.get_or_404(conn, "areas", new_id, _AREA_COLS, "Alan")


@router.patch("/areas/{area_id}", response_model=AreaOut, dependencies=[Depends(can_configure)])
def update_area(area_id: int, body: AreaPatch, conn: pymssql.Connection = Depends(get_db)) -> dict:
    crud.get_or_404(conn, "areas", area_id, "id", "Alan")
    crud.update(conn, "areas", area_id, body.model_dump(exclude_unset=True, exclude_none=True))
    conn.commit()
    return crud.get_or_404(conn, "areas", area_id, _AREA_COLS, "Alan")


@router.delete("/areas/{area_id}", status_code=204, dependencies=[Depends(can_configure)])
def delete_area(area_id: int, conn: pymssql.Connection = Depends(get_db)) -> Response:
    crud.delete(conn, "areas", area_id, "Alan")
    conn.commit()
    return Response(status_code=204)


# --- Hatlar -------------------------------------------------------------------

class LineIn(BaseModel):
    area_id: int
    slug: Slug
    name: Name
    edge_id: Slug = "edge-01"
    sort_order: int = 0


class LinePatch(BaseModel):
    area_id: int | None = None
    slug: Slug | None = None
    name: Name | None = None
    edge_id: Slug | None = None
    sort_order: int | None = None


class LineOut(LineIn):
    id: int


_LINE_COLS = "id, area_id, slug, name, edge_id, sort_order"


@router.get("/lines", response_model=list[LineOut], dependencies=[Depends(any_user)])
def list_lines(area_id: int | None = None, conn: pymssql.Connection = Depends(get_db)) -> list[dict]:
    if area_id is None:
        return fetch_all(conn, f"SELECT {_LINE_COLS} FROM dbo.lines ORDER BY sort_order, name")
    return fetch_all(conn, f"SELECT {_LINE_COLS} FROM dbo.lines WHERE area_id = %s ORDER BY sort_order, name", (area_id,))


@router.post("/lines", response_model=LineOut, status_code=201, dependencies=[Depends(can_configure)])
def create_line(body: LineIn, conn: pymssql.Connection = Depends(get_db)) -> dict:
    new_id = crud.insert(conn, "lines", body.model_dump())
    conn.commit()
    return crud.get_or_404(conn, "lines", new_id, _LINE_COLS, "Hat")


@router.patch("/lines/{line_id}", response_model=LineOut, dependencies=[Depends(can_configure)])
def update_line(line_id: int, body: LinePatch, conn: pymssql.Connection = Depends(get_db)) -> dict:
    crud.get_or_404(conn, "lines", line_id, "id", "Hat")
    crud.update(conn, "lines", line_id, body.model_dump(exclude_unset=True, exclude_none=True))
    conn.commit()
    return crud.get_or_404(conn, "lines", line_id, _LINE_COLS, "Hat")


@router.delete("/lines/{line_id}", status_code=204, dependencies=[Depends(can_configure)])
def delete_line(line_id: int, conn: pymssql.Connection = Depends(get_db)) -> Response:
    crud.delete(conn, "lines", line_id, "Hat")
    conn.commit()
    return Response(status_code=204)


# --- Makineler ------------------------------------------------------------------

StateSource = Literal["tag", "counter"]
ScrapSource = Literal["plc", "manual"]


class PlcConfigIn(BaseModel):
    protocol: Literal["s7"] = "s7"
    host: str = Field(pattern=HOST, max_length=253)
    port: int = Field(default=102, ge=1, le=65535)
    rack: int = Field(default=0, ge=0, le=7)
    slot: int = Field(default=1, ge=0, le=31)
    poll_ms: int = Field(default=1000, ge=100, le=60000)
    tags: list[TagDefinition]

    @field_validator("tags")
    @classmethod
    def _tags(cls, v: list[TagDefinition]) -> list[TagDefinition]:
        return validate_tag_list(v)


class PlcConfigOut(PlcConfigIn):
    updated_at: object
    updated_by: int | None
    warnings: list[str] = []


class MachineIn(BaseModel):
    line_id: int
    code: Slug
    name: Name
    is_active: bool = True
    state_source: StateSource = "tag"
    counter_idle_seconds: int = Field(default=120, ge=5, le=3600)
    scrap_source: ScrapSource = "manual"
    sort_order: int = 0
    plc: PlcConfigIn | None = None


class MachinePatch(BaseModel):
    """Makine kodu (UNS kimliği) sonradan değiştirilemez."""

    model_config = ConfigDict(extra="forbid")

    line_id: int | None = None
    name: Name | None = None
    is_active: bool | None = None
    state_source: StateSource | None = None
    counter_idle_seconds: int | None = Field(default=None, ge=5, le=3600)
    scrap_source: ScrapSource | None = None
    sort_order: int | None = None


class MachineOut(BaseModel):
    id: int
    line_id: int
    code: str
    name: str
    is_active: bool
    state_source: StateSource
    counter_idle_seconds: int
    scrap_source: ScrapSource
    sort_order: int
    has_plc_config: bool
    tag_count: int


class MachineDetail(MachineOut):
    plc: PlcConfigOut | None


_MACHINE_SELECT = """
SELECT m.id, m.line_id, m.code, m.name, m.is_active, m.state_source, m.counter_idle_seconds, m.scrap_source, m.sort_order,
       CAST(CASE WHEN c.machine_id IS NULL THEN 0 ELSE 1 END AS bit) AS has_plc_config,
       ISNULL((SELECT COUNT(*) FROM OPENJSON(c.tags_json)), 0) AS tag_count
FROM dbo.machines m LEFT JOIN dbo.machine_plc_configs c ON c.machine_id = m.id
"""


def _machine(conn: pymssql.Connection, machine_id: int) -> dict:
    row = fetch_one(conn, _MACHINE_SELECT + " WHERE m.id = %s", (machine_id,))
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Makine bulunamadı")
    return row


def _plc(conn: pymssql.Connection, machine_id: int) -> dict | None:
    row = fetch_one(
        conn,
        "SELECT protocol, host, port, rack, slot, poll_ms, tags_json, updated_at, updated_by FROM dbo.machine_plc_configs WHERE machine_id = %s",
        (machine_id,),
    )
    if row is None:
        return None
    tags = [TagDefinition(**t) for t in json.loads(row.pop("tags_json"))]
    overlaps = find_overlapping_tags(tags)
    return {**row, "tags": tags, "warnings": [f'"{a}" ve "{b}" aynı PLC belleğini okuyor' for a, b in overlaps]}


def _require_roles(tags: list[TagDefinition], state_source: str, scrap_source: str) -> None:
    errors = check_required_roles(tags, state_source, scrap_source)
    if errors:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, " ".join(errors))


def _save_plc(conn: pymssql.Connection, machine_id: int, cfg: PlcConfigIn, user_id: int) -> None:
    params = {
        "m": machine_id, "protocol": cfg.protocol, "host": cfg.host, "port": cfg.port, "rack": cfg.rack,
        "slot": cfg.slot, "poll_ms": cfg.poll_ms, "user": user_id,
        "tags": json.dumps([t.model_dump(exclude_none=True) for t in cfg.tags], ensure_ascii=False),
    }
    execute(conn, """
        MERGE dbo.machine_plc_configs AS tgt
        USING (SELECT %(m)s AS machine_id) AS src ON tgt.machine_id = src.machine_id
        WHEN MATCHED THEN UPDATE SET protocol = %(protocol)s, host = %(host)s, port = %(port)s, rack = %(rack)s, slot = %(slot)s,
             poll_ms = %(poll_ms)s, tags_json = %(tags)s, updated_at = SYSUTCDATETIME(), updated_by = %(user)s
        WHEN NOT MATCHED THEN INSERT (machine_id, protocol, host, port, rack, slot, poll_ms, tags_json, updated_by)
             VALUES (%(m)s, %(protocol)s, %(host)s, %(port)s, %(rack)s, %(slot)s, %(poll_ms)s, %(tags)s, %(user)s);""", params)


@router.get("/machines", response_model=list[MachineOut], dependencies=[Depends(any_user)])
def list_machines(line_id: int | None = None, active: bool | None = Query(default=None),
                  conn: pymssql.Connection = Depends(get_db)) -> list[dict]:
    where, params = [], []
    if line_id is not None:
        where.append("m.line_id = %s")
        params.append(line_id)
    if active is not None:
        where.append("m.is_active = %s")
        params.append(active)
    sql = _MACHINE_SELECT + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY m.sort_order, m.code"
    return fetch_all(conn, sql, tuple(params))


@router.get("/machines/{machine_id}", response_model=MachineDetail, dependencies=[Depends(any_user)])
def get_machine(machine_id: int, conn: pymssql.Connection = Depends(get_db)) -> dict:
    return {**_machine(conn, machine_id), "plc": _plc(conn, machine_id)}


@router.post("/machines", response_model=MachineDetail, status_code=201)
def create_machine(body: MachineIn, user: TokenUser = Depends(can_configure), conn: pymssql.Connection = Depends(get_db)) -> dict:
    if body.plc:
        _require_roles(body.plc.tags, body.state_source, body.scrap_source)
    machine_id = crud.insert(conn, "machines", body.model_dump(exclude={"plc"}))
    if body.plc:
        _save_plc(conn, machine_id, body.plc, user.id)
    conn.commit()
    return get_machine(machine_id, conn)


@router.patch("/machines/{machine_id}", response_model=MachineDetail)
def update_machine(machine_id: int, body: MachinePatch, _: TokenUser = Depends(can_configure),
                   conn: pymssql.Connection = Depends(get_db)) -> dict:
    current = _machine(conn, machine_id)
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    plc = _plc(conn, machine_id)
    if plc and ("state_source" in changes or "scrap_source" in changes):
        _require_roles(plc["tags"], changes.get("state_source", current["state_source"]),
                       changes.get("scrap_source", current["scrap_source"]))
    crud.update(conn, "machines", machine_id, changes, touch_updated_at=True)
    conn.commit()
    return get_machine(machine_id, conn)


@router.delete("/machines/{machine_id}", status_code=204, dependencies=[Depends(can_configure)])
def delete_machine(machine_id: int, conn: pymssql.Connection = Depends(get_db)) -> Response:
    """Geçmiş verisi olan makine silinemez (409); bunun yerine is_active=false yapın."""
    _machine(conn, machine_id)
    history = fetch_one(conn, """
        SELECT CASE WHEN EXISTS (SELECT 1 FROM dbo.machine_state_intervals WHERE machine_id = %(m)s)
                      OR EXISTS (SELECT 1 FROM dbo.counter_deltas_1m WHERE machine_id = %(m)s)
                      OR EXISTS (SELECT 1 FROM dbo.machine_telemetry WHERE machine_id = %(m)s)
                    THEN 1 ELSE 0 END AS has_history""", {"m": machine_id})
    if history and history["has_history"]:
        raise HTTPException(status.HTTP_409_CONFLICT, "Makinenin üretim geçmişi var; silmek yerine pasifleştirin")
    execute(conn, "DELETE FROM dbo.counter_state WHERE machine_id = %s", (machine_id,))
    crud.delete(conn, "machines", machine_id, "Makine")
    conn.commit()
    return Response(status_code=204)


@router.get("/machines/{machine_id}/plc", response_model=PlcConfigOut, dependencies=[Depends(any_user)])
def get_plc(machine_id: int, conn: pymssql.Connection = Depends(get_db)) -> dict:
    _machine(conn, machine_id)
    plc = _plc(conn, machine_id)
    if plc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Makinenin PLC konfigürasyonu yok")
    return plc


@router.put("/machines/{machine_id}/plc", response_model=PlcConfigOut)
def put_plc(machine_id: int, body: PlcConfigIn, user: TokenUser = Depends(can_configure),
            conn: pymssql.Connection = Depends(get_db)) -> dict:
    m = _machine(conn, machine_id)
    _require_roles(body.tags, m["state_source"], m["scrap_source"])
    _save_plc(conn, machine_id, body, user.id)
    conn.commit()
    return get_plc(machine_id, conn)


@router.post("/machines/{machine_id}/plc/validate", dependencies=[Depends(can_configure)])
def validate_plc(machine_id: int, body: dict, conn: pymssql.Connection = Depends(get_db)) -> dict:
    """Kaydetmeden doğrular (konfigüratörde anlık geri bildirim için). Hatalar 200 ile döner."""
    m = _machine(conn, machine_id)
    try:
        cfg = PlcConfigIn(**body)
    except ValidationError as exc:
        return {"valid": False, "errors": [
            {"loc": list(e["loc"]), "msg": e["msg"].removeprefix("Value error, ")} for e in exc.errors(include_url=False)
        ], "warnings": []}
    errors = [{"loc": ["tags"], "msg": msg} for msg in check_required_roles(cfg.tags, m["state_source"], m["scrap_source"])]
    warnings = [f'"{a}" ve "{b}" aynı PLC belleğini okuyor' for a, b in find_overlapping_tags(cfg.tags)]
    return {"valid": not errors, "errors": errors, "warnings": warnings,
            "normalized_tags": [t.model_dump(exclude_none=True) for t in cfg.tags]}


# --- Ağaç ----------------------------------------------------------------------

@router.get("/hierarchy", dependencies=[Depends(any_user)])
def hierarchy(conn: pymssql.Connection = Depends(get_db)) -> list[dict]:
    """Alan → hat → makine ağacı (canlı panel ve konfigüratör için)."""
    areas = fetch_all(conn, f"SELECT {_AREA_COLS} FROM dbo.areas ORDER BY sort_order, name")
    lines = fetch_all(conn, f"SELECT {_LINE_COLS} FROM dbo.lines ORDER BY sort_order, name")
    machines = fetch_all(conn, _MACHINE_SELECT + " ORDER BY m.sort_order, m.code")
    by_line: dict[int, list[dict]] = {}
    for m in machines:
        by_line.setdefault(m["line_id"], []).append(m)
    by_area: dict[int, list[dict]] = {}
    for l in lines:
        by_area.setdefault(l["area_id"], []).append({**l, "machines": by_line.get(l["id"], [])})
    return [{**a, "lines": by_area.get(a["id"], [])} for a in areas]
