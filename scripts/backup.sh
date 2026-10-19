#!/bin/sh
# MES_DB tam yedeği: ./backups/MES_DB_YYYYmmdd_HHMMSS.bak (MSSQL konteynerindeki /var/opt/mssql/backup ile aynı klasör)
set -eu
cd "$(dirname "$0")/.."
TARGET_DB="${DB:-}"
set -a; . ./.env; set +a
# Hedef veritabanı: DB=... ile seçilebilir (varsayılan .env içindeki MSSQL_DB)
DB="${TARGET_DB:-${MSSQL_DB:-MES_DB}}"
TS=$(date -u +%Y%m%d_%H%M%S)
FILE="/var/opt/mssql/backup/${DB}_${TS}.bak"
docker compose exec -T mssql /opt/mssql-tools18/bin/sqlcmd -C -b -S localhost -U sa -P "$MSSQL_SA_PASSWORD" \
  -Q "BACKUP DATABASE [$DB] TO DISK = N'$FILE' WITH INIT, CHECKSUM, STATS = 25"
docker compose exec -T mssql /opt/mssql-tools18/bin/sqlcmd -C -b -S localhost -U sa -P "$MSSQL_SA_PASSWORD" \
  -Q "RESTORE VERIFYONLY FROM DISK = N'$FILE' WITH CHECKSUM" >/dev/null
echo "Yedek alındı ve doğrulandı: backups/${DB}_${TS}.bak"
# Eski yedekler: BACKUP_KEEP_DAYS (varsayılan 14) günden eskileri sil
find backups -name "${DB}_*.bak" -mtime "+${BACKUP_KEEP_DAYS:-14}" -print -delete 2>/dev/null || true
