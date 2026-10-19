"""MES_DB migration aracı.

- Veritabanı yoksa oluşturur.
- db/migrations/V###__ad.sql dosyalarını sırayla, yalnızca bir kez uygular.
- Uygulanmış bir dosyanın içeriği değişmişse durur (checksum kontrolü).
- Uygulama kullanıcısını (sa olmayan) oluşturur/günceller.
- DB_SEED=1 ise db/seed/*.sql dosyalarını çalıştırır (seed dosyaları idempotent olmalı).

Dosyalar 'GO' satırlarıyla batch'lere bölünür. Her migration tek transaction içinde çalışır.
"""

from __future__ import annotations

import hashlib
import os
import re
import sys
import time
from pathlib import Path

import pymssql

ROOT = Path(__file__).resolve().parent
MIGRATIONS_DIR = ROOT / "migrations"
SEED_DIR = ROOT / "seed"
FILE_RE = re.compile(r"^V(\d{3})__([a-z0-9_]+)\.sql$")
GO_RE = re.compile(r"^\s*GO\s*$", re.IGNORECASE | re.MULTILINE)
IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")


def env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if value is None or value == "":
        sys.exit(f"[migrate] {name} ortam değişkeni gerekli")
    return value


def connect(database: str, retries: int = 30) -> pymssql.Connection:
    for attempt in range(1, retries + 1):
        try:
            return pymssql.connect(
                server=env("MSSQL_HOST", "localhost"),
                port=env("MSSQL_PORT", "1433"),
                user="sa",
                password=env("MSSQL_SA_PASSWORD"),
                database=database,
                autocommit=False,
                login_timeout=5,
            )
        except pymssql.OperationalError as exc:
            if attempt == retries:
                raise
            print(f"[migrate] bağlantı bekleniyor ({attempt}/{retries}): {exc}")
            time.sleep(2)
    raise RuntimeError("unreachable")


def split_batches(sql: str) -> list[str]:
    return [b.strip() for b in GO_RE.split(sql) if b.strip()]


def ensure_database(db_name: str) -> None:
    conn = connect("master")
    conn.autocommit(True)
    with conn.cursor() as cur:
        cur.execute("SELECT DB_ID(%s)", (db_name,))
        if cur.fetchone()[0] is None:
            print(f"[migrate] veritabanı oluşturuluyor: {db_name}")
            cur.execute(f"CREATE DATABASE [{db_name}]")
            cur.execute(f"ALTER DATABASE [{db_name}] SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE")
    conn.close()


def ensure_migrations_table(conn: pymssql.Connection) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            IF OBJECT_ID('dbo.schema_migrations') IS NULL
            CREATE TABLE dbo.schema_migrations (
                version     int           NOT NULL PRIMARY KEY,
                name        varchar(200)  NOT NULL,
                checksum    char(64)      NOT NULL,
                applied_at  datetime2(3)  NOT NULL CONSTRAINT df_schema_migrations_applied DEFAULT SYSUTCDATETIME()
            )
            """
        )
    conn.commit()


def run_migrations(conn: pymssql.Connection) -> None:
    with conn.cursor() as cur:
        cur.execute("SELECT version, checksum FROM dbo.schema_migrations")
        applied = {row[0]: row[1] for row in cur.fetchall()}

    files = sorted(p for p in MIGRATIONS_DIR.glob("*.sql"))
    seen: set[int] = set()
    for path in files:
        m = FILE_RE.match(path.name)
        if not m:
            sys.exit(f"[migrate] geçersiz dosya adı: {path.name} (beklenen: V001__ad.sql)")
        version, name = int(m.group(1)), m.group(2)
        if version in seen:
            sys.exit(f"[migrate] aynı sürüm numarası iki kez kullanılmış: V{version:03d}")
        seen.add(version)

        sql = path.read_text(encoding="utf-8")
        checksum = hashlib.sha256(sql.encode("utf-8")).hexdigest()

        if version in applied:
            if applied[version] != checksum:
                sys.exit(
                    f"[migrate] {path.name} uygulandıktan sonra değiştirilmiş. "
                    "Uygulanmış migration'ları düzenlemeyin; yeni bir dosya ekleyin."
                )
            continue

        print(f"[migrate] uygulanıyor: {path.name}")
        try:
            with conn.cursor() as cur:
                for batch in split_batches(sql):
                    cur.execute(batch)
                cur.execute(
                    "INSERT INTO dbo.schema_migrations (version, name, checksum) VALUES (%s, %s, %s)",
                    (version, name, checksum),
                )
            conn.commit()
        except Exception:
            conn.rollback()
            print(f"[migrate] HATA: {path.name} geri alındı")
            raise


def ensure_app_user(conn: pymssql.Connection, db_name: str) -> None:
    user = env("MSSQL_APP_USER")
    password = env("MSSQL_APP_PASSWORD")
    if not IDENT_RE.match(user):
        sys.exit("[migrate] MSSQL_APP_USER yalnızca harf, rakam ve _ içerebilir")
    pw = password.replace("'", "''")

    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM sys.server_principals WHERE name = %s", (user,))
        if cur.fetchone() is None:
            cur.execute(f"CREATE LOGIN [{user}] WITH PASSWORD = N'{pw}', DEFAULT_DATABASE = [{db_name}], CHECK_POLICY = ON")
        else:
            cur.execute(f"ALTER LOGIN [{user}] WITH PASSWORD = N'{pw}'")
        cur.execute("SELECT 1 FROM sys.database_principals WHERE name = %s", (user,))
        if cur.fetchone() is None:
            cur.execute(f"CREATE USER [{user}] FOR LOGIN [{user}]")
        # Uygulama rolü: veri okuma/yazma + saklı yordam çalıştırma. Şema değiştiremez.
        cur.execute(f"ALTER ROLE db_datareader ADD MEMBER [{user}]")
        cur.execute(f"ALTER ROLE db_datawriter ADD MEMBER [{user}]")
        cur.execute(f"GRANT EXECUTE ON SCHEMA::dbo TO [{user}]")
    conn.commit()


def run_seeds(conn: pymssql.Connection) -> None:
    for path in sorted(SEED_DIR.glob("*.sql")):
        print(f"[migrate] seed: {path.name}")
        try:
            with conn.cursor() as cur:
                for batch in split_batches(path.read_text(encoding="utf-8")):
                    cur.execute(batch)
            conn.commit()
        except Exception:
            conn.rollback()
            print(f"[migrate] HATA: seed {path.name} geri alındı")
            raise


def main() -> None:
    db_name = env("MSSQL_DB", "MES_DB")
    if not IDENT_RE.match(db_name):
        sys.exit("[migrate] MSSQL_DB geçersiz")

    ensure_database(db_name)
    conn = connect(db_name)
    try:
        ensure_migrations_table(conn)
        run_migrations(conn)
        ensure_app_user(conn, db_name)
        if os.environ.get("DB_SEED") == "1":
            run_seeds(conn)
    finally:
        conn.close()
    print("[migrate] tamamlandı")


if __name__ == "__main__":
    main()
