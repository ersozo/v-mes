"""MES Analitik ve Konfigürasyon API'si."""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware

from mes_api import errors
from mes_api.db import connect, fetch_one
from mes_api.deps import auth_settings, db_settings
from mes_api.routers import auth, definitions, flows, hierarchy, operations, reports, users
from mes_api.security import hash_password, validate_password_strength

log = logging.getLogger("mes_api")


def bootstrap_admin() -> None:
    """Hiç kullanıcı yoksa ADMIN_USERNAME / ADMIN_PASSWORD ile ilk admin hesabını oluşturur."""
    username = os.environ.get("ADMIN_USERNAME")
    password = os.environ.get("ADMIN_PASSWORD")
    with connect(db_settings()) as conn:
        row = fetch_one(conn, "SELECT COUNT(*) AS n FROM dbo.users")
        if row and row["n"] > 0:
            return
        if not username or not password:
            log.warning("Sistemde kullanıcı yok ve ADMIN_USERNAME/ADMIN_PASSWORD tanımlı değil; giriş yapılamaz")
            return
        validate_password_strength(password)
        with conn.cursor() as cur:
            cur.execute("INSERT INTO dbo.users (username, display_name, role, password_hash) VALUES (%s, %s, 'admin', %s)",
                        (username, "Yönetici", hash_password(password)))
        conn.commit()
        log.warning("İlk admin hesabı oluşturuldu: %s", username)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    auth_settings()  # yapılandırma hatalarını açılışta yakala
    bootstrap_admin()
    yield


app = FastAPI(title="V-MES API", version="0.1.0", lifespan=lifespan,
              docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)

origins = [o for o in os.environ.get("CORS_ORIGIN", "").split(",") if o and o != "*"]
if origins:
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=True,
                       allow_methods=["*"], allow_headers=["*"])

errors.install(app)
for r in (auth.router, users.router, hierarchy.router, definitions.router, flows.router, operations.router, reports.router):
    app.include_router(r)


@app.get("/health", tags=["health"])
def health(response: Response) -> dict:
    try:
        with connect(db_settings()) as conn:
            fetch_one(conn, "SELECT 1 AS ok")
        return {"status": "ok"}
    except Exception as exc:
        response.status_code = 503
        return {"status": "degraded", "db": str(exc)[:200]}
