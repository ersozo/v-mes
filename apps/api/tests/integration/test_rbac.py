"""ARCHITECTURE.md §8 yetki tablosu."""

import pytest

from conftest import unique


@pytest.mark.parametrize("role", ["admin", "engineer", "operator", "viewer"])
def test_everyone_can_read(client, users, role):
    for path in ("/api/hierarchy", "/api/machines", "/api/products", "/api/shifts", "/api/downtime-reasons", "/api/settings"):
        assert client.get(path, headers=users[role]).status_code == 200, path


@pytest.mark.parametrize("role,expected", [("admin", 201), ("engineer", 201), ("operator", 403), ("viewer", 403)])
def test_configuration_requires_engineer(client, users, role, expected):
    r = client.post("/api/areas", headers=users[role], json={"slug": unique("a"), "name": "Test"})
    assert r.status_code == expected


@pytest.mark.parametrize("role,expected", [("admin", 200), ("engineer", 403), ("operator", 403), ("viewer", 403)])
def test_user_management_is_admin_only(client, users, role, expected):
    assert client.get("/api/users", headers=users[role]).status_code == expected


@pytest.mark.parametrize("role,expected", [("admin", 200), ("engineer", 403)])
def test_plant_settings_admin_only(client, users, role, expected):
    assert client.patch("/api/settings", headers=users[role], json={"min_downtime_seconds": 60}).status_code == expected


def test_flows_require_engineer(client, users):
    assert client.get("/api/flows/preview", headers=users["operator"]).status_code == 403
    assert client.post("/api/flows/deploy", headers=users["viewer"]).status_code == 403


def test_admin_jobs(client, users):
    assert client.get("/api/admin/jobs", headers=users["engineer"]).status_code == 403
    jobs = client.get("/api/admin/jobs", headers=users["admin"]).json()
    assert {j["name"] for j in jobs} == {"telemetry_partitions", "telemetry_purge", "telemetry_compress", "auth_cleanup"}
    for name in ("telemetry_partitions", "telemetry_compress", "auth_cleanup", "telemetry_purge"):
        r = client.post(f"/api/admin/jobs/{name}/run", headers=users["admin"]).json()
        assert r["status"] == "success", r
    after = {j["name"]: j for j in client.get("/api/admin/jobs", headers=users["admin"]).json()}
    assert after["telemetry_partitions"]["last_status"] == "success" and after["telemetry_partitions"]["last_finished_at"].endswith("Z")
    assert client.post("/api/admin/jobs/bogus/run", headers=users["admin"]).status_code == 404
