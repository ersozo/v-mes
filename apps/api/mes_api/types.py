"""Ortak Pydantic tipleri."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from pydantic import PlainSerializer


def _iso_z(v: datetime | None) -> str | None:
    if v is None:
        return None
    if v.tzinfo is None:
        v = v.replace(tzinfo=UTC)
    return v.astimezone(UTC).isoformat().replace("+00:00", "Z")


# Veritabanındaki naive UTC zaman damgaları istemciye her zaman "Z" ile gider
UtcDatetime = Annotated[datetime, PlainSerializer(_iso_z, return_type=str)]
