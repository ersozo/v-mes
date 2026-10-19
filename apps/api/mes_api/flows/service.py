"""Edge (Node-RED) işlemleri: uyumluluk kontrolü, edge başına akış planı ve dağıtım.

API uç noktaları ve CLI aynı fonksiyonları kullanır. Her edge bağımsızdır: bir edge'e
ulaşılamaması diğerlerinin planlanmasını/dağıtılmasını engellemez.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

import pymssql

from mes_api.db import execute, fetch_all
from mes_api.flows.generator import FlowDiff, MqttOptions, build_managed_flows, diff_managed, merge_into_existing
from mes_api.flows.nodered import FlowConflictError, NodeRedAdmin, NodeRedError
from mes_api.flows.repository import EdgeRow, load_edges, load_line_specs
from mes_api.settings import NodeRedSettings, flow_mqtt_options

SUPPORTED_S7 = ("3.",)   # akış üreticinin doğrulandığı node-red-contrib-s7 ana sürümleri


def _admin(edge: EdgeRow) -> NodeRedAdmin:
    return NodeRedAdmin(NodeRedSettings.for_url(edge.nodered_url))


# --- Kontrol ----------------------------------------------------------------------

def check_edge(edge: EdgeRow, mqtt: MqttOptions | None = None) -> dict:
    """Edge Node-RED uyumluluk kontrolü — hiçbir şey değiştirmez."""
    items: list[dict] = []
    info: dict = {"edge": edge.code, "url": edge.nodered_url}

    def add(status: str, text: str) -> None:
        items.append({"status": status, "text": text})   # ok | warn | error

    try:
        with _admin(edge) as nr:
            auth = nr.auth_required()
            add("ok" if auth else "warn", f"Admin API erişilebilir; kimlik doğrulama {'açık' if auth else 'KAPALI (önerilmez)'}")
            version = nr.get_settings().get("version", "?")
            info["node_red_version"] = version
            add("ok" if version.split(".")[0] in ("3", "4", "5") else "warn", f"Node-RED sürümü {version}")
            nodes = nr.get_nodes()
            s7 = next((n for n in nodes if n.get("module") == "node-red-contrib-s7"), None)
            if s7 is None:
                add("error", "node-red-contrib-s7 yüklü değil (Palette → Install)")
            else:
                info["s7_version"] = s7["version"]
                ok = s7["version"].startswith(SUPPORTED_S7)
                add("ok" if ok else "warn", f"node-red-contrib-s7 {s7['version']}" + ("" if ok else " — akış üretici 3.x ile doğrulandı; uyumluluğu test edin"))
                if not s7.get("enabled", True):
                    add("error", "node-red-contrib-s7 devre dışı")
            mqtt_ok = any(n.get("module") == "node-red" and "mqtt out" in n.get("types", []) for n in nodes)
            add("ok" if mqtt_ok else "error", "MQTT düğümleri (çekirdek)")
            flows, _ = nr.get_flows()
            tabs = [f for f in flows if f.get("type") == "tab"]
            info["tabs"] = [{"label": t.get("label", t["id"]), "managed": str(t["id"]).startswith("mes-")} for t in tabs]
            info["existing_s7_endpoints"] = [
                {"address": e.get("address"), "port": e.get("port"), "rack": e.get("rack"), "slot": e.get("slot"),
                 "cycletime": e.get("cycletime"), "variables": len(e.get("vartable", []))}
                for e in flows if e.get("type") == "s7 endpoint" and not str(e.get("z", "")).startswith("mes-")
            ]
            managed = sum(1 for t in info["tabs"] if t["managed"])
            add("ok", f"{len(tabs)} sekme ({managed} tanesi MES tarafından yönetiliyor; diğerlerine dokunulmaz)")
    except Exception as exc:   # bağlantı/kimlik hataları
        add("error", f"Node-RED'e ulaşılamadı: {exc}")
    try:
        opts = mqtt or flow_mqtt_options()
        target = f"{opts.host}:{opts.port}" if opts.mode == "inline" else f"${{MQTT_HOST}}:{opts.port}"
        add("ok", f"Akışlar MQTT'ye {target} adresinden bağlanacak (mod: {opts.mode}, TLS: {'açık' if opts.tls else 'kapalı'})")
    except ValueError as exc:
        add("error", f"MQTT ayarı: {exc}")
    info["items"] = items
    info["ok"] = not any(i["status"] == "error" for i in items)
    return info


# --- Plan ve dağıtım ----------------------------------------------------------------

@dataclass
class EdgePlan:
    edge: EdgeRow
    managed: list[dict] = field(default_factory=list)
    existing: list[dict] = field(default_factory=list)
    rev: str | None = None
    diff: FlowDiff | None = None
    machine_count: int = 0
    error: str | None = None

    def as_dict(self, include_flows: bool = False) -> dict:
        d = {
            "edge_id": self.edge.id,
            "code": self.edge.code,
            "name": self.edge.name,
            "url": self.edge.nodered_url,
            "machine_count": self.machine_count,
            "error": self.error,
            "rev": self.rev,
            "diff": (self.diff.as_dict() | {"has_changes": self.diff.has_changes}) if self.diff else None,
            "node_count": len(self.managed),
        }
        if include_flows:
            d["flows"] = self.managed
        return d


def warnings(conn: pymssql.Connection) -> list[str]:
    return [
        f'"{r["code"]}" makinesinin PLC konfigürasyonu yok; akışa eklenmedi'
        for r in fetch_all(conn, """
            SELECT m.code FROM dbo.machines m LEFT JOIN dbo.machine_plc_configs c ON c.machine_id = m.id
            WHERE m.is_active = 1 AND c.machine_id IS NULL ORDER BY m.code""")
    ] + [
        f'"{r["code"]}" makinesi pasif bir edge\'e ({r["edge"]}) atanmış; dağıtılmaz'
        for r in fetch_all(conn, """
            SELECT m.code, e.code AS edge FROM dbo.machines m
            JOIN dbo.machine_plc_configs c ON c.machine_id = m.id JOIN dbo.edges e ON e.id = c.edge_id
            WHERE m.is_active = 1 AND e.is_active = 0 ORDER BY m.code""")
    ]


def plan(conn: pymssql.Connection, edge_id: int | None = None) -> list[EdgePlan]:
    lines = load_line_specs(conn)
    mqtt = flow_mqtt_options()
    plans: list[EdgePlan] = []
    for edge in load_edges(conn):
        if edge_id is not None and edge.id != edge_id:
            continue
        p = EdgePlan(edge=edge, managed=build_managed_flows(lines, edge.code, mqtt))
        p.machine_count = sum(1 for l in lines for m in l.machines if m.edge == edge.code)
        try:
            with _admin(edge) as nr:
                p.existing, p.rev = nr.get_flows()
            p.diff = diff_managed(p.existing, p.managed)
        except Exception as exc:
            p.error = f"Node-RED'e ulaşılamadı: {exc}"
        plans.append(p)
    return plans


def deploy(conn: pymssql.Connection, user_id: int | None, edge_id: int | None = None) -> list[dict]:
    """Değişikliği olan her edge'i ayrı ayrı dağıtır; sonuçları edge başına döner ve geçmişe yazar."""
    results = []
    warn = warnings(conn)
    for p in plan(conn, edge_id):
        base = {"edge_id": p.edge.id, "code": p.edge.code}
        if p.error:
            results.append(base | {"status": "failed", "error": p.error})
            _record(conn, p, user_id, "failed", warn, p.error)
            continue
        if not p.diff or not p.diff.has_changes:
            results.append(base | {"status": "unchanged"})
            continue
        try:
            with _admin(p.edge) as nr:
                new_rev = nr.deploy_flows(merge_into_existing(p.existing, p.managed), p.rev or "")
            results.append(base | {"status": "deployed", "rev": new_rev, "diff": p.diff.as_dict()})
            _record(conn, p, user_id, "success", warn, None, new_rev)
        except FlowConflictError as exc:
            results.append(base | {"status": "conflict", "error": str(exc)})
        except (NodeRedError, Exception) as exc:
            results.append(base | {"status": "failed", "error": str(exc)})
            _record(conn, p, user_id, "failed", warn, str(exc))
    return results


def _record(conn: pymssql.Connection, p: EdgePlan, user_id: int | None, status: str, warn: list[str],
            error: str | None, rev: str | None = None) -> None:
    summary = {"edge": p.edge.code, "diff": p.diff.as_dict() if p.diff else None, "warnings": warn, "rev": rev}
    execute(conn, "INSERT INTO dbo.flow_deployments (deployed_by, edge_id, status, summary_json, error) VALUES (%s, %s, %s, %s, %s)",
            (user_id, p.edge.id, status, json.dumps(summary, ensure_ascii=False), (error or "")[:4000] or None))
    conn.commit()
