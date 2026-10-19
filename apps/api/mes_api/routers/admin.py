"""Yönetim: bakım işlerinin durumu ve elle tetiklenmesi."""

from __future__ import annotations

import pymssql
from fastapi import APIRouter, Depends, HTTPException, status
from starlette.concurrency import run_in_threadpool

from mes_api.db import fetch_all
from mes_api.deps import admin_only, db_settings, get_db
from mes_api.jobs import JOBS, run_job
from mes_api.oee.window import iso

router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(admin_only)])


@router.get("/jobs")
def list_jobs(conn: pymssql.Connection = Depends(get_db)) -> list[dict]:
    runs = {r["job_name"]: r for r in fetch_all(conn, "SELECT * FROM dbo.job_runs")}
    out = []
    for name, job in JOBS.items():
        r = runs.get(name, {})
        out.append({
            "name": name,
            "description": job.description,
            "schedule": f"her {int(job.interval.total_seconds() // 3600)} saatte" if job.interval else "günlük (bakım saatinde)",
            "last_started_at": iso(r.get("last_started_at")),
            "last_finished_at": iso(r.get("last_finished_at")),
            "last_status": r.get("last_status"),
            "last_message": r.get("last_message"),
            "last_duration_ms": r.get("last_duration_ms"),
        })
    return out


@router.post("/jobs/{name}/run")
async def trigger_job(name: str) -> dict:
    if name not in JOBS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Böyle bir iş yok")
    return await run_in_threadpool(run_job, name, db_settings())
