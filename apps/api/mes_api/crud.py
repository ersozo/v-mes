"""Basit tablo işlemleri için yardımcılar (tablo/kolon adları yalnızca koddan gelir, kullanıcıdan değil)."""

from __future__ import annotations

from typing import Any

import pymssql
from fastapi import HTTPException, status

from mes_api.db import execute, fetch_one


def get_or_404(conn: pymssql.Connection, table: str, row_id: int, columns: str, label: str) -> dict[str, Any]:
    row = fetch_one(conn, f"SELECT {columns} FROM dbo.{table} WHERE id = %s", (row_id,))
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{label} bulunamadı")
    return row


def insert(conn: pymssql.Connection, table: str, data: dict[str, Any]) -> int:
    cols = ", ".join(data)
    vals = ", ".join(f"%({k})s" for k in data)
    row = fetch_one(conn, f"INSERT INTO dbo.{table} ({cols}) OUTPUT inserted.id VALUES ({vals})", data)
    assert row is not None
    return int(row["id"])


def update(conn: pymssql.Connection, table: str, row_id: int, data: dict[str, Any], touch_updated_at: bool = False) -> None:
    if not data and not touch_updated_at:
        return
    sets = [f"{k} = %({k})s" for k in data]
    if touch_updated_at:
        sets.append("updated_at = SYSUTCDATETIME()")
    execute(conn, f"UPDATE dbo.{table} SET {', '.join(sets)} WHERE id = %(__id)s", {**data, "__id": row_id})


def delete(conn: pymssql.Connection, table: str, row_id: int, label: str) -> None:
    if execute(conn, f"DELETE FROM dbo.{table} WHERE id = %s", (row_id,)) == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{label} bulunamadı")
