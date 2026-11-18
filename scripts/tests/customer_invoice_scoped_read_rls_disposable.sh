#!/usr/bin/env bash
# Disposable PG16 verification of CST Invoice B1/B2/B3. Never shared DEV/PROD.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
QA_NAME="cst-invoice-read-rls-$$"
cleanup() { docker rm -f "$QA_NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

if docker ps -aq --filter "name=^/$QA_NAME$" | grep -q .; then
  echo INVOICE_B1_B3_QA_CONTAINER_NAME_IN_USE; exit 3
fi
docker run -d --rm --network none --name "$QA_NAME" \
  --memory 500m --cpus 1 \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,size=256m \
  -e POSTGRES_PASSWORD=synthetic-only-rls postgres:16-alpine > /dev/null
ready=0
for _ in $(seq 1 60); do
  if docker exec "$QA_NAME" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep .25
done
test "$ready" -eq 1
files=(
 scripts/tests/customer_invoice_read_b1_fixture.qa.sql
 scripts/sql/customer_invoice_scoped_writer_read_phase_b1_cst_dev.sql
 scripts/tests/customer_invoice_read_b1_assert.qa.sql
 scripts/sql/customer_invoice_scoped_writer_read_phase_b1_rollback_cst_dev.sql
 scripts/tests/customer_invoice_read_b2_fixture.qa.sql
 scripts/sql/customer_invoice_scoped_identity_read_phase_b2_cst_dev.sql
 scripts/tests/customer_invoice_read_b2_assert.qa.sql
 scripts/sql/customer_invoice_scoped_identity_read_phase_b2_rollback_cst_dev.sql
 scripts/tests/customer_invoice_lock_b3_fixture.qa.sql
 scripts/sql/customer_invoice_scoped_auth_lock_phase_b3_cst_dev.sql
 scripts/tests/customer_invoice_lock_b3_assert.qa.sql
 scripts/sql/customer_invoice_scoped_auth_lock_phase_b3_rollback_cst_dev.sql
)
for item in "${files[@]}"; do
 test -f "$ROOT/$item"
 docker cp "$ROOT/$item" "$QA_NAME":"/tmp/$(basename "$item")"
done
psql_admin() {
 docker exec "$QA_NAME" psql -X -q -v ON_ERROR_STOP=1 \
   -U postgres -d postgres "$@"
}
for file in \
 customer_invoice_read_b1_fixture.qa.sql \
 customer_invoice_scoped_writer_read_phase_b1_cst_dev.sql \
 customer_invoice_read_b2_fixture.qa.sql \
 customer_invoice_scoped_identity_read_phase_b2_cst_dev.sql \
 customer_invoice_lock_b3_fixture.qa.sql \
 customer_invoice_scoped_auth_lock_phase_b3_cst_dev.sql; do
 psql_admin -f "/tmp/$file"
done

psql_admin -c "ALTER ROLE bizportal_customer_invoice_cst_writer_dev
 LOGIN PASSWORD 'synthetic-only-rls';"
psql_admin -c "ALTER ROLE bizportal_customer_invoice_diva_writer_dev
 LOGIN PASSWORD 'synthetic-only-rls';"
for role in bizportal_customer_invoice_cst_writer_dev \
            bizportal_customer_invoice_diva_writer_dev; do
 for file in customer_invoice_read_b1_assert.qa.sql \
             customer_invoice_read_b2_assert.qa.sql \
             customer_invoice_lock_b3_assert.qa.sql; do
  docker exec -e PGPASSWORD=synthetic-only-rls "$QA_NAME" \
   psql -X -q -h 127.0.0.1 -U "$role" -d postgres \
   -v ON_ERROR_STOP=1 -f "/tmp/$file"
 done
 # Deliberately blocked attempts may return nonzero; never suppress success.
 if docker exec -e PGPASSWORD=synthetic-only-rls "$QA_NAME" \
   psql -X -q -h 127.0.0.1 -U "$role" -d postgres \
     -v ON_ERROR_STOP=1 -c "SELECT password_hash FROM public.users" \
     >/dev/null 2>&1; then
   echo INVOICE_RLS_B1_B3_PRIVATE_USER_COLUMN_EXPOSED; exit 5
 fi
 if docker exec -e PGPASSWORD=synthetic-only-rls "$QA_NAME" \
   psql -X -q -h 127.0.0.1 -U "$role" -d postgres \
     -v ON_ERROR_STOP=1 -c 'SET ROLE postgres' >/dev/null 2>&1; then
   echo INVOICE_RLS_B1_B3_IMPERSONATION_ALLOWED; exit 6
 fi
 echo "B1_B3_DIRECT_TENANT_LOGIN_NON_MUTATING_PASS $role"
done
psql_admin -c "ALTER ROLE bizportal_customer_invoice_cst_writer_dev NOLOGIN;
 ALTER ROLE bizportal_customer_invoice_diva_writer_dev NOLOGIN;"
# Roll back from the most recent stage, retaining prior stage invariants.
for file in \
 customer_invoice_scoped_auth_lock_phase_b3_rollback_cst_dev.sql \
 customer_invoice_scoped_identity_read_phase_b2_rollback_cst_dev.sql \
 customer_invoice_scoped_writer_read_phase_b1_rollback_cst_dev.sql; do
 psql_admin -f "/tmp/$file"
done
count="$(psql_admin -At -c "SELECT count(*) FROM pg_policies
  WHERE schemaname='public' AND policyname LIKE 'cst_invoice_b%';")"
test "$count" = 0
roles="$(psql_admin -At -c "SELECT count(*) FROM pg_roles WHERE
  rolname LIKE 'bizportal_customer_invoice_%' AND rolcanlogin=false;")"
test "$roles" = 2
actors="$(psql_admin -At -c "SELECT count(*) FROM
 public.bizportal_customer_ar_source_actors_dev WHERE enabled=false;")"
test "$actors" = 2
echo CUSTOMER_INVOICE_B1_B2_B3_DIRECT_RLS_AND_ROLLBACK_PASS
