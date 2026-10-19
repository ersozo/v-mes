"""Kullanıcı yönetimi (yalnızca admin)."""

from __future__ import annotations

from typing import Literal

import pymssql
from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field, field_validator

from mes_api.db import execute, fetch_all, fetch_one
from mes_api.deps import admin_only, get_db
from mes_api.security import TokenUser, hash_password, validate_password_strength

router = APIRouter(prefix="/api/users", tags=["users"], dependencies=[Depends(admin_only)])

Role = Literal["admin", "engineer", "operator", "viewer"]
_COLUMNS = "id, username, display_name, role, is_active, created_at, last_login_at"


class UserOut(BaseModel):
    id: int
    username: str
    display_name: str | None
    role: Role
    is_active: bool
    created_at: object
    last_login_at: object | None


class UserCreate(BaseModel):
    username: str = Field(pattern=r"^[a-zA-Z0-9._-]{3,64}$")
    display_name: str | None = Field(default=None, max_length=100)
    role: Role
    password: str = Field(max_length=256)

    @field_validator("password")
    @classmethod
    def _strong(cls, v: str) -> str:
        validate_password_strength(v)
        return v


class UserUpdate(BaseModel):
    display_name: str | None = Field(default=None, max_length=100)
    role: Role | None = None
    is_active: bool | None = None
    password: str | None = Field(default=None, max_length=256)

    @field_validator("password")
    @classmethod
    def _strong(cls, v: str | None) -> str | None:
        if v is not None:
            validate_password_strength(v)
        return v


def _get(conn: pymssql.Connection, user_id: int) -> dict:
    row = fetch_one(conn, f"SELECT {_COLUMNS} FROM dbo.users WHERE id = %s", (user_id,))
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Kullanıcı bulunamadı")
    return row


@router.get("", response_model=list[UserOut])
def list_users(conn: pymssql.Connection = Depends(get_db)) -> list[dict]:
    return fetch_all(conn, f"SELECT {_COLUMNS} FROM dbo.users ORDER BY username")


@router.post("", response_model=UserOut, status_code=201)
def create_user(body: UserCreate, conn: pymssql.Connection = Depends(get_db)) -> dict:
    row = fetch_one(
        conn,
        f"INSERT INTO dbo.users (username, display_name, role, password_hash) OUTPUT {', '.join('inserted.' + c.strip() for c in _COLUMNS.split(','))} "
        "VALUES (%s, %s, %s, %s)",
        (body.username, body.display_name, body.role, hash_password(body.password)),
    )
    conn.commit()
    return row


@router.patch("/{user_id}", response_model=UserOut)
def update_user(user_id: int, body: UserUpdate, me: TokenUser = Depends(admin_only),
                conn: pymssql.Connection = Depends(get_db)) -> dict:
    _get(conn, user_id)
    changes = body.model_dump(exclude_unset=True)
    if user_id == me.id and (changes.get("role", "admin") != "admin" or changes.get("is_active") is False):
        raise HTTPException(status.HTTP_409_CONFLICT, "Kendi admin yetkinizi kaldıramaz veya hesabınızı pasifleştiremezsiniz")
    if "password" in changes:
        changes["password_hash"] = hash_password(changes.pop("password"))
    if changes:
        sets = ", ".join(f"{k} = %({k})s" for k in changes)
        execute(conn, f"UPDATE dbo.users SET {sets} WHERE id = %(id)s", {**changes, "id": user_id})
        if "password_hash" in changes or changes.get("is_active") is False or "role" in changes:
            # Yetki/şifre değişince mevcut oturumlar kapanır
            execute(conn, "UPDATE dbo.user_refresh_tokens SET revoked_at = SYSUTCDATETIME() WHERE user_id = %s AND revoked_at IS NULL",
                    (user_id,))
        _ensure_an_admin_remains(conn)
        conn.commit()
    return _get(conn, user_id)


@router.delete("/{user_id}", status_code=204)
def delete_user(user_id: int, me: TokenUser = Depends(admin_only), conn: pymssql.Connection = Depends(get_db)) -> Response:
    if user_id == me.id:
        raise HTTPException(status.HTTP_409_CONFLICT, "Kendi hesabınızı silemezsiniz")
    _get(conn, user_id)
    # Geçmiş kayıtlarda (atamalar, deploy'lar) referansı olan kullanıcı silinemez → pasifleştirin
    execute(conn, "DELETE FROM dbo.users WHERE id = %s", (user_id,))
    _ensure_an_admin_remains(conn)
    conn.commit()
    return Response(status_code=204)


def _ensure_an_admin_remains(conn: pymssql.Connection) -> None:
    row = fetch_one(conn, "SELECT COUNT(*) AS n FROM dbo.users WHERE role = 'admin' AND is_active = 1")
    if not row or row["n"] == 0:
        conn.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Sistemde en az bir aktif admin kalmalı")
