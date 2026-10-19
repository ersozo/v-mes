"""Giriş, token yenileme (rotasyonlu refresh token) ve çıkış."""

from __future__ import annotations

from typing import Annotated

import pymssql
from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field

from mes_api.db import execute, fetch_one
from mes_api.deps import auth_settings, current_user, get_db
from mes_api.security import (
    LoginThrottle,
    TokenUser,
    create_access_token,
    hash_refresh_token,
    new_refresh_token,
    verify_password,
)
from mes_api.settings import AuthSettings

router = APIRouter(prefix="/api/auth", tags=["auth"])
throttle = LoginThrottle()
REFRESH_COOKIE = "vmes_refresh"


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class UserInfo(BaseModel):
    id: int
    username: str
    display_name: str | None
    role: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: UserInfo


def _set_refresh_cookie(response: Response, raw: str, s: AuthSettings) -> None:
    response.set_cookie(
        REFRESH_COOKIE, raw, max_age=s.refresh_ttl_seconds, httponly=True,
        secure=s.cookie_secure, samesite="strict", path="/api/auth",
    )


def _issue(conn: pymssql.Connection, row: dict, response: Response, s: AuthSettings) -> TokenResponse:
    raw, token_hash, expires = new_refresh_token(s)
    execute(conn, "INSERT INTO dbo.user_refresh_tokens (user_id, token_hash, expires_at) VALUES (%s, %s, %s)",
            (row["id"], token_hash, expires))
    conn.commit()
    _set_refresh_cookie(response, raw, s)
    user = TokenUser(id=row["id"], username=row["username"], role=row["role"])
    return TokenResponse(
        access_token=create_access_token(user, s),
        expires_in=s.access_ttl_seconds,
        user=UserInfo(id=row["id"], username=row["username"], display_name=row["display_name"], role=row["role"]),
    )


@router.post("/login", response_model=TokenResponse)
def login(body: LoginRequest, request: Request, response: Response,
          conn: pymssql.Connection = Depends(get_db), s: AuthSettings = Depends(auth_settings)) -> TokenResponse:
    key = body.username.lower()
    if wait := throttle.locked_for(key):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, f"Çok fazla hatalı deneme. {wait} sn sonra tekrar deneyin.")

    row = fetch_one(conn, "SELECT id, username, display_name, password_hash, role, is_active FROM dbo.users WHERE username = %s",
                    (body.username,))
    if not verify_password(row["password_hash"] if row else None, body.password) or not row or not row["is_active"]:
        throttle.failure(key)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Kullanıcı adı veya şifre hatalı")

    throttle.success(key)
    execute(conn, "UPDATE dbo.users SET last_login_at = SYSUTCDATETIME() WHERE id = %s", (row["id"],))
    # Süresi dolmuş token'ları temizle
    execute(conn, "DELETE FROM dbo.user_refresh_tokens WHERE user_id = %s AND expires_at < SYSUTCDATETIME()", (row["id"],))
    return _issue(conn, row, response, s)


@router.post("/refresh", response_model=TokenResponse)
def refresh(response: Response, vmes_refresh: Annotated[str | None, Cookie()] = None,
            conn: pymssql.Connection = Depends(get_db), s: AuthSettings = Depends(auth_settings)) -> TokenResponse:
    if not vmes_refresh:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Oturum bulunamadı")
    token = fetch_one(
        conn,
        """SELECT t.id, t.user_id, t.revoked_at, CASE WHEN t.expires_at < SYSUTCDATETIME() THEN 1 ELSE 0 END AS expired,
                  u.username, u.display_name, u.role, u.is_active
           FROM dbo.user_refresh_tokens t JOIN dbo.users u ON u.id = t.user_id WHERE t.token_hash = %s""",
        (hash_refresh_token(vmes_refresh),),
    )
    if token is None or token["expired"] or not token["is_active"]:
        response.delete_cookie(REFRESH_COOKIE, path="/api/auth")
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Oturum süresi doldu")
    if token["revoked_at"] is not None:
        # Kullanılmış bir refresh token tekrar geldi: çalınmış olabilir → kullanıcının tüm oturumlarını kapat.
        execute(conn, "UPDATE dbo.user_refresh_tokens SET revoked_at = SYSUTCDATETIME() WHERE user_id = %s AND revoked_at IS NULL",
                (token["user_id"],))
        conn.commit()
        response.delete_cookie(REFRESH_COOKIE, path="/api/auth")
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Oturum geçersiz kılındı; tekrar giriş yapın")

    # Rotasyon: eski token iptal, yenisi verilir. Aynı anda iki istek yarışırsa yalnızca biri kazanır.
    if execute(conn, "UPDATE dbo.user_refresh_tokens SET revoked_at = SYSUTCDATETIME() WHERE id = %s AND revoked_at IS NULL",
               (token["id"],)) != 1:
        conn.rollback()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Oturum geçersiz")
    row = {"id": token["user_id"], "username": token["username"], "display_name": token["display_name"], "role": token["role"]}
    return _issue(conn, row, response, s)


@router.post("/logout", status_code=204)
def logout(response: Response, vmes_refresh: Annotated[str | None, Cookie()] = None,
           conn: pymssql.Connection = Depends(get_db)) -> Response:
    if vmes_refresh:
        execute(conn, "UPDATE dbo.user_refresh_tokens SET revoked_at = SYSUTCDATETIME() WHERE token_hash = %s AND revoked_at IS NULL",
                (hash_refresh_token(vmes_refresh),))
        conn.commit()
    response.delete_cookie(REFRESH_COOKIE, path="/api/auth")
    response.status_code = 204
    return response


@router.get("/me", response_model=UserInfo)
def me(user: TokenUser = Depends(current_user), conn: pymssql.Connection = Depends(get_db)) -> UserInfo:
    row = fetch_one(conn, "SELECT id, username, display_name, role FROM dbo.users WHERE id = %s AND is_active = 1", (user.id,))
    if row is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Kullanıcı bulunamadı")
    return UserInfo(**row)
