#!/bin/sh
# EMQX başlatılmadan önce MQTT servis hesaplarını ve ACL'i ortam değişkenlerinden üretir.
# Kullanıcılar built-in veritabanına yalnızca ilk açılışta (kullanıcı yoksa) yüklenir.
set -eu

: "${MQTT_NODERED_USER:?}" "${MQTT_NODERED_PASSWORD:?}" "${MQTT_INGESTION_USER:?}" "${MQTT_INGESTION_PASSWORD:?}"

OUT=/opt/emqx/data/mes
mkdir -p "$OUT"

cat > "$OUT/users.csv" <<CSV
user_id,password,is_superuser
${MQTT_NODERED_USER},${MQTT_NODERED_PASSWORD},false
${MQTT_INGESTION_USER},${MQTT_INGESTION_PASSWORD},false
CSV
chmod 600 "$OUT/users.csv"

cat > "$OUT/acl.conf" <<ACL
%% Otomatik üretilir (infra/emqx/entrypoint.sh) — elle düzenlemeyin.
%% Node-RED (edge): yalnızca UNS ağacına yayın yapar.
{allow, {username, "${MQTT_NODERED_USER}"}, publish, ["factory/#"]}.
%% Ingestion: yalnızca UNS ağacını dinler.
{allow, {username, "${MQTT_INGESTION_USER}"}, subscribe, ["factory/#"]}.
%% Dashboard için sistem topic'leri
{allow, {username, {re, "^dashboard\$"}}, subscribe, ["\$SYS/#"]}.
{deny, all}.
ACL

export EMQX_AUTHENTICATION='[{mechanism = password_based, backend = built_in_database, user_id_type = username, password_hash_algorithm {name = sha256, salt_position = suffix}, bootstrap_file = "/opt/emqx/data/mes/users.csv", bootstrap_type = plain}]'
export EMQX_AUTHORIZATION__NO_MATCH=deny
export EMQX_AUTHORIZATION__DENY_ACTION=disconnect
export EMQX_AUTHORIZATION__SOURCES='[{type = file, enable = true, path = "/opt/emqx/data/mes/acl.conf"}]'

exec /usr/bin/docker-entrypoint.sh "$@"
