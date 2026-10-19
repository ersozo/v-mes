"""Node-RED Admin API istemcisi."""

from __future__ import annotations

import httpx

from mes_api.settings import NodeRedSettings


class NodeRedError(RuntimeError):
    pass


class FlowConflictError(NodeRedError):
    """Akış, okunduktan sonra başka biri tarafından değiştirildi (rev uyuşmazlığı)."""


class NodeRedAdmin:
    def __init__(self, settings: NodeRedSettings, client: httpx.Client | None = None) -> None:
        self._s = settings
        self._client = client or httpx.Client(base_url=settings.url, timeout=15)
        self._token: str | None = None

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> NodeRedAdmin:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _auth_headers(self) -> dict[str, str]:
        if self._token is None:
            r = self._client.post(
                "/auth/token",
                data={
                    "client_id": "node-red-admin",
                    "grant_type": "password",
                    "scope": "*",
                    "username": self._s.user,
                    "password": self._s.password,
                },
            )
            if r.status_code != 200:
                raise NodeRedError(f"Node-RED kimlik doğrulaması başarısız (HTTP {r.status_code})")
            self._token = r.json()["access_token"]
        return {"Authorization": f"Bearer {self._token}"}

    def get_flows(self) -> tuple[list[dict], str]:
        """Etkin akışları ve revizyon kimliğini döner."""
        r = self._client.get("/flows", headers={**self._auth_headers(), "Node-RED-API-Version": "v2"})
        if r.status_code != 200:
            raise NodeRedError(f"Akışlar okunamadı (HTTP {r.status_code}): {r.text[:200]}")
        body = r.json()
        return body["flows"], body["rev"]

    def deploy_flows(self, flows: list[dict], rev: str) -> str:
        """Yalnızca değişen akışları yeniden başlatarak deploy eder; yeni rev'i döner."""
        r = self._client.post(
            "/flows",
            json={"flows": flows, "rev": rev},
            headers={
                **self._auth_headers(),
                "Node-RED-API-Version": "v2",
                "Node-RED-Deployment-Type": "flows",
            },
        )
        if r.status_code == 409:
            raise FlowConflictError("Node-RED akışı bu sırada değiştirildi; önizlemeyi yenileyip tekrar deneyin")
        if r.status_code != 200:
            raise NodeRedError(f"Deploy başarısız (HTTP {r.status_code}): {r.text[:500]}")
        return r.json()["rev"]
