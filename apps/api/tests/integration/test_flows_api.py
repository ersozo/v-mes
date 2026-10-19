"""Akış uç noktaları — Node-RED sahte bir istemciyle değiştirilir (geliştirme Node-RED'ine dokunulmaz)."""

import pytest

from mes_api.flows import nodered
from mes_api.flows import service


class FakeNodeRed:
    flows: list[dict] = [{"id": "user-tab", "type": "tab", "label": "Kullanıcı sekmesi"}]
    rev = "rev-1"
    conflict = False

    def __init__(self, *_args, **_kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def get_flows(self):
        return [{k: v for k, v in n.items() if k != "credentials"} for n in FakeNodeRed.flows], FakeNodeRed.rev

    def deploy_flows(self, flows, rev):
        if FakeNodeRed.conflict or rev != FakeNodeRed.rev:
            raise nodered.FlowConflictError("çakışma")
        FakeNodeRed.flows = flows
        FakeNodeRed.rev = f"rev-{int(rev.split('-')[1]) + 1}"
        return FakeNodeRed.rev


@pytest.fixture(autouse=True)
def fake_nodered(monkeypatch):
    monkeypatch.setattr(service, "_admin", lambda edge: FakeNodeRed())
    FakeNodeRed.flows = [{"id": "user-tab", "type": "tab", "label": "Kullanıcı sekmesi"}]
    FakeNodeRed.rev = "rev-1"
    FakeNodeRed.conflict = False


def edge01(payload):
    return next(e for e in payload["edges"] if e["code"] == "edge-01")


def test_preview_deploy_and_idempotency(client, admin):
    p = client.get("/api/flows/preview", headers=admin).json()
    assert p["has_changes"] and "mes-edge-edge-01" in edge01(p)["diff"]["added"]

    d = client.post("/api/flows/deploy", headers=admin).json()
    r = next(x for x in d["results"] if x["code"] == "edge-01")
    assert r["status"] == "deployed" and r["rev"] == "rev-2"
    assert any(n["id"] == "user-tab" for n in FakeNodeRed.flows), "kullanıcı sekmesi korunmalı"

    again = client.post("/api/flows/deploy", headers=admin).json()
    assert next(x for x in again["results"] if x["code"] == "edge-01")["status"] == "unchanged"

    edge_id = next(e["id"] for e in client.get("/api/edges", headers=admin).json() if e["code"] == "edge-01")
    history = client.get(f"/api/flows/deployments?edge_id={edge_id}", headers=admin).json()
    assert history[0]["status"] == "success" and history[0]["deployed_by"] == "admin" and history[0]["edge_code"] == "edge-01"


def test_preview_can_include_flow_json(client, admin):
    p = client.get("/api/flows/preview?include_flows=true", headers=admin).json()
    assert any(n["type"] == "s7 endpoint" for n in edge01(p)["flows"])


def test_conflict_is_reported_per_edge(client, admin):
    FakeNodeRed.conflict = True
    r = client.post("/api/flows/deploy", headers=admin).json()
    assert next(x for x in r["results"] if x["code"] == "edge-01")["status"] == "conflict"


def test_machine_without_plc_config_is_warned(client, admin):
    line = client.get("/api/lines", headers=admin).json()[0]
    client.post("/api/machines", headers=admin, json={"line_id": line["id"], "code": "plcsiz-makine", "name": "PLC'siz"})
    warnings = client.get("/api/flows/preview", headers=admin).json()["warnings"]
    assert any("plcsiz-makine" in w for w in warnings)
