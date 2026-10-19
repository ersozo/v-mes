"""FastAPI bağımlılıkları: veritabanı bağlantısı, kimlik doğrulama, rol kontrolü."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from functools import lru_cache

import jwt
import pymssql
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from mes_api.db import connect
from mes_api.security import TokenUser, decode_access_token
from mes_api.settings import AuthSettings, DbSettings


@lru_cache
def auth_settings() -> AuthSettings:
    return AuthSettings.from_env()


@lru_cache
def db_settings() -> DbSettings:
    return DbSettings.from_env()


def get_db() -> Iterator[pymssql.Connection]:
    with connect(db_settings()) as conn:
        yield conn


_bearer = HTTPBearer(auto_error=False)


def current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    settings: AuthSettings = Depends(auth_settings),
) -> TokenUser:
    if creds is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Giriş yapılmamış", headers={"WWW-Authenticate": "Bearer"})
    try:
        return decode_access_token(creds.credentials, settings)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Oturum süresi doldu", headers={"WWW-Authenticate": "Bearer"})
    except jwt.InvalidTokenError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Geçersiz token", headers={"WWW-Authenticate": "Bearer"})


def require_roles(*roles: str) -> Callable[[TokenUser], TokenUser]:
    allowed = set(roles)

    def dep(user: TokenUser = Depends(current_user)) -> TokenUser:
        if user.role not in allowed:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Bu işlem için yetkiniz yok")
        return user

    return dep


# ARCHITECTURE.md §8 yetki tablosu
any_user = current_user
can_operate = require_roles("admin", "engineer", "operator")
can_configure = require_roles("admin", "engineer")
admin_only = require_roles("admin")
