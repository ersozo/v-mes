"""PLC tag doğrulama kuralları — packages/contracts/src/plc.ts ile birebir aynı olmalıdır.

İki uygulama da packages/contracts/test-vectors/plc.json dosyasına karşı test edilir.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

TAG_NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_ADDRESS_RE = re.compile(r"^DB(\d{1,5}),([A-Z]+)(\d{1,5})(?:\.(\d))?$")

S7DataType = Literal["X", "BYTE", "INT", "WORD", "DINT", "DWORD", "REAL"]

_TYPE_ALIASES: dict[str, S7DataType] = {
    "X": "X",
    "B": "BYTE", "BYTE": "BYTE",
    "I": "INT", "INT": "INT",
    "W": "WORD", "WORD": "WORD",
    "DI": "DINT", "DINT": "DINT",
    "DW": "DWORD", "DWORD": "DWORD",
    "R": "REAL", "REAL": "REAL",
}
_TYPE_SIZE: dict[str, int] = {"X": 1, "BYTE": 1, "INT": 2, "WORD": 2, "DINT": 4, "DWORD": 4, "REAL": 4}

TagRole = Literal["total_count", "scrap_count", "running", "state_code", "process"]
_SINGLE_ROLES = {"total_count", "scrap_count", "running", "state_code"}
_ROLE_TYPES: dict[str, set[str]] = {
    "total_count": {"DINT", "DWORD", "WORD"},
    "scrap_count": {"DINT", "DWORD", "WORD"},
    "running": {"X", "BYTE", "INT", "WORD", "DINT"},
    "state_code": {"BYTE", "INT", "WORD", "DINT", "DWORD"},
    "process": {"X", "BYTE", "INT", "WORD", "DINT", "DWORD", "REAL"},
}


@dataclass(frozen=True)
class S7Address:
    db: int
    type: S7DataType
    offset: int
    bit: int | None = None

    def format(self) -> str:
        if self.type == "X":
            return f"DB{self.db},X{self.offset}.{self.bit}"
        return f"DB{self.db},{self.type}{self.offset}"

    def byte_range(self) -> tuple[int, int]:
        return self.offset, self.offset + _TYPE_SIZE[self.type]


class AddressError(ValueError):
    pass


def parse_s7_address(value: str) -> S7Address:
    m = _ADDRESS_RE.match(value.strip().upper())
    if not m:
        raise AddressError(f'"{value}" geçerli bir S7 DB adresi değil (ör. DB1,DINT0 veya DB1,X8.0)')
    db_s, type_s, offset_s, bit_s = m.groups()
    t = _TYPE_ALIASES.get(type_s)
    if t is None:
        raise AddressError(f'Desteklenmeyen tip "{type_s}". Desteklenenler: X, BYTE, INT, WORD, DINT, DWORD, REAL')
    db, offset = int(db_s), int(offset_s)
    if not 1 <= db <= 65535:
        raise AddressError("DB numarası 1–65535 arasında olmalı")
    if offset > 65535:
        raise AddressError("Bayt ofseti 0–65535 arasında olmalı")
    if t == "X":
        if bit_s is None:
            raise AddressError("X (bit) tipi için bit numarası gerekli (ör. DB1,X8.0)")
        bit = int(bit_s)
        if bit > 7:
            raise AddressError("Bit numarası 0–7 arasında olmalı")
        return S7Address(db, t, offset, bit)
    if bit_s is not None:
        raise AddressError(f"{t} tipinde bit numarası kullanılamaz")
    return S7Address(db, t, offset)


class TagDefinition(BaseModel):
    name: str
    address: str
    role: TagRole
    unit: str | None = Field(default=None, max_length=16)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        if not TAG_NAME_PATTERN.match(v):
            raise ValueError("tag adı küçük harfle başlamalı; yalnızca a-z, 0-9 ve _ (en fazla 64)")
        return v

    @model_validator(mode="after")
    def _address_and_role(self) -> TagDefinition:
        addr = parse_s7_address(self.address)
        allowed = _ROLE_TYPES[self.role]
        if addr.type not in allowed:
            raise ValueError(
                f'"{self.role}" rolü için {addr.type} tipi uygun değil. Uygun tipler: {", ".join(sorted(allowed))}'
            )
        # Kanonik biçimde sakla: "db1,di4" → "DB1,DINT4"
        self.address = addr.format()
        return self


def validate_tag_list(tags: list[TagDefinition]) -> list[TagDefinition]:
    if not tags:
        raise ValueError("en az bir tag tanımlanmalı")
    if len(tags) > 256:
        raise ValueError("en fazla 256 tag")
    names: set[str] = set()
    roles: set[str] = set()
    for t in tags:
        if t.name in names:
            raise ValueError(f'"{t.name}" adı birden fazla kez kullanılmış')
        names.add(t.name)
        if t.role in _SINGLE_ROLES:
            if t.role in roles:
                raise ValueError(f'"{t.role}" rolü bir makinede yalnızca bir kez kullanılabilir')
            roles.add(t.role)
    return tags


def check_required_roles(tags: list[TagDefinition], state_source: str, scrap_source: str) -> list[str]:
    roles = {t.role for t in tags}
    errors = []
    if "total_count" not in roles:
        errors.append('"total_count" rolünde bir tag zorunludur')
    if state_source == "tag" and not roles & {"running", "state_code"}:
        errors.append('Durum kaynağı "tag" seçildiğinde "running" veya "state_code" rolünde bir tag gerekir')
    if scrap_source == "plc" and "scrap_count" not in roles:
        errors.append('Hurda kaynağı "plc" seçildiğinde "scrap_count" rolünde bir tag gerekir')
    return errors


def find_overlapping_tags(tags: list[TagDefinition]) -> list[tuple[str, str]]:
    parsed = [(t.name, parse_s7_address(t.address)) for t in tags]
    overlaps = []
    for i, (n1, a) in enumerate(parsed):
        for n2, b in parsed[i + 1:]:
            if a.db != b.db:
                continue
            if a.type == "X" and b.type == "X":
                if a.offset == b.offset and a.bit == b.bit:
                    overlaps.append((n1, n2))
                continue
            (s1, e1), (s2, e2) = a.byte_range(), b.byte_range()
            if s1 < e2 and s2 < e1:
                overlaps.append((n1, n2))
    return overlaps
