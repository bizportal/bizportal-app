#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NAME="cst-invoice-parity-$$"
WORK="$(mktemp -d /tmp/cst-invoice-parity.XXXXXXXX)"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf -- "$WORK"; }
trap cleanup EXIT
if docker ps -aq --filter "name=^/$NAME$" | grep -q .; then echo REFUSE_EXISTING_TEST_CONTAINER; exit 4; fi
cd "$ROOT/lib/db"
pnpm exec drizzle-kit generate --schema './src/schema/*.ts' --dialect postgresql --out "$WORK/generated" --name synthetic
SQL="$(find "$WORK/generated" -maxdepth 1 -name '*.sql' -type f -print -quit)"
test -n "$SQL"
test "$(grep -c '^CREATE TYPE ' "$SQL")" -ge 42
test "$(grep -c '^CREATE TABLE ' "$SQL")" -eq 86
docker run -d --rm --name "$NAME" --pull missing \
 --memory 700m --cpus 1 --tmpfs /var/lib/postgresql/data:rw,nosuid,size=384m \
 -e POSTGRES_DB=invoice_synthetic -e POSTGRES_USER=postgres \
 -e POSTGRES_PASSWORD=disposable-only postgres:16-alpine >/dev/null
ready=0
for _ in $(seq 1 80); do
 if docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U postgres -d invoice_synthetic && docker exec "$NAME" psql -X -qAt -h 127.0.0.1 -U postgres -d invoice_synthetic -c 'SELECT 1' 2>/dev/null | grep -qx 1; then ready=1; break; fi
 sleep .25
done
test "$ready" = 1
sleep 2 # PostgreSQL official image may briefly restart after initdb.
docker cp "$SQL" "$NAME":/tmp/generated.sql
docker exec "$NAME" psql -v ON_ERROR_STOP=1 -U postgres -d invoice_synthetic -f /tmp/generated.sql > "$WORK/generated.log"
docker cp "$ROOT/scripts/tests/customer-invoice-owner-disposable-runtime-parity.sql" "$NAME":/tmp/parity.sql
docker exec "$NAME" psql -v ON_ERROR_STOP=1 -U postgres -d invoice_synthetic -f /tmp/parity.sql > "$WORK/parity.log"
count="$(docker exec "$NAME" psql -At -U postgres -d invoice_synthetic -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")"
test "$count" = 90 || { echo "EXPECTED_90_TABLES_GOT_$count"; exit 5; }
echo DISPOSABLE_ACCOUNTING_SCHEMA_90_TABLES_PASS
docker exec "$NAME" createdb -U postgres not_invoice_synthetic
if docker exec "$NAME" psql -v ON_ERROR_STOP=1 -U postgres -d not_invoice_synthetic -f /tmp/parity.sql > "$WORK/wrong.log" 2>&1; then
 echo FAIL_WRONG_DATABASE_ACCEPTED; exit 6
fi
grep -q DISPOSABLE_ONLY "$WORK/wrong.log"
echo WRONG_DATABASE_REJECTED_PASS
docker exec "$NAME" psql -v ON_ERROR_STOP=1 -U postgres -d invoice_synthetic -c "INSERT INTO sales_documents(doc_number,kind,status,invoice_status,customer_name) VALUES ('QA-GUARD','order','confirmed','to_invoice','Synthetic only')" > "$WORK/seed.log"
if docker exec "$NAME" psql -v ON_ERROR_STOP=1 -U postgres -d invoice_synthetic -f /tmp/parity.sql > "$WORK/nonempty.log" 2>&1; then
 echo FAIL_NONEMPTY_SOURCE_ACCEPTED; exit 7
fi
grep -q DISPOSABLE_ONLY "$WORK/nonempty.log"
echo NONEMPTY_DATABASE_REJECTED_PASS
