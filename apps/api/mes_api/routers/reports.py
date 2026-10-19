"""OEE ve raporlama uç noktaları. Tüm zamanlar UTC (ISO-8601, "Z") döner; dönem etiketleri fabrika yerel saatidir."""

from __future__ import annotations

import csv
import io
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Literal

import pymssql
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse

from mes_api.db import fetch_all
from mes_api.deps import any_user, get_db
from mes_api.oee import intervals as iv
from mes_api.oee.calendar import planned_windows, shift_instances
from mes_api.oee.engine import OeeResult, compute, periods
from mes_api.oee.repository import MachineInfo, load_machine_data, load_shifts, plant_timezone, resolve_machines
from mes_api.oee.window import iso, resolve_window, utcnow

router = APIRouter(prefix="/api", tags=["reports"], dependencies=[Depends(any_user)])

ScopeT = Literal["plant", "area", "line", "machine"]
GroupBy = Literal["none", "hour", "shift", "day", "week"]
MAX_PERIODS = 1000


class Ctx:
    """Bir rapor isteğinin ortak girdileri."""

    def __init__(self, conn, scope, scope_id, preset, start, end):
        self.conn = conn
        self.tz = plant_timezone(conn)
        self.shifts = load_shifts(conn)
        self.now = utcnow()
        self.start, self.end, self.window_label = resolve_window(preset, start, end, self.tz, self.shifts, self.now)
        self.machines = resolve_machines(conn, scope, scope_id)
        # Vardiya örnekleri, pencereyi aşan vardiyalar için biraz geniş alınır
        self.instances = shift_instances(self.shifts, self.start, self.end, self.tz)
        self.shift_windows, self.planned_stops = planned_windows(self.instances)

    def window_dict(self) -> dict:
        return {"from": iso(self.start), "to": iso(self.end), "label": self.window_label, "timezone": str(self.tz.key)}


def _ctx(conn: pymssql.Connection = Depends(get_db), scope: ScopeT = "plant", id: int | None = None,  # noqa: A002
         preset: str | None = None, from_: str | None = Query(default=None, alias="from"),
         to: str | None = None) -> Ctx:
    return Ctx(conn, scope, id, preset, from_, to)


def _csv(rows: list[dict], filename: str) -> StreamingResponse:
    buf = io.StringIO()
    if rows:
        writer = csv.DictWriter(buf, fieldnames=list(rows[0].keys()), delimiter=";")
        writer.writeheader()
        writer.writerows(rows)
    # Excel'in Türkçe karakterleri doğru açması için UTF-8 BOM
    return StreamingResponse(iter(["﻿" + buf.getvalue()]), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="{filename}"'})


def _flat(d: dict) -> dict:
    out = {}
    for k, v in d.items():
        if isinstance(v, dict):
            out.update({f"{k}_{kk}": vv for kk, vv in v.items()})
        elif not isinstance(v, list):
            out[k] = v
    return out


# --- OEE -------------------------------------------------------------------------

@router.get("/oee")
def oee(ctx: Ctx = Depends(_ctx), group_by: GroupBy = "none", breakdown: Literal["none", "machine", "line"] = "none",
        format: Literal["json", "csv"] = "json") -> object:  # noqa: A002
    """Kapsam için OEE özeti, isteğe bağlı dönem serisi ve makine/hat kırılımı.

    ``group_by=hour&breakdown=machine`` ısı haritası, ``breakdown=machine`` karşılaştırma grafiği içindir.
    """
    plist = periods(ctx.start, ctx.end, group_by, ctx.tz, ctx.instances) if group_by != "none" else []
    if len(plist) > MAX_PERIODS:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"çok fazla dönem ({len(plist)}); daha büyük bir group_by seçin")

    data = load_machine_data(ctx.conn, ctx.machines, ctx.start, ctx.end)

    def calc(m: MachineInfo, start: datetime, end: datetime) -> OeeResult:
        return compute(data[m.id], (start, end), ctx.shift_windows, ctx.planned_stops, ctx.now)

    def total(results: list[OeeResult]) -> OeeResult:
        acc = OeeResult(machine_count=0)
        for r in results:
            acc = acc + r
        return acc

    per_machine = {m.id: calc(m, ctx.start, ctx.end) for m in ctx.machines}
    summary = total(list(per_machine.values()))

    series = []
    for p in plist:
        results = {m.id: calc(m, p.start, p.end) for m in ctx.machines}
        item = {"label": p.label, "from": iso(p.start), "to": iso(p.end), **total(list(results.values())).as_dict()}
        if breakdown == "machine":
            item["machines"] = [{"machine_id": m.id, "code": m.code, **_metrics(results[m.id])} for m in ctx.machines]
        elif breakdown == "line":
            item["lines"] = _by_line(ctx.machines, results)
        series.append(item)

    result: dict = {"window": ctx.window_dict(), "summary": summary.as_dict(), "series": series}
    if breakdown == "machine":
        result["machines"] = [
            {"machine_id": m.id, "code": m.code, "name": m.name, "line_id": m.line_id, "line_name": m.line_name,
             **per_machine[m.id].as_dict()} for m in ctx.machines
        ]
    elif breakdown == "line":
        result["lines"] = _by_line(ctx.machines, per_machine, full=True)

    if format == "csv":
        rows = [{"donem": s["label"], "baslangic": s["from"], "bitis": s["to"], **_flat({k: v for k, v in s.items() if k not in ("label", "from", "to", "machines", "lines")})}
                for s in series] or [{"donem": ctx.window_label, **_flat(result["summary"])}]
        return _csv(rows, "oee.csv")
    return result


def _metrics(r: OeeResult) -> dict:
    d = r.as_dict()
    return {k: d[k] for k in ("availability", "performance", "quality", "oee", "total_count", "planned_seconds", "run_seconds")}


def _by_line(machines: list[MachineInfo], results: dict[int, OeeResult], full: bool = False) -> list[dict]:
    groups: dict[int, list[MachineInfo]] = defaultdict(list)
    for m in machines:
        groups[m.line_id].append(m)
    out = []
    for line_id, ms in groups.items():
        acc = OeeResult(machine_count=0)
        for m in ms:
            acc = acc + results[m.id]
        out.append({"line_id": line_id, "line_name": ms[0].line_name, **(acc.as_dict() if full else _metrics(acc))})
    return out


# --- Duruş Pareto ------------------------------------------------------------------------

@router.get("/reports/downtime-pareto")
def downtime_pareto(ctx: Ctx = Depends(_ctx), planned_only: bool = Query(default=True, description="yalnızca planlı üretim süresi içindeki duruşlar"),
                    format: Literal["json", "csv"] = "json") -> object:  # noqa: A002
    """Duruş nedenlerine göre toplam süre ve adet (azalan sıralı, kümülatif yüzdeyle)."""
    ids = [m.id for m in ctx.machines]
    if not ids:
        return {"window": ctx.window_dict(), "total_seconds": 0, "reasons": []}
    rows = fetch_all(ctx.conn, f"""
        SELECT d.machine_id, d.start_ts, d.end_ts, d.reason_id, dr.code, dr.name, dr.category
        FROM dbo.downtime_logs d LEFT JOIN dbo.downtime_reasons dr ON dr.id = d.reason_id
        WHERE d.machine_id IN ({", ".join(map(str, ids))}) AND d.start_ts < %(end)s AND (d.end_ts IS NULL OR d.end_ts > %(start)s)""",
        {"start": ctx.start, "end": ctx.end})

    scope_windows = iv.intersect(ctx.shift_windows, [(ctx.start, min(ctx.end, ctx.now))]) if planned_only else [(ctx.start, min(ctx.end, ctx.now))]
    agg: dict = {}
    for r in rows:
        clipped = iv.intersect([(r["start_ts"], r["end_ts"] or ctx.now)], scope_windows)
        seconds = iv.total_seconds(clipped)
        if seconds <= 0:
            continue
        key = r["reason_id"]
        item = agg.setdefault(key, {"reason_id": key, "code": r["code"], "name": r["name"] or "Nedeni atanmamış",
                                    "category": r["category"] or "unassigned", "seconds": 0.0, "count": 0})
        item["seconds"] += seconds
        item["count"] += 1

    reasons = sorted(agg.values(), key=lambda x: x["seconds"], reverse=True)
    total_seconds = sum(r["seconds"] for r in reasons)
    cumulative = 0.0
    for r in reasons:
        cumulative += r["seconds"]
        r["seconds"] = round(r["seconds"])
        r["share"] = round(r["seconds"] / total_seconds, 4) if total_seconds else 0
        r["cumulative_share"] = round(cumulative / total_seconds, 4) if total_seconds else 0

    if format == "csv":
        return _csv(reasons, "durus-pareto.csv")
    return {"window": ctx.window_dict(), "total_seconds": round(total_seconds), "reasons": reasons}


# --- Durum zaman çizelgesi -----------------------------------------------------------------

@router.get("/reports/state-timeline")
def state_timeline(ctx: Ctx = Depends(_ctx)) -> dict:
    """Makine başına durum aralıkları (gantt) ve duruş kayıtları; pencereye kırpılmış."""
    ids = [m.id for m in ctx.machines]
    if len(ids) > 50:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "zaman çizelgesi en fazla 50 makine için istenebilir")
    if not ids:
        return {"window": ctx.window_dict(), "machines": [], "shifts": []}
    in_ids = ", ".join(map(str, ids))
    rng = {"start": ctx.start, "end": ctx.end}
    states = fetch_all(ctx.conn, f"""
        SELECT machine_id, state, start_ts, end_ts FROM dbo.machine_state_intervals
        WHERE machine_id IN ({in_ids}) AND start_ts < %(end)s AND (end_ts IS NULL OR end_ts > %(start)s) ORDER BY machine_id, start_ts""", rng)
    downs = fetch_all(ctx.conn, f"""
        SELECT d.id, d.machine_id, d.start_ts, d.end_ts, d.reason_id, dr.name AS reason, dr.category
        FROM dbo.downtime_logs d LEFT JOIN dbo.downtime_reasons dr ON dr.id = d.reason_id
        WHERE d.machine_id IN ({in_ids}) AND d.start_ts < %(end)s AND (d.end_ts IS NULL OR d.end_ts > %(start)s) ORDER BY d.start_ts""", rng)

    end_cap = min(ctx.end, ctx.now)

    def clip(s, e):
        return iso(max(s, ctx.start)), iso(min(e or ctx.now, end_cap))

    out = []
    for m in ctx.machines:
        segs = []
        for s in (x for x in states if x["machine_id"] == m.id):
            a, b = clip(s["start_ts"], s["end_ts"])
            if a < b:
                segs.append({"state": s["state"], "from": a, "to": b, "open": s["end_ts"] is None})
        dts = [{"id": d["id"], "from": clip(d["start_ts"], d["end_ts"])[0], "to": clip(d["start_ts"], d["end_ts"])[1],
                "open": d["end_ts"] is None, "reason_id": d["reason_id"], "reason": d["reason"], "category": d["category"] or "unassigned"}
               for d in downs if d["machine_id"] == m.id]
        out.append({"machine_id": m.id, "code": m.code, "name": m.name, "segments": segs, "downtimes": dts})
    shifts = [{"label": i.label, "from": iso(max(i.start, ctx.start)), "to": iso(min(i.end, ctx.end)),
               "planned_stops": [{"from": iso(a), "to": iso(b)} for a, b in i.planned_stops]} for i in ctx.instances]
    return {"window": ctx.window_dict(), "machines": out, "shifts": shifts}


# --- Üretim --------------------------------------------------------------------------------

@router.get("/reports/production")
def production(ctx: Ctx = Depends(_ctx), group_by: GroupBy = "hour", format: Literal["json", "csv"] = "json") -> object:  # noqa: A002
    """Dönem başına toplam/hurda/iyi adet (planlı süre filtresi olmadan, tüm üretim)."""
    plist = periods(ctx.start, ctx.end, group_by, ctx.tz, ctx.instances)
    if len(plist) > MAX_PERIODS:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "çok fazla dönem; daha büyük bir group_by seçin")
    data = load_machine_data(ctx.conn, ctx.machines, ctx.start, ctx.end)
    rows = []
    for p in plist:
        total = scrap = 0
        for m in ctx.machines:
            d = data[m.id]
            total += sum(c for _, c in d.events_in("total", p.start, p.end))
            scrap += sum(q for _, q in d.events_in("scrap" if d.scrap_source == "plc" else "manual", p.start, p.end))
        scrap = min(scrap, total)
        rows.append({"label": p.label, "from": iso(p.start), "to": iso(p.end), "total_count": total, "scrap_count": scrap, "good_count": total - scrap})
    if format == "csv":
        return _csv(rows, "uretim.csv")
    return {"window": ctx.window_dict(), "series": rows,
            "totals": {k: sum(r[k] for r in rows) for k in ("total_count", "scrap_count", "good_count")}}


# --- Telemetri -------------------------------------------------------------------------------

@router.get("/telemetry")
def telemetry(machine_id: int, tags: str = Query(description="virgülle ayrılmış tag adları"),
              from_: str | None = Query(default=None, alias="from"), to: str | None = None, preset: str | None = None,
              max_points: int = Query(default=2000, ge=10, le=5000), conn: pymssql.Connection = Depends(get_db)) -> dict:
    """Ham telemetri; uzun aralıklarda zaman kovalarına özetlenir (avg/min/max)."""
    tz = plant_timezone(conn)
    start, end, label = resolve_window(preset, from_, to, tz, load_shifts(conn))
    names = [t.strip() for t in tags.split(",") if t.strip()][:20]
    if not names:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "en az bir tag adı verin")
    span = (end - start).total_seconds()
    bucket = max(1, int(span // max_points) + (1 if span % max_points else 0))
    placeholders = ", ".join(["%s"] * len(names))
    rows = fetch_all(conn, f"""
        SELECT tag_name,
               DATEADD(second, (DATEDIFF_BIG(second, %s, ts) / %s) * %s, %s) AS bucket_ts,
               AVG(value) AS avg, MIN(value) AS min, MAX(value) AS max, COUNT(*) AS n
        FROM dbo.machine_telemetry
        WHERE machine_id = %s AND tag_name IN ({placeholders}) AND ts >= %s AND ts < %s
        GROUP BY tag_name, DATEADD(second, (DATEDIFF_BIG(second, %s, ts) / %s) * %s, %s)
        ORDER BY tag_name, bucket_ts""",
        (start, bucket, bucket, start, machine_id, *names, start, end, start, bucket, bucket, start))
    series: dict[str, list] = {n: [] for n in names}
    for r in rows:
        series[r["tag_name"]].append({"ts": iso(r["bucket_ts"]), "avg": r["avg"], "min": r["min"], "max": r["max"], "n": r["n"]})
    return {"window": {"from": iso(start), "to": iso(end), "label": label}, "bucket_seconds": bucket, "series": series}


# --- Canlı vardiya özeti (operatör ekranı / canlı panel) --------------------------------------

@router.get("/oee/live")
def live(conn: pymssql.Connection = Depends(get_db), scope: ScopeT = "plant", id: int | None = None) -> dict:  # noqa: A002
    """Mevcut vardiya için makine başına OEE özeti. Aktif vardiya yoksa bugünün verisi döner."""
    try:
        ctx = Ctx(conn, scope, id, "current_shift", None, None)
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
        ctx = Ctx(conn, scope, id, "today", None, None)
    data = load_machine_data(ctx.conn, ctx.machines, ctx.start, ctx.end)
    machines = []
    acc = OeeResult(machine_count=0)
    for m in ctx.machines:
        r = compute(data[m.id], (ctx.start, ctx.end), ctx.shift_windows, ctx.planned_stops, ctx.now)
        acc = acc + r
        machines.append({"machine_id": m.id, "code": m.code, **_metrics(r), "scrap_count": r.scrap_count})
    return {"window": ctx.window_dict(), "summary": _metrics(acc), "machines": machines}
