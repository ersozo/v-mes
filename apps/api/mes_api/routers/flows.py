"""Node-RED akış önizleme ve deploy (ARCHITECTURE.md §7)."""

from __future__ import annotations

import json
from functools import lru_cache

import pymssql
from fastapi import APIRouter, Depends, HTTPException, status

from mes_api.db import execute, fetch_all
from mes_api.deps import can_configure, get_db
from mes_api.flows.generator import build_managed_flows, diff_managed, merge_into_existing
from mes_api.flows.nodered import FlowConflictError, NodeRedAdmin, NodeRedError
from mes_api.flows.repository import load_line_specs
from mes_api.oee.window import iso
from mes_api.security import TokenUser
from mes_api.settings import NodeRedSettings, edge_id

router = APIRouter(prefix="/api/flows", tags=["flows"])


@lru_cache
def nodered_settings() -> NodeRedSettings:
    return NodeRedSettings.from_env()


def _warnings(conn: pymssql.Connection, edge: str) -> list[str]:
    warnings = [
        f'"{r["code"]}" makinesinin PLC konfigürasyonu yok; akışa eklenmedi'
        for r in fetch_all(conn, """
            SELECT m.code FROM dbo.machines m LEFT JOIN dbo.machine_plc_configs c ON c.machine_id = m.id
            WHERE m.is_active = 1 AND c.machine_id IS NULL ORDER BY m.code""")
    ]
    warnings += [
        f'"{r["name"]}" hattı "{r["edge_id"]}" edge\'ine atanmış; bu Node-RED ({edge}) tarafından yönetilmiyor'
        for r in fetch_all(conn, "SELECT name, edge_id FROM dbo.lines WHERE edge_id <> %s ORDER BY name", (edge,))
    ]
    return warnings


def _plan(conn: pymssql.Connection) -> tuple[list[dict], list[dict], str, dict, list[str]]:
    edge = edge_id()
    managed = build_managed_flows(load_line_specs(conn), edge)
    try:
        with NodeRedAdmin(nodered_settings()) as nr:
            existing, rev = nr.get_flows()
    except NodeRedError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc))
    except Exception as exc:  # bağlantı hataları
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Node-RED'e ulaşılamadı: {exc}")
    diff = diff_managed(existing, managed)
    return managed, existing, rev, diff.as_dict() | {"has_changes": diff.has_changes}, _warnings(conn, edge)


@router.get("/preview", dependencies=[Depends(can_configure)])
def preview(include_flows: bool = False, conn: pymssql.Connection = Depends(get_db)) -> dict:
    managed, _, rev, diff, warnings = _plan(conn)
    result = {"edge_id": edge_id(), "rev": rev, "diff": diff, "warnings": warnings,
              "node_count": len(managed)}
    if include_flows:
        result["flows"] = managed
    return result


@router.post("/deploy")
def deploy(user: TokenUser = Depends(can_configure), conn: pymssql.Connection = Depends(get_db)) -> dict:
    managed, existing, rev, diff, warnings = _plan(conn)
    if not diff["has_changes"]:
        return {"status": "unchanged", "diff": diff, "warnings": warnings}

    summary = {"edge_id": edge_id(), "diff": diff, "warnings": warnings}
    try:
        with NodeRedAdmin(nodered_settings()) as nr:
            new_rev = nr.deploy_flows(merge_into_existing(existing, managed), rev)
    except FlowConflictError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc))
    except Exception as exc:
        execute(conn, "INSERT INTO dbo.flow_deployments (deployed_by, status, summary_json, error) VALUES (%s, 'failed', %s, %s)",
                (user.id, json.dumps(summary, ensure_ascii=False), str(exc)[:4000]))
        conn.commit()
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Deploy başarısız: {exc}")

    execute(conn, "INSERT INTO dbo.flow_deployments (deployed_by, status, summary_json) VALUES (%s, 'success', %s)",
            (user.id, json.dumps(summary | {"rev": new_rev}, ensure_ascii=False)))
    conn.commit()
    return {"status": "deployed", "rev": new_rev, "diff": diff, "warnings": warnings}


@router.get("/deployments", dependencies=[Depends(can_configure)])
def deployments(limit: int = 50, conn: pymssql.Connection = Depends(get_db)) -> list[dict]:
    rows = fetch_all(conn, """
        SELECT TOP (%s) d.id, d.deployed_at, d.status, d.summary_json, d.error, u.username AS deployed_by
        FROM dbo.flow_deployments d LEFT JOIN dbo.users u ON u.id = d.deployed_by
        ORDER BY d.id DESC""", (max(1, min(limit, 500)),))
    for r in rows:
        r["summary"] = json.loads(r.pop("summary_json")) if r["summary_json"] else None
        r["deployed_at"] = iso(r["deployed_at"])
    return rows
