"""Node-RED akış önizleme ve dağıtım — edge başına (ARCHITECTURE.md §7)."""

from __future__ import annotations

import json

import pymssql
from fastapi import APIRouter, Depends

from mes_api.db import fetch_all
from mes_api.deps import can_configure, get_db
from mes_api.flows import service
from mes_api.oee.window import iso
from mes_api.security import TokenUser

router = APIRouter(prefix="/api/flows", tags=["flows"])


@router.get("/preview", dependencies=[Depends(can_configure)])
def preview(edge_id: int | None = None, include_flows: bool = False, conn: pymssql.Connection = Depends(get_db)) -> dict:
    plans = service.plan(conn, edge_id)
    edges = [p.as_dict(include_flows) for p in plans]
    return {
        "edges": edges,
        "has_changes": any(e["diff"] and e["diff"]["has_changes"] for e in edges),
        "unreachable": [e["code"] for e in edges if e["error"]],
        "warnings": service.warnings(conn),
    }


@router.post("/deploy")
def deploy(edge_id: int | None = None, user: TokenUser = Depends(can_configure), conn: pymssql.Connection = Depends(get_db)) -> dict:
    results = service.deploy(conn, user.id, edge_id)
    return {"results": results, "warnings": service.warnings(conn)}


@router.get("/deployments", dependencies=[Depends(can_configure)])
def deployments(limit: int = 50, edge_id: int | None = None, conn: pymssql.Connection = Depends(get_db)) -> list[dict]:
    where, params = ("WHERE d.edge_id = %s", (edge_id,)) if edge_id else ("", ())
    rows = fetch_all(conn, f"""
        SELECT TOP ({max(1, min(limit, 500))}) d.id, d.deployed_at, d.status, d.summary_json, d.error,
               u.username AS deployed_by, e.code AS edge_code
        FROM dbo.flow_deployments d LEFT JOIN dbo.users u ON u.id = d.deployed_by LEFT JOIN dbo.edges e ON e.id = d.edge_id
        {where} ORDER BY d.id DESC""", params)
    for r in rows:
        r["summary"] = json.loads(r.pop("summary_json")) if r["summary_json"] else None
        r["deployed_at"] = iso(r["deployed_at"])
    return rows
