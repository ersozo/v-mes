"""Tanımlar: ürünler ve ideal çevrim süreleri, vardiyalar ve planlı duruşlar, duruş nedenleri, fabrika ayarları."""

from __future__ import annotations

from datetime import time
from decimal import Decimal
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import pymssql
from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field, field_validator, model_validator

from mes_api import crud
from mes_api.db import execute, fetch_all, fetch_one
from mes_api.deps import admin_only, any_user, can_configure, get_db

router = APIRouter(prefix="/api", tags=["definitions"])

Code = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9._-]{0,63}$")]
Name = Annotated[str, Field(min_length=1, max_length=200)]


# --- Ürünler -------------------------------------------------------------------

class ProductIn(BaseModel):
    code: Code
    name: Name
    is_active: bool = True


class ProductPatch(BaseModel):
    name: Name | None = None
    is_active: bool | None = None


class ProductOut(ProductIn):
    id: int


class RateIn(BaseModel):
    machine_id: int
    ideal_cycle_seconds: Decimal = Field(gt=0, max_digits=10, decimal_places=3)


class RateOut(RateIn):
    product_id: int
    machine_code: str


_PRODUCT_COLS = "id, code, name, is_active"


@router.get("/products", response_model=list[ProductOut], dependencies=[Depends(any_user)])
def list_products(conn: pymssql.Connection = Depends(get_db)) -> list[dict]:
    return fetch_all(conn, f"SELECT {_PRODUCT_COLS} FROM dbo.products ORDER BY code")


@router.post("/products", response_model=ProductOut, status_code=201, dependencies=[Depends(can_configure)])
def create_product(body: ProductIn, conn: pymssql.Connection = Depends(get_db)) -> dict:
    new_id = crud.insert(conn, "products", body.model_dump())
    conn.commit()
    return crud.get_or_404(conn, "products", new_id, _PRODUCT_COLS, "Ürün")


@router.patch("/products/{product_id}", response_model=ProductOut, dependencies=[Depends(can_configure)])
def update_product(product_id: int, body: ProductPatch, conn: pymssql.Connection = Depends(get_db)) -> dict:
    crud.get_or_404(conn, "products", product_id, "id", "Ürün")
    crud.update(conn, "products", product_id, body.model_dump(exclude_unset=True, exclude_none=True))
    conn.commit()
    return crud.get_or_404(conn, "products", product_id, _PRODUCT_COLS, "Ürün")


@router.delete("/products/{product_id}", status_code=204, dependencies=[Depends(can_configure)])
def delete_product(product_id: int, conn: pymssql.Connection = Depends(get_db)) -> Response:
    crud.delete(conn, "products", product_id, "Ürün")
    conn.commit()
    return Response(status_code=204)


@router.get("/products/{product_id}/rates", response_model=list[RateOut], dependencies=[Depends(any_user)])
def list_rates(product_id: int, conn: pymssql.Connection = Depends(get_db)) -> list[dict]:
    crud.get_or_404(conn, "products", product_id, "id", "Ürün")
    return fetch_all(conn, """
        SELECT r.product_id, r.machine_id, m.code AS machine_code, r.ideal_cycle_seconds
        FROM dbo.product_machine_rates r JOIN dbo.machines m ON m.id = r.machine_id
        WHERE r.product_id = %s ORDER BY m.code""", (product_id,))


@router.put("/products/{product_id}/rates", response_model=list[RateOut], dependencies=[Depends(can_configure)])
def replace_rates(product_id: int, body: list[RateIn], conn: pymssql.Connection = Depends(get_db)) -> list[dict]:
    """Ürünün tüm makine çevrim sürelerini verilen listeyle değiştirir."""
    crud.get_or_404(conn, "products", product_id, "id", "Ürün")
    if len({r.machine_id for r in body}) != len(body):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Aynı makine birden fazla kez verilmiş")
    execute(conn, "DELETE FROM dbo.product_machine_rates WHERE product_id = %s", (product_id,))
    for r in body:
        execute(conn, "INSERT INTO dbo.product_machine_rates (product_id, machine_id, ideal_cycle_seconds) VALUES (%s, %s, %s)",
                (product_id, r.machine_id, str(r.ideal_cycle_seconds)))
    conn.commit()
    return list_rates(product_id, conn)


# --- Duruş nedenleri ---------------------------------------------------------------

Category = Literal["unplanned", "planned", "changeover"]


class ReasonIn(BaseModel):
    code: Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$")]
    name: Annotated[str, Field(min_length=1, max_length=100)]
    category: Category
    parent_id: int | None = None
    is_active: bool = True
    sort_order: int = 0


class ReasonPatch(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=100)] | None = None
    category: Category | None = None
    parent_id: int | None = None
    is_active: bool | None = None
    sort_order: int | None = None


class ReasonOut(ReasonIn):
    id: int


_REASON_COLS = "id, code, name, category, parent_id, is_active, sort_order"


@router.get("/downtime-reasons", response_model=list[ReasonOut], dependencies=[Depends(any_user)])
def list_reasons(conn: pymssql.Connection = Depends(get_db)) -> list[dict]:
    return fetch_all(conn, f"SELECT {_REASON_COLS} FROM dbo.downtime_reasons ORDER BY sort_order, name")


@router.post("/downtime-reasons", response_model=ReasonOut, status_code=201, dependencies=[Depends(can_configure)])
def create_reason(body: ReasonIn, conn: pymssql.Connection = Depends(get_db)) -> dict:
    new_id = crud.insert(conn, "downtime_reasons", body.model_dump())
    conn.commit()
    return crud.get_or_404(conn, "downtime_reasons", new_id, _REASON_COLS, "Duruş nedeni")


@router.patch("/downtime-reasons/{reason_id}", response_model=ReasonOut, dependencies=[Depends(can_configure)])
def update_reason(reason_id: int, body: ReasonPatch, conn: pymssql.Connection = Depends(get_db)) -> dict:
    crud.get_or_404(conn, "downtime_reasons", reason_id, "id", "Duruş nedeni")
    changes = body.model_dump(exclude_unset=True)
    if changes.get("parent_id") == reason_id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Bir neden kendisinin alt nedeni olamaz")
    crud.update(conn, "downtime_reasons", reason_id, changes)
    conn.commit()
    return crud.get_or_404(conn, "downtime_reasons", reason_id, _REASON_COLS, "Duruş nedeni")


@router.delete("/downtime-reasons/{reason_id}", status_code=204, dependencies=[Depends(can_configure)])
def delete_reason(reason_id: int, conn: pymssql.Connection = Depends(get_db)) -> Response:
    """Duruş kayıtlarında kullanılmış neden silinemez (409); is_active=false yapın."""
    crud.delete(conn, "downtime_reasons", reason_id, "Duruş nedeni")
    conn.commit()
    return Response(status_code=204)


# --- Vardiyalar ------------------------------------------------------------------

class PlannedStopIn(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=50)]
    start_local: time
    duration_minutes: int = Field(ge=1, le=480)


class PlannedStopOut(PlannedStopIn):
    id: int


class ShiftIn(BaseModel):
    """Saatler fabrika yerel saatidir. end_local < start_local ise vardiya gece yarısını aşar.
    days_mask: vardiyanın başladığı günler; bit0 = Pazartesi … bit6 = Pazar."""

    name: Annotated[str, Field(min_length=1, max_length=50)]
    start_local: time
    end_local: time
    days_mask: int = Field(default=127, ge=1, le=127)
    is_active: bool = True
    planned_stops: list[PlannedStopIn] = []

    @model_validator(mode="after")
    def _check(self) -> ShiftIn:
        if self.start_local == self.end_local:
            raise ValueError("vardiya başlangıç ve bitiş saati aynı olamaz")
        length = _minutes_between(self.start_local, self.end_local)
        for stop in self.planned_stops:
            offset = _minutes_between(self.start_local, stop.start_local)
            if offset + stop.duration_minutes > length:
                raise ValueError(f'"{stop.name}" planlı duruşu vardiya süresinin dışına taşıyor')
        return self


class ShiftOut(BaseModel):
    id: int
    name: str
    start_local: time
    end_local: time
    days_mask: int
    is_active: bool
    planned_stops: list[PlannedStopOut]


def _minutes_between(a: time, b: time) -> int:
    """a'dan b'ye ileri yönde dakika (gece yarısını aşabilir)."""
    return ((b.hour * 60 + b.minute) - (a.hour * 60 + a.minute)) % (24 * 60)


def _shifts(conn: pymssql.Connection, shift_id: int | None = None) -> list[dict]:
    where = "WHERE id = %s" if shift_id else ""
    shifts = fetch_all(conn, f"SELECT id, name, start_local, end_local, days_mask, is_active FROM dbo.shift_definitions {where} ORDER BY start_local",
                       (shift_id,) if shift_id else None)
    stops = fetch_all(conn, "SELECT id, shift_definition_id, name, start_local, duration_minutes FROM dbo.planned_stop_definitions ORDER BY start_local")
    for s in shifts:
        s["planned_stops"] = [st for st in stops if st["shift_definition_id"] == s["id"]]
    return shifts


def _save_stops(conn: pymssql.Connection, shift_id: int, stops: list[PlannedStopIn]) -> None:
    execute(conn, "DELETE FROM dbo.planned_stop_definitions WHERE shift_definition_id = %s", (shift_id,))
    for st in stops:
        execute(conn, "INSERT INTO dbo.planned_stop_definitions (shift_definition_id, name, start_local, duration_minutes) VALUES (%s, %s, %s, %s)",
                (shift_id, st.name, st.start_local.isoformat(), st.duration_minutes))


@router.get("/shifts", response_model=list[ShiftOut], dependencies=[Depends(any_user)])
def list_shifts(conn: pymssql.Connection = Depends(get_db)) -> list[dict]:
    return _shifts(conn)


@router.post("/shifts", response_model=ShiftOut, status_code=201, dependencies=[Depends(can_configure)])
def create_shift(body: ShiftIn, conn: pymssql.Connection = Depends(get_db)) -> dict:
    shift_id = crud.insert(conn, "shift_definitions", body.model_dump(mode="json", exclude={"planned_stops"}))
    _save_stops(conn, shift_id, body.planned_stops)
    conn.commit()
    return _shifts(conn, shift_id)[0]


@router.put("/shifts/{shift_id}", response_model=ShiftOut, dependencies=[Depends(can_configure)])
def replace_shift(shift_id: int, body: ShiftIn, conn: pymssql.Connection = Depends(get_db)) -> dict:
    crud.get_or_404(conn, "shift_definitions", shift_id, "id", "Vardiya")
    crud.update(conn, "shift_definitions", shift_id, body.model_dump(mode="json", exclude={"planned_stops"}))
    _save_stops(conn, shift_id, body.planned_stops)
    conn.commit()
    return _shifts(conn, shift_id)[0]


@router.delete("/shifts/{shift_id}", status_code=204, dependencies=[Depends(can_configure)])
def delete_shift(shift_id: int, conn: pymssql.Connection = Depends(get_db)) -> Response:
    crud.delete(conn, "shift_definitions", shift_id, "Vardiya")
    conn.commit()
    return Response(status_code=204)


# --- Fabrika ayarları ----------------------------------------------------------------

def _validate_timezone(v: str) -> str:
    try:
        ZoneInfo(v)
    except (ZoneInfoNotFoundError, ValueError):
        raise ValueError(f'"{v}" geçerli bir IANA saat dilimi değil (ör. Europe/Istanbul)')
    return v


class PlantSettings(BaseModel):
    timezone: str
    min_downtime_seconds: int = Field(ge=0, le=3600)
    raw_retention_days: int = Field(ge=7, le=3650)
    edge_heartbeat_timeout_seconds: int = Field(ge=10, le=600)

    @field_validator("timezone")
    @classmethod
    def _tz(cls, v: str) -> str:
        return _validate_timezone(v)


class PlantSettingsPatch(BaseModel):
    timezone: str | None = None
    min_downtime_seconds: int | None = Field(default=None, ge=0, le=3600)
    raw_retention_days: int | None = Field(default=None, ge=7, le=3650)
    edge_heartbeat_timeout_seconds: int | None = Field(default=None, ge=10, le=600)

    @field_validator("timezone")
    @classmethod
    def _tz(cls, v: str | None) -> str | None:
        return v if v is None else _validate_timezone(v)


def read_settings(conn: pymssql.Connection) -> PlantSettings:
    rows = {r["key"]: r["value"] for r in fetch_all(conn, "SELECT [key], value FROM dbo.plant_settings")}
    return PlantSettings(**{k: rows[k] for k in PlantSettings.model_fields if k in rows})


@router.get("/settings", response_model=PlantSettings, dependencies=[Depends(any_user)])
def get_settings(conn: pymssql.Connection = Depends(get_db)) -> PlantSettings:
    return read_settings(conn)


@router.patch("/settings", response_model=PlantSettings, dependencies=[Depends(admin_only)])
def update_settings(body: PlantSettingsPatch, conn: pymssql.Connection = Depends(get_db)) -> PlantSettings:
    for key, value in body.model_dump(exclude_none=True).items():
        execute(conn, """
            MERGE dbo.plant_settings AS t USING (SELECT %(k)s AS [key]) AS s ON t.[key] = s.[key]
            WHEN MATCHED THEN UPDATE SET value = %(v)s, updated_at = SYSUTCDATETIME()
            WHEN NOT MATCHED THEN INSERT ([key], value) VALUES (%(k)s, %(v)s);""", {"k": key, "v": str(value)})
    conn.commit()
    return read_settings(conn)
