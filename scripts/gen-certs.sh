#!/bin/sh
# Geliştirme/test için kendinden imzalı CA + sunucu sertifikası üretir (infra/certs).
# Üretimde kurumunuzun CA'sından alınmış sertifikaları aynı dosya adlarıyla koyun.
#   scripts/gen-certs.sh mes.fabrika.local 10.0.0.15
set -eu
cd "$(dirname "$0")/.."
NAME="${1:-localhost}"
IP="${2:-127.0.0.1}"
OUT=infra/certs
mkdir -p "$OUT"
if [ -f "$OUT/server.crt" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "infra/certs/server.crt zaten var (yeniden üretmek için FORCE=1)"; exit 0
fi
docker run --rm --entrypoint sh -v "$PWD/$OUT":/out -w /out alpine/openssl:3.5.4 -c "
  openssl req -x509 -new -nodes -newkey rsa:3072 -keyout ca.key -out ca.crt -days 3650 -subj '/CN=V-MES Dev CA' >/dev/null 2>&1 &&
  openssl req -new -nodes -newkey rsa:2048 -keyout server.key -out server.csr -subj '/CN=$NAME' >/dev/null 2>&1 &&
  printf 'subjectAltName=DNS:$NAME,DNS:localhost,DNS:emqx,DNS:web,IP:$IP,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' > ext.cnf &&
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 825 -extfile ext.cnf >/dev/null 2>&1 &&
  rm -f server.csr ext.cnf ca.srl && chmod 644 ca.crt server.crt && chmod 640 server.key ca.key"
echo "Üretildi: $OUT/ca.crt, server.crt, server.key (SAN: $NAME, $IP)"
