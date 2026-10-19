"""Ortam değişkenlerinden okunan ayarlar."""

from __future__ import annotations

import os
from dataclasses import dataclass


def _env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if value is None or value == "":
        raise RuntimeError(f"{name} ortam değişkeni gerekli")
    return value


@dataclass(frozen=True)
class DbSettings:
    host: str
    port: int
    database: str
    user: str
    password: str

    @classmethod
    def from_env(cls) -> DbSettings:
        return cls(
            host=_env("MSSQL_HOST", "localhost"),
            port=int(_env("MSSQL_PORT", "1433")),
            database=_env("MSSQL_DB", "MES_DB"),
            user=_env("MSSQL_APP_USER"),
            password=_env("MSSQL_APP_PASSWORD"),
        )


@dataclass(frozen=True)
class NodeRedSettings:
    url: str
    user: str
    password: str

    @classmethod
    def from_env(cls) -> NodeRedSettings:
        return cls(
            url=_env("NODERED_URL", "http://nodered:1880").rstrip("/"),
            user=_env("NODERED_ADMIN_USER", "admin"),
            password=_env("NODERED_ADMIN_PASSWORD"),
        )


@dataclass(frozen=True)
class AuthSettings:
    jwt_secret: str
    access_ttl_seconds: int
    refresh_ttl_seconds: int
    cookie_secure: bool

    @classmethod
    def from_env(cls) -> AuthSettings:
        secret = _env("JWT_SECRET")
        if len(secret) < 32:
            raise RuntimeError("JWT_SECRET en az 32 karakter olmalı")
        return cls(
            jwt_secret=secret,
            access_ttl_seconds=int(_env("ACCESS_TOKEN_TTL_SECONDS", "900")),
            refresh_ttl_seconds=int(_env("REFRESH_TOKEN_TTL_SECONDS", str(7 * 24 * 3600))),
            cookie_secure=_env("COOKIE_SECURE", "false").lower() == "true",
        )


def edge_id() -> str:
    return _env("EDGE_ID", "edge-01")
