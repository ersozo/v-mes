"""Akış üretimi için edge, makine ve PLC konfigürasyonlarını veritabanından okur."""

from __future__ import annotations

import json
from dataclasses import dataclass

import pymssql

from mes_api.db import fetch_all
from mes_api.flows.generator import LineSpec, MachineSpec, TagSpec


@dataclass(frozen=True)
class EdgeRow:
    id: int
    code: str
    name: str
    nodered_url: str
    is_active: bool


_QUERY = """
SELECT l.id AS line_id, l.slug AS line_slug, l.name AS line_name,
       a.slug AS area_slug, e.code AS edge_code,
       m.code, m.name AS machine_name,
       c.host, c.port, c.rack, c.slot, c.poll_ms, c.tags_json
FROM dbo.machines m
JOIN dbo.lines l ON l.id = m.line_id
JOIN dbo.areas a ON a.id = l.area_id
JOIN dbo.machine_plc_configs c ON c.machine_id = m.id
JOIN dbo.edges e ON e.id = c.edge_id
WHERE m.is_active = 1 AND c.protocol = 's7'
ORDER BY l.id, m.code
"""


def load_edges(conn: pymssql.Connection, active_only: bool = True) -> list[EdgeRow]:
    rows = fetch_all(conn, "SELECT id, code, name, nodered_url, is_active FROM dbo.edges"
                     + (" WHERE is_active = 1" if active_only else "") + " ORDER BY code")
    return [EdgeRow(**r) for r in rows]


def load_line_specs(conn: pymssql.Connection) -> list[LineSpec]:
    with conn.cursor(as_dict=True) as cur:
        cur.execute(_QUERY)
        rows = cur.fetchall()

    lines: dict[int, dict] = {}
    for r in rows:
        line = lines.setdefault(
            r["line_id"],
            {"id": r["line_id"], "area_slug": r["area_slug"], "slug": r["line_slug"], "name": r["line_name"], "machines": []},
        )
        tags = tuple(TagSpec(name=t["name"], address=t["address"]) for t in json.loads(r["tags_json"]))
        line["machines"].append(
            MachineSpec(
                code=r["code"], name=r["machine_name"], edge=r["edge_code"], host=r["host"], port=r["port"],
                rack=r["rack"], slot=r["slot"], poll_ms=r["poll_ms"], tags=tags,
            )
        )
    return [LineSpec(**{**l, "machines": tuple(l["machines"])}) for l in lines.values()]
