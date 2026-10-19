"""Şifre hash'leme, JWT access token'ları ve refresh token rotasyonu."""

from __future__ import annotations

import hashlib
import secrets
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from mes_api.settings import AuthSettings

ROLES = ("admin", "engineer", "operator", "viewer")
_hasher = PasswordHasher()  # argon2id, kütüphane varsayılan parametreleri
_DUMMY_HASH = _hasher.hash("zamanlama-saldirisina-karsi")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    """Kullanıcı yoksa da aynı sürede çalışır (kullanıcı adı tahminine karşı)."""
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerificationError, InvalidHashError):
        return False


def validate_password_strength(password: str) -> None:
    if len(password) < 10:
        raise ValueError("şifre en az 10 karakter olmalı")
    if password.lower() == password or password.upper() == password or not any(c.isdigit() for c in password):
        raise ValueError("şifre büyük harf, küçük harf ve rakam içermeli")


@dataclass(frozen=True)
class TokenUser:
    id: int
    username: str
    role: str


def create_access_token(user: TokenUser, s: AuthSettings) -> str:
    now = int(time.time())
    return jwt.encode(
        {
            "sub": str(user.id),
            "name": user.username,
            "role": user.role,
            "type": "access",
            "iat": now,
            "exp": now + s.access_ttl_seconds,
        },
        s.jwt_secret,
        algorithm="HS256",
    )


def decode_access_token(token: str, s: AuthSettings) -> TokenUser:
    payload = jwt.decode(token, s.jwt_secret, algorithms=["HS256"], options={"require": ["exp", "sub", "role", "type"]})
    if payload["type"] != "access" or payload["role"] not in ROLES:
        raise jwt.InvalidTokenError("geçersiz token türü")
    return TokenUser(id=int(payload["sub"]), username=payload.get("name", ""), role=payload["role"])


def new_refresh_token(s: AuthSettings) -> tuple[str, str, datetime]:
    """(ham token, saklanacak hash, son kullanma) — ham token yalnızca çerezde bulunur."""
    raw = secrets.token_urlsafe(48)
    return raw, hash_refresh_token(raw), datetime.now(UTC).replace(tzinfo=None) + timedelta(seconds=s.refresh_ttl_seconds)


def hash_refresh_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


class LoginThrottle:
    """Kullanıcı adı başına basit kaba kuvvet koruması (tek süreçli dağıtım için)."""

    def __init__(self, max_failures: int = 5, lock_seconds: int = 60) -> None:
        self.max_failures = max_failures
        self.lock_seconds = lock_seconds
        self._failures: dict[str, tuple[int, float]] = {}

    def locked_for(self, key: str) -> int:
        count, until = self._failures.get(key, (0, 0.0))
        remaining = until - time.monotonic()
        return int(remaining) + 1 if count >= self.max_failures and remaining > 0 else 0

    def failure(self, key: str) -> None:
        count, until = self._failures.get(key, (0, 0.0))
        if until and until < time.monotonic():
            count = 0
        count += 1
        self._failures[key] = (count, time.monotonic() + self.lock_seconds)

    def success(self, key: str) -> None:
        self._failures.pop(key, None)
