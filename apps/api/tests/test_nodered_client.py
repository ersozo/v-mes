"""Node-RED Admin API istemcisi — adminAuth açık ve kapalı Node-RED'ler (sahte HTTP)."""

import httpx
import pytest

from mes_api.flows.nodered import NodeRedAdmin, NodeRedError
from mes_api.settings import NodeRedSettings


def client(handler, user=None, password=None):
    s = NodeRedSettings(url="http://edge:1880", user=user, password=password)
    return NodeRedAdmin(s, httpx.Client(base_url=s.url, transport=httpx.MockTransport(handler)))


def test_no_auth_node_red_works_without_credentials():
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, req.url.path, req.headers.get("authorization")))
        if req.url.path == "/auth/login":
            return httpx.Response(200, json={})            # adminAuth kapalı
        if req.url.path == "/flows":
            return httpx.Response(200, json={"flows": [], "rev": "r1"})
        return httpx.Response(404)

    flows, rev = client(handler).get_flows()
    assert (flows, rev) == ([], "r1")
    assert ("GET", "/flows", None) in seen and not any(p == "/auth/token" for _, p, _ in seen)


def test_auth_node_red_uses_token():
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/auth/login":
            return httpx.Response(200, json={"type": "credentials", "prompts": []})
        if req.url.path == "/auth/token":
            assert b"username=hubbox" in req.content
            return httpx.Response(200, json={"access_token": "tok"})
        if req.url.path == "/flows":
            assert req.headers["authorization"] == "Bearer tok"
            return httpx.Response(200, json={"flows": [], "rev": "r2"})
        return httpx.Response(404)

    assert client(handler, "hubbox", "hubbox").get_flows()[1] == "r2"


def test_auth_required_but_no_credentials_gives_clear_error():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"type": "credentials"}) if req.url.path == "/auth/login" else httpx.Response(404)

    with pytest.raises(NodeRedError, match="NODERED_ADMIN_USER"):
        client(handler).get_flows()
