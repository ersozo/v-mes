"""Entegrasyon testleri: gerçek MSSQL (MES_TEST) üzerinde çalışır.

    make test-api-int
"""

from __future__ import annotations

import os
import uuid

import pytest

if os.environ.get("INTEGRATION") != "1":
    pytest.skip("entegrasyon testleri için INTEGRATION=1 gerekli (make test-api-int)", allow_module_level=True)

os.environ.setdefault("JWT_SECRET", "test-secret-" + "x" * 40)
os.environ.setdefault("ADMIN_USERNAME", "admin")
os.environ.setdefault("ADMIN_PASSWORD", "AdminPass123")
os.environ.setdefault("NODERED_ADMIN_PASSWORD", "unused")
os.environ.setdefault("JOBS_ENABLED", "false")
assert os.environ.get("MSSQL_DB", "").upper().endswith("_TEST"), "entegrasyon testleri yalnızca *_TEST veritabanında çalışır"

from fastapi.testclient import TestClient  # noqa: E402

from mes_api.main import app  # noqa: E402
from mes_api.routers import auth as auth_router  # noqa: E402

ADMIN = (os.environ["ADMIN_USERNAME"], os.environ["ADMIN_PASSWORD"])


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _reset_throttle():
    auth_router.throttle._failures.clear()


def login(client: TestClient, username: str, password: str) -> dict[str, str]:
    r = client.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture(scope="session")
def admin(client) -> dict[str, str]:
    return login(client, *ADMIN)


@pytest.fixture(scope="session")
def users(client, admin) -> dict[str, dict[str, str]]:
    """Her rol için bir kullanıcı ve oturum başlığı."""
    headers = {"admin": admin}
    for role in ("engineer", "operator", "viewer"):
        name = f"{role}-{uuid.uuid4().hex[:6]}"
        r = client.post("/api/users", headers=admin, json={"username": name, "role": role, "password": "Passw0rdTest"})
        assert r.status_code == 201, r.text
        headers[role] = login(client, name, "Passw0rdTest")
    return headers


def unique(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


@pytest.fixture
def db():
    """Test verisini doğrudan yazmak için MES_TEST bağlantısı."""
    from mes_api.db import connect
    from mes_api.settings import DbSettings

    with connect(DbSettings.from_env()) as conn:
        yield conn


def default_edge_id(client, admin) -> int:
    return next(e["id"] for e in client.get("/api/edges", headers=admin).json() if e["code"] == "edge-01")


def make_line_and_machine(client, admin, **machine) -> dict:
    area = client.post("/api/areas", headers=admin, json={"slug": unique("area"), "name": "Rapor Alanı"}).json()
    line = client.post("/api/lines", headers=admin, json={"area_id": area["id"], "slug": "hat-1", "name": "Rapor Hattı"}).json()
    body = {"line_id": line["id"], "code": unique("m"), "name": "Rapor Makinesi", "state_source": "counter", **machine}
    if body.get("plc") and "edge_id" not in body["plc"]:
        body["plc"] = {**body["plc"], "edge_id": default_edge_id(client, admin)}
    r = client.post("/api/machines", headers=admin, json=body)
    assert r.status_code == 201, r.text
    return {**r.json(), "area_id": area["id"]}
