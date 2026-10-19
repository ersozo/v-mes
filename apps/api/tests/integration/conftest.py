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
