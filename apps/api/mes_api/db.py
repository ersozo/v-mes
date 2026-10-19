"""MSSQL erişimi (pymssql senkron çalışır; FastAPI'de DB kullanan endpoint'ler düz `def` olmalıdır)."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import pymssql

from mes_api.settings import DbSettings


@contextmanager
def connect(settings: DbSettings | None = None) -> Iterator[pymssql.Connection]:
    s = settings or DbSettings.from_env()
    conn = pymssql.connect(
        server=s.host, port=str(s.port), user=s.user, password=s.password,
        database=s.database, login_timeout=5, as_dict=True,
    )
    try:
        yield conn
    finally:
        conn.close()


def fetch_all(conn: pymssql.Connection, sql: str, params: tuple | dict | None = None) -> list[dict[str, Any]]:
    with conn.cursor(as_dict=True) as cur:
        cur.execute(sql, params)
        return list(cur.fetchall())


def fetch_one(conn: pymssql.Connection, sql: str, params: tuple | dict | None = None) -> dict[str, Any] | None:
    with conn.cursor(as_dict=True) as cur:
        cur.execute(sql, params)
        return cur.fetchone()


def execute(conn: pymssql.Connection, sql: str, params: tuple | dict | None = None) -> int:
    """Etkilenen satır sayısını döner."""
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.rowcount
