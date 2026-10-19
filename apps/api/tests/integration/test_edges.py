"""Çoklu edge: makine başına HUBBOX, edge başına bağımsız dağıtım."""

import pytest

from conftest import make_line_and_machine, unique
from mes_api.flows import service

TAGS = [{"name": "total_count", "address": "DB200,WORD966", "role": "total_count"}]


class FakeNR:
    """URL'e göre ayrı Node-RED'ler; 'down' içeren adres erişilemez."""

    stores: dict[str, dict] = {}

    def __init__(self, url):
        self.url = url
        FakeNR.stores.setdefault(url, {"flows": [], "rev": "r0"})

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def get_flows(self):
        if "down" in self.url:
            raise ConnectionError("bağlantı reddedildi")
        st = FakeNR.stores[self.url]
        return [{k: v for k, v in n.items() if k != "credentials"} for n in st["flows"]], st["rev"]

    def deploy_flows(self, flows, rev):
        st = FakeNR.stores[self.url]
        st["flows"], st["rev"] = flows, rev + "+"
        return st["rev"]


@pytest.fixture(autouse=True)
def fake(monkeypatch):
    FakeNR.stores = {}
    monkeypatch.setattr(service, "_admin", lambda edge: FakeNR(edge.nodered_url))


def edge(client, admin, url):
    r = client.post("/api/edges", headers=admin, json={"code": unique("hubbox"), "name": "HUBBOX", "nodered_url": url})
    assert r.status_code == 201, r.text
    return r.json()


def test_edge_crud_and_validation(client, admin, users):
    e = edge(client, admin, "http://10.146.168.19:1880")
    assert e["machine_count"] == 0
    assert client.post("/api/edges", headers=users["operator"], json={"code": "x", "name": "x", "nodered_url": "http://x:1880"}).status_code == 403
    assert client.post("/api/edges", headers=admin, json={"code": "Bad Code", "name": "x", "nodered_url": "http://x:1880"}).status_code == 422
    assert client.post("/api/edges", headers=admin, json={"code": unique("e"), "name": "x", "nodered_url": "ftp://x"}).status_code == 422
    assert client.patch(f"/api/edges/{e['id']}", headers=admin, json={"code": "yeni"}).json()["code"] == e["code"]  # kod değişmez
    assert client.patch(f"/api/edges/{e['id']}", headers=admin, json={"nodered_url": "http://10.146.168.20:1880"}).json()["nodered_url"].endswith(".20:1880")


def test_machine_edge_assignment_and_independent_deploys(client, admin):
    e1 = edge(client, admin, "http://hubbox-a:1880")
    e2 = edge(client, admin, "http://hubbox-down:1880")
    m1 = make_line_and_machine(client, admin, state_source="counter", plc={"host": "192.168.10.1", "edge_id": e1["id"], "tags": TAGS})
    line_id = m1["line_id"]
    m2 = client.post("/api/machines", headers=admin, json={"line_id": line_id, "code": unique("m"), "name": "İkinci", "state_source": "counter",
                                                            "plc": {"host": "192.168.10.1", "edge_id": e2["id"], "tags": TAGS}}).json()
    assert m1["plc"]["edge_code"] == e1["code"] and m2["plc"]["edge_code"] == e2["code"]
    assert {x["code"]: x["machine_count"] for x in client.get("/api/edges", headers=admin).json()}[e1["code"]] == 1

    p = client.get(f"/api/flows/preview", headers=admin).json()
    by_code = {x["code"]: x for x in p["edges"]}
    assert by_code[e1["code"]]["diff"]["has_changes"] and by_code[e1["code"]]["machine_count"] == 1
    assert by_code[e2["code"]]["error"] and e2["code"] in p["unreachable"]

    # Erişilemeyen edge diğerinin dağıtımını engellemez
    results = {r["code"]: r for r in client.post("/api/flows/deploy", headers=admin).json()["results"]}
    assert results[e1["code"]]["status"] == "deployed"
    assert results[e2["code"]]["status"] == "failed"
    deployed = FakeNR.stores["http://hubbox-a:1880"]["flows"]
    endpoints = [n for n in deployed if n["type"] == "s7 endpoint"]
    assert [n["name"].split(" @")[0] for n in endpoints] == [m1["code"]], "edge yalnızca kendi makinesini almalı"

    # Tek edge dağıtımı
    only = client.post(f"/api/flows/deploy?edge_id={e1['id']}", headers=admin).json()["results"]
    assert [r["code"] for r in only] == [e1["code"]] and only[0]["status"] == "unchanged"

    # Makine atanmış edge silinemez
    assert client.delete(f"/api/edges/{e1['id']}", headers=admin).status_code == 409


def test_edge_required_when_multiple_edges(client, admin):
    edge(client, admin, "http://hubbox-b:1880")
    area = client.post("/api/areas", headers=admin, json={"slug": unique("a"), "name": "A"}).json()
    line = client.post("/api/lines", headers=admin, json={"area_id": area["id"], "slug": "h", "name": "H"}).json()
    r = client.post("/api/machines", headers=admin, json={"line_id": line["id"], "code": unique("m"), "name": "x", "state_source": "counter",
                                                           "plc": {"host": "192.168.10.1", "tags": TAGS}})
    assert r.status_code == 422 and "edge" in r.text
