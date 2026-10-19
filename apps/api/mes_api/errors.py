"""Veritabanı kısıtlama ihlallerini anlaşılır HTTP hatalarına çevirir."""

from __future__ import annotations

import pymssql
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


def _message(exc: pymssql.IntegrityError) -> tuple[int, str]:
    code = exc.args[0] if exc.args and isinstance(exc.args[0], int) else None
    text = str(exc.args[1] if len(exc.args) > 1 else exc)
    if code in (2627, 2601):
        return 409, "Bu değere sahip bir kayıt zaten var"
    if code == 547 and "REFERENCE" in text:
        if "DELETE" in text:
            return 409, "Bu kayda bağlı başka kayıtlar olduğu için silinemiyor"
        return 422, "Başvurulan kayıt bulunamadı"
    if code == 547:
        return 422, "Değer, izin verilen aralığın veya kuralların dışında"
    return 409, "Veritabanı kısıtlaması ihlal edildi"


def install(app: FastAPI) -> None:
    @app.exception_handler(pymssql.IntegrityError)
    async def _integrity(_: Request, exc: pymssql.IntegrityError) -> JSONResponse:
        status, detail = _message(exc)
        return JSONResponse(status_code=status, content={"detail": detail})
