"""Akış uç noktaları — Node-RED sahte bir istemciyle değiştirilir (geliştirme Node-RED'ine dokunulmaz)."""

import pytest

from mes_api.flows import nodered
from mes_api.routers import flows as flows_router


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
    monkeypatch.setattr(flows_router, "NodeRedAdmin", FakeNodeRed)
    monkeypatch.setattr(flows_router, "nodered_settings", lambda: None)
    FakeNodeRed.flows = [{"id": "user-tab", "type": "tab", "label": "Kullanıcı sekmesi"}]
    FakeNodeRed.rev = "rev-1"
    FakeNodeRed.conflict = False


def test_preview_deploy_and_idempotency(client, admin):
    p = client.get("/api/flows/preview", headers=admin).json()
    assert p["diff"]["has_changes"] and "mes-edge-edge-01" in p["diff"]["added"]

    d = client.post("/api/flows/deploy", headers=admin).json()
    assert d["status"] == "deployed" and d["rev"] == "rev-2"
    assert any(n["id"] == "user-tab" for n in FakeNodeRed.flows), "kullanıcı sekmesi korunmalı"

    again = client.post("/api/flows/deploy", headers=admin).json()
    assert again["status"] == "unchanged"

    history = client.get("/api/flows/deployments", headers=admin).json()
    assert history[0]["status"] == "success" and history[0]["deployed_by"] == "admin"


def test_preview_can_include_flow_json(client, admin):
    p = client.get("/api/flows/preview?include_flows=true", headers=admin).json()
    assert any(n["type"] == "s7 endpoint" for n in p["flows"])


def test_conflict_returns_409(client, admin):
    FakeNodeRed.conflict = True
    assert client.post("/api/flows/deploy", headers=admin).status_code == 409


def test_machine_without_plc_config_is_warned(client, admin):
    line = client.get("/api/lines", headers=admin).json()[0]
    client.post("/api/machines", headers=admin, json={"line_id": line["id"], "code": "plcsiz-makine", "name": "PLC'siz"})
    warnings = client.get("/api/flows/preview", headers=admin).json()["warnings"]
    assert any("plcsiz-makine" in w for w in warnings)
