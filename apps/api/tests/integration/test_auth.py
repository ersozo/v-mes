from conftest import ADMIN, login, unique


def test_login_success_and_me(client):
    r = client.post("/api/auth/login", json={"username": ADMIN[0], "password": ADMIN[1]})
    assert r.status_code == 200
    body = r.json()
    assert body["user"]["role"] == "admin" and body["expires_in"] > 0
    assert "vmes_refresh" in r.cookies
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {body['access_token']}"})
    assert me.json()["username"] == ADMIN[0]


def test_wrong_password_and_unknown_user_same_error(client):
    a = client.post("/api/auth/login", json={"username": ADMIN[0], "password": "wrong"})
    b = client.post("/api/auth/login", json={"username": "nobody-here", "password": "wrong"})
    assert a.status_code == b.status_code == 401
    assert a.json() == b.json()


def test_throttle_after_repeated_failures(client):
    for _ in range(5):
        client.post("/api/auth/login", json={"username": "brute", "password": "x"})
    assert client.post("/api/auth/login", json={"username": "brute", "password": "x"}).status_code == 429


def test_protected_endpoints_require_token(client):
    assert client.get("/api/machines").status_code == 401
    assert client.get("/api/machines", headers={"Authorization": "Bearer not-a-jwt"}).status_code == 401


def test_refresh_rotation_and_reuse_detection(client):
    client.cookies.clear()
    client.post("/api/auth/login", json={"username": ADMIN[0], "password": ADMIN[1]})
    first = client.cookies.get("vmes_refresh")

    r = client.post("/api/auth/refresh")
    assert r.status_code == 200
    second = client.cookies.get("vmes_refresh")
    assert second and second != first

    # Eski (kullanılmış) token tekrar gelirse tüm oturumlar kapanır
    client.cookies.set("vmes_refresh", first, path="/api/auth")
    assert client.post("/api/auth/refresh").status_code == 401
    client.cookies.set("vmes_refresh", second, path="/api/auth")
    assert client.post("/api/auth/refresh").status_code == 401
    client.cookies.clear()


def test_logout_revokes_refresh(client):
    client.cookies.clear()
    client.post("/api/auth/login", json={"username": ADMIN[0], "password": ADMIN[1]})
    token = client.cookies.get("vmes_refresh")
    assert client.post("/api/auth/logout").status_code == 204
    client.cookies.set("vmes_refresh", token, path="/api/auth")
    assert client.post("/api/auth/refresh").status_code == 401
    client.cookies.clear()


def test_deactivated_user_cannot_login_or_refresh(client, admin):
    name = unique("temp")
    created = client.post("/api/users", headers=admin, json={"username": name, "role": "viewer", "password": "Passw0rdTest"}).json()
    client.cookies.clear()
    login(client, name, "Passw0rdTest")
    assert client.patch(f"/api/users/{created['id']}", headers=admin, json={"is_active": False}).status_code == 200
    assert client.post("/api/auth/refresh").status_code == 401
    assert client.post("/api/auth/login", json={"username": name, "password": "Passw0rdTest"}).status_code == 401
    client.cookies.clear()


def test_password_policy(client, admin):
    r = client.post("/api/users", headers=admin, json={"username": unique("weak"), "role": "viewer", "password": "short"})
    assert r.status_code == 422


def test_last_admin_cannot_be_removed(client, admin):
    me = client.get("/api/auth/me", headers=admin).json()
    assert client.patch(f"/api/users/{me['id']}", headers=admin, json={"role": "viewer"}).status_code == 409
    assert client.delete(f"/api/users/{me['id']}", headers=admin).status_code == 409
