"""MSSQL bağlantısı (pymssql senkron çalışır; FastAPI'de düz `def` endpoint'lerden kullanılmalı)."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

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
