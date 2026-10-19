#!/bin/sh
# Yedekten geri yükleme. MEVCUT VERİTABANININ ÜZERİNE YAZAR.
#   scripts/restore.sh backups/MES_DB_20261019_020000.bak --yes
set -eu
cd "$(dirname "$0")/.."
[ $# -ge 1 ] || { echo "Kullanım: scripts/restore.sh backups/<dosya>.bak --yes"; exit 1; }
[ "${2:-}" = "--yes" ] || { echo "Bu işlem mevcut veritabanının üzerine yazar. Onaylamak için --yes ekleyin."; exit 1; }
TARGET_DB="${DB:-}"
set -a; . ./.env; set +a
# Hedef veritabanı: DB=... ile seçilebilir (varsayılan .env içindeki MSSQL_DB)
DB="${TARGET_DB:-${MSSQL_DB:-MES_DB}}"
FILE="/var/opt/mssql/backup/$(basename "$1")"
echo "Yazan servisler durduruluyor (ingestion, api)…"
docker compose stop ingestion api >/dev/null
docker compose exec -T mssql /opt/mssql-tools18/bin/sqlcmd -C -b -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -Q "
  ALTER DATABASE [$DB] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
  RESTORE DATABASE [$DB] FROM DISK = N'$FILE' WITH REPLACE, CHECKSUM, STATS = 25;
  ALTER DATABASE [$DB] SET MULTI_USER;"
MSSQL_DB="$DB" docker compose run --rm db-migrate >/dev/null   # uygulama kullanıcısını yeniden eşle, bekleyen migration'ları uygula
docker compose start api ingestion >/dev/null
echo "Geri yüklendi: $1"
