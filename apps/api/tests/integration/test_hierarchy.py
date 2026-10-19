import pytest

from conftest import unique

TAGS = [
    {"name": "total_count", "address": "db1,di0", "role": "total_count", "unit": "pcs"},
    {"name": "running", "address": "DB1,X8.0", "role": "running"},
    {"name": "temp", "address": "DB1,REAL12", "role": "process", "unit": "°C"},
]


@pytest.fixture
def line(client, admin):
    area = client.post("/api/areas", headers=admin, json={"slug": unique("area"), "name": "Test Alanı"}).json()
    return client.post("/api/lines", headers=admin, json={"area_id": area["id"], "slug": "hat-1", "name": "Hat 1"}).json()


def make_machine(client, headers, line, **overrides):
    edge_id = next(e["id"] for e in client.get("/api/edges", headers=headers).json() if e["code"] == "edge-01")
    body = {"line_id": line["id"], "code": unique("m"), "name": "Test Makine",
            "plc": {"host": "192.168.10.21", "tags": TAGS}, **overrides}
    if body.get("plc"):
        body["plc"] = {"edge_id": edge_id, **body["plc"]}
    return client.post("/api/machines", headers=headers, json=body)


def test_create_machine_with_plc_normalizes_addresses(client, admin, line):
    r = make_machine(client, admin, line)
    assert r.status_code == 201, r.text
    m = r.json()
    assert m["has_plc_config"] and m["tag_count"] == 3
    assert m["plc"]["tags"][0]["address"] == "DB1,DINT0"
    assert (m["plc"]["rack"], m["plc"]["slot"], m["plc"]["port"]) == (0, 1, 102)


def test_slug_and_duplicate_rules(client, admin, line):
    assert client.post("/api/areas", headers=admin, json={"slug": "Büyük Harf", "name": "x"}).status_code == 422
    assert client.post("/api/lines", headers=admin, json={"area_id": line["area_id"], "slug": "hat-1", "name": "Aynı"}).status_code == 409
    code = make_machine(client, admin, line).json()["code"]
    assert make_machine(client, admin, line, code=code).status_code == 409
    assert client.post("/api/lines", headers=admin, json={"area_id": 999999, "slug": "x", "name": "x"}).status_code == 422


@pytest.mark.parametrize("tags,fragment", [
    ([{"name": "total_count", "address": "DB1,INT0", "role": "total_count"}], "INT"),
    ([{"name": "total_count", "address": "M10.0", "role": "total_count"}], "geçerli bir S7"),
    ([{"name": "a", "address": "DB1,DINT0", "role": "total_count"}, {"name": "a", "address": "DB1,REAL4", "role": "process"}], "birden fazla"),
])
def test_invalid_plc_config_is_rejected(client, admin, line, tags, fragment):
    r = make_machine(client, admin, line, plc={"host": "plc-1", "tags": tags})
    assert r.status_code == 422
    assert fragment in r.text


def test_required_roles_follow_machine_sources(client, admin, line):
    only_count = [{"name": "total_count", "address": "DB1,DINT0", "role": "total_count"}]
    # Durum kaynağı "tag" iken running/state_code zorunlu
    assert make_machine(client, admin, line, plc={"host": "plc-1", "tags": only_count}).status_code == 422
    m = make_machine(client, admin, line, state_source="counter", plc={"host": "plc-1", "tags": only_count}).json()
    # Kaynak değiştirilirken mevcut tag'ler yetmiyorsa reddedilir
    r = client.patch(f"/api/machines/{m['id']}", headers=admin, json={"scrap_source": "plc"})
    assert r.status_code == 422 and "scrap_count" in r.text
    assert client.patch(f"/api/machines/{m['id']}", headers=admin, json={"counter_idle_seconds": 45}).json()["counter_idle_seconds"] == 45


def test_machine_code_is_immutable(client, admin, line):
    m = make_machine(client, admin, line).json()
    assert client.patch(f"/api/machines/{m['id']}", headers=admin, json={"code": "yeni-kod"}).status_code == 422


def test_validate_endpoint_returns_errors_and_warnings(client, admin, line):
    m = make_machine(client, admin, line).json()
    r = client.post(f"/api/machines/{m['id']}/plc/validate", headers=admin,
                    json={"host": "plc-1", "tags": [{"name": "total_count", "address": "DB1,DINT0", "role": "total_count"},
                                                    {"name": "low", "address": "DB1,WORD2", "role": "process"}]})
    body = r.json()
    assert r.status_code == 200 and body["valid"] is False  # running yok
    assert any("running" in e["msg"] for e in body["errors"])
    assert body["warnings"] == ['"total_count" ve "low" aynı PLC belleğini okuyor']
    bad = client.post(f"/api/machines/{m['id']}/plc/validate", headers=admin, json={"host": "plc-1", "tags": [{"name": "x", "address": "zzz", "role": "process"}]}).json()
    assert bad["valid"] is False and "geçerli bir S7" in bad["errors"][0]["msg"]


def test_put_plc_replaces_config(client, admin, line):
    m = make_machine(client, admin, line).json()
    r = client.put(f"/api/machines/{m['id']}/plc", headers=admin, json={"host": "10.0.0.5", "poll_ms": 500, "edge_id": m["plc"]["edge_id"], "tags": TAGS[:2]})
    assert r.status_code == 200
    assert r.json()["host"] == "10.0.0.5" and r.json()["poll_ms"] == 500 and len(r.json()["tags"]) == 2
    assert r.json()["updated_by"] is not None


def test_delete_rules(client, admin, line):
    m = make_machine(client, admin, line).json()
    # Hattında makine olan alan/hat silinemez
    assert client.delete(f"/api/lines/{line['id']}", headers=admin).status_code == 409
    assert client.delete(f"/api/machines/{m['id']}", headers=admin).status_code == 204
    assert client.get(f"/api/machines/{m['id']}", headers=admin).status_code == 404


def test_hierarchy_tree(client, admin, line):
    make_machine(client, admin, line)
    tree = client.get("/api/hierarchy", headers=admin).json()
    area = next(a for a in tree if a["id"] == line["area_id"])
    assert area["lines"][0]["machines"][0]["has_plc_config"] is True
