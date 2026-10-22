#!/usr/bin/env bash
# Test CA + PostgreSQL (pg-tls, :54330) and MySQL (my-tls, :33071) with TLS, for tls.integration.test.ts.
# Usage: scripts/tls-test-servers.sh <dir for the certificates> <docker network shared with the ssh service>
set -euo pipefail
dir="$1"
network="$2"
mkdir -p "$dir"
cd "$dir"
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=Test CA" -keyout ca.key -out ca.crt 2>/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=Other CA" -keyout other.key -out other.crt 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=pg-tls" -keyout server.key -out server.csr 2>/dev/null
printf "subjectAltName=DNS:pg-tls,DNS:my-tls,DNS:localhost\n" > ext.cnf
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 30 -extfile ext.cnf -out server.crt 2>/dev/null
chmod 644 server.key
docker rm -f pg-tls my-tls >/dev/null 2>&1 || true
# The servers want their key private to their own user, so each copies it in before starting.
docker run -d --name pg-tls --network "$network" -p 54330:5432 -e POSTGRES_PASSWORD=mastermind -v "$dir:/tls:ro" \
  --entrypoint sh postgres:17-alpine -c 'cp /tls/server.key /tls/server.crt /etc/ && chown postgres /etc/server.key && chmod 600 /etc/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/etc/server.crt -c ssl_key_file=/etc/server.key' >/dev/null
docker run -d --name my-tls --network "$network" -p 33071:3306 -e MYSQL_ROOT_PASSWORD=mastermind -v "$dir:/tls:ro" \
  --entrypoint bash mysql:8.4 -c 'mkdir -p /etc/mytls && cp /tls/ca.crt /tls/server.crt /tls/server.key /etc/mytls/ && chown -R mysql /etc/mytls && exec docker-entrypoint.sh mysqld --ssl-ca=/etc/mytls/ca.crt --ssl-cert=/etc/mytls/server.crt --ssl-key=/etc/mytls/server.key' >/dev/null
for i in $(seq 1 60); do
  docker logs pg-tls 2>&1 | grep -q 'ready to accept connections' && docker logs my-tls 2>&1 | grep -q "ready for connections. Version.*port: 3306" && exit 0
  sleep 3
done
echo "TLS test servers did not start" >&2
exit 1
