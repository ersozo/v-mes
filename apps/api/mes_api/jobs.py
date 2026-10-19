"""Zamanlanmış bakım işleri (API süreci içinde).

- telemetry_partitions : saatte bir; gelecek 3 ayın aylık partition'larını garanti eder
- telemetry_purge      : günde bir (bakım saatinde); saklama süresinden eski ham telemetriyi siler
- telemetry_compress   : günde bir; kapanmış columnstore rowgroup'larını sıkıştırır
- auth_cleanup         : günde bir; süresi dolmuş/iptal edilmiş refresh token'ları siler

Birden fazla API örneği çalışırsa işler `sp_getapplock` ile tek örnekte çalışır.
Durum `dbo.job_runs` tablosunda tutulur; `/api/admin/jobs` ile izlenir ve elle tetiklenir.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pymssql

from mes_api.db import connect, fetch_all, fetch_one
from mes_api.settings import DbSettings

log = logging.getLogger("mes_api.jobs")
TICK_SECONDS = 300


@dataclass(frozen=True)
class Job:
    name: str
    description: str
    run: Callable[[pymssql.Connection], str]
    interval: timedelta | None = None     # periyodik
    daily: bool = False                   # bakım saatinde günde bir


def _exec(conn: pymssql.Connection, sql: str, params: tuple = ()) -> list[dict]:
    with conn.cursor(as_dict=True) as cur:
        cur.execute(sql, params)
        rows = cur.fetchall() if cur.description else []
    conn.commit()
    return rows


def _partitions(conn: pymssql.Connection) -> str:
    _exec(conn, "EXEC dbo.usp_telemetry_ensure_partitions @months_ahead = 3")
    row = fetch_one(conn, """
        SELECT COUNT(*) AS n, MAX(CAST(v.value AS datetime2(0))) AS last_boundary
        FROM sys.partition_range_values v JOIN sys.partition_functions f ON f.function_id = v.function_id
        WHERE f.name = 'pf_telemetry_month'""")
    return f"{row['n']} sınır; son sınır {row['last_boundary']:%Y-%m-%d}"


def _purge(conn: pymssql.Connection) -> str:
    row = fetch_one(conn, "SELECT value FROM dbo.plant_settings WHERE [key] = 'raw_retention_days'")
    days = int(row["value"]) if row else 180
    before = fetch_one(conn, "SELECT COUNT_BIG(*) AS n FROM dbo.machine_telemetry")["n"]
    _exec(conn, "EXEC dbo.usp_telemetry_purge @retention_days = %s", (days,))
    after = fetch_one(conn, "SELECT COUNT_BIG(*) AS n FROM dbo.machine_telemetry")["n"]
    return f"saklama {days} gün; {before - after} satır silindi"


def _compress(conn: pymssql.Connection) -> str:
    _exec(conn, "EXEC dbo.usp_telemetry_compress")
    rows = fetch_all(conn, """
        SELECT state_desc, COUNT(*) AS n FROM sys.dm_db_column_store_row_group_physical_stats
        WHERE object_id = OBJECT_ID('dbo.machine_telemetry') GROUP BY state_desc""")
    return ", ".join(f"{r['state_desc'].lower()}: {r['n']}" for r in rows) or "rowgroup yok"


def _auth_cleanup(conn: pymssql.Connection) -> str:
    rows = _exec(conn, "EXEC dbo.usp_auth_cleanup")
    return f"{rows[0]['deleted'] if rows else 0} token silindi"


JOBS: dict[str, Job] = {
    j.name: j
    for j in (
        Job("telemetry_partitions", "Gelecek ayların telemetri partition'larını oluşturur", _partitions, interval=timedelta(hours=1)),
        Job("telemetry_purge", "Saklama süresinden eski ham telemetriyi siler", _purge, daily=True),
        Job("telemetry_compress", "Columnstore rowgroup'larını sıkıştırır", _compress, daily=True),
        Job("auth_cleanup", "Süresi dolmuş oturumları temizler", _auth_cleanup, daily=True),
    )
}


def run_job(name: str, settings: DbSettings | None = None) -> dict:
    """İşi (kilit alarak) çalıştırır ve sonucu döner. Kilit alınamazsa 'skipped'."""
    job = JOBS[name]
    with connect(settings) as conn:
        conn.autocommit(True)
        lock = fetch_one(conn, """
            DECLARE @r int;
            EXEC @r = sp_getapplock @Resource = %s, @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = 0;
            SELECT @r AS r""", (f"mes-job:{name}",))
        if lock is None or lock["r"] < 0:
            return {"job": name, "status": "skipped", "message": "başka bir örnekte çalışıyor"}
        conn.autocommit(False)
        started = datetime.now(UTC).replace(tzinfo=None)
        _upsert(conn, name, started=started, status="running")
        t0 = time.monotonic()
        try:
            message = job.run(conn)
            status = "success"
        except Exception as exc:  # işin hatası diğer işleri durdurmasın
            conn.rollback()
            message, status = str(exc)[:2000], "failed"
            log.exception("bakım işi başarısız: %s", name)
        duration = int((time.monotonic() - t0) * 1000)
        _upsert(conn, name, finished=datetime.now(UTC).replace(tzinfo=None), status=status, message=message, duration=duration)
        log.info("bakım işi %s: %s (%s, %d ms)", name, status, message, duration)
        return {"job": name, "status": status, "message": message, "duration_ms": duration}


def _upsert(conn: pymssql.Connection, name: str, started: datetime | None = None, finished: datetime | None = None,
            status: str | None = None, message: str | None = None, duration: int | None = None) -> None:
    with conn.cursor() as cur:
        cur.execute("""
            MERGE dbo.job_runs AS t USING (SELECT %(n)s AS job_name) AS s ON t.job_name = s.job_name
            WHEN MATCHED THEN UPDATE SET
                last_started_at = ISNULL(%(started)s, t.last_started_at),
                last_finished_at = CASE WHEN %(started)s IS NOT NULL THEN NULL ELSE ISNULL(%(finished)s, t.last_finished_at) END,
                last_status = ISNULL(%(status)s, t.last_status),
                last_message = CASE WHEN %(started)s IS NOT NULL THEN NULL ELSE ISNULL(%(message)s, t.last_message) END,
                last_duration_ms = ISNULL(%(duration)s, t.last_duration_ms)
            WHEN NOT MATCHED THEN INSERT (job_name, last_started_at, last_finished_at, last_status, last_message, last_duration_ms)
                VALUES (%(n)s, %(started)s, %(finished)s, %(status)s, %(message)s, %(duration)s);""",
            {"n": name, "started": started, "finished": finished, "status": status, "message": message, "duration": duration})
    conn.commit()


def due_jobs(now_utc: datetime, last_runs: dict[str, datetime | None], tz: ZoneInfo, maintenance_hour: int) -> list[str]:
    """Şu an çalışması gereken işler (saf; test edilebilir)."""
    due = []
    local = now_utc.replace(tzinfo=UTC).astimezone(tz)
    # Bugünkü bakım anı (yerel); henüz gelmediyse dünkü
    window = local.replace(hour=maintenance_hour, minute=0, second=0, microsecond=0)
    if local < window:
        window -= timedelta(days=1)
    window_utc = window.astimezone(UTC).replace(tzinfo=None)
    for job in JOBS.values():
        last = last_runs.get(job.name)
        if job.interval and (last is None or now_utc - last >= job.interval):
            due.append(job.name)
        elif job.daily and (last is None or last < window_utc):
            due.append(job.name)
    return due


def _schedule_state(settings: DbSettings) -> tuple[dict[str, datetime | None], ZoneInfo, int]:
    with connect(settings) as conn:
        runs = {r["job_name"]: r["last_started_at"] for r in fetch_all(conn, "SELECT job_name, last_started_at FROM dbo.job_runs")}
        cfg = {r["key"]: r["value"] for r in fetch_all(conn, "SELECT [key], value FROM dbo.plant_settings WHERE [key] IN ('timezone', 'maintenance_hour_local')")}
    return runs, ZoneInfo(cfg.get("timezone", "Europe/Istanbul")), int(cfg.get("maintenance_hour_local", "2"))


async def scheduler(settings: DbSettings, stop: asyncio.Event) -> None:
    """Arka planda çalışan döngü. Hata olursa bir sonraki tikte tekrar dener."""
    log.info("bakım zamanlayıcısı başladı")
    while not stop.is_set():
        try:
            runs, tz, hour = await asyncio.to_thread(_schedule_state, settings)
            for name in due_jobs(datetime.now(UTC).replace(tzinfo=None), runs, tz, hour):
                await asyncio.to_thread(run_job, name, settings)
        except Exception:
            log.exception("bakım zamanlayıcısı hatası")
        try:
            await asyncio.wait_for(stop.wait(), timeout=TICK_SECONDS)
        except TimeoutError:
            pass
