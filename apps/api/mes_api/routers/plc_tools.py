"""PLC yardımcıları: TIA Portal DB tablosundan tag içe aktarma (öneri; kaydetmez)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from starlette.concurrency import run_in_threadpool

from mes_api.deps import can_configure
from mes_api.plc_import import MAX_BYTES, parse_rows, read_text, read_xlsx

router = APIRouter(prefix="/api/plc", tags=["plc"], dependencies=[Depends(can_configure)])


@router.post("/import")
async def import_tags(
    file: UploadFile | None = File(default=None, description="TIA'dan dışa aktarılmış .xlsx veya .csv"),
    text: str | None = Form(default=None, description="DB editöründen kopyalanan satırlar (sekmeyle ayrılmış)"),
    db_number: int | None = Form(default=None, ge=1, le=65535),
) -> dict:
    """Dosyadaki/metindeki satırlardan tag adayları döner. Hiçbir şey kaydedilmez."""
    if file is None and not text:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Bir dosya yükleyin veya metin yapıştırın")
    if file is not None:
        data = await file.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Dosya en fazla 2 MB olabilir")
        name = (file.filename or "").lower()
        try:
            if name.endswith((".xlsx", ".xlsm")) or data[:2] == b"PK":
                rows = await run_in_threadpool(read_xlsx, data)
            else:
                rows = read_text(data.decode("utf-8-sig", errors="replace"))
        except Exception:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Dosya okunamadı; .xlsx veya .csv olmalı")
    else:
        if len(text or "") > MAX_BYTES:
            raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Metin çok uzun")
        rows = read_text(text or "")
    return parse_rows(rows, db_number)
