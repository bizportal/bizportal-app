#!/usr/bin/env bash
# Exercise the separately reviewed release SQL as a NON-superuser postgres,
# with exact live policy expressions and synthetic rows/credentials only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${FINANCE_PHASE2_PG_IMAGE:-postgres:16-alpine}"
case "$IMAGE" in postgres:16-alpine|postgres:17-alpine) ;; *) exit 4;; esac
NAME=cst-finance-phase2-release-test
test -z "$(docker ps -a --filter "name=^$NAME$" --format '{{.Names}}')"
cleanup(){ docker rm -f "$NAME" >/dev/null 2>&1 || :; }
trap cleanup EXIT
docker run -d --rm --pull never --network none --name "$NAME" \
 --memory 256m --cpus 1 --tmpfs /var/lib/postgresql/data:rw,nosuid,size=192m \
 -e POSTGRES_USER=bootstrap -e POSTGRES_DB=postgres \
 -e POSTGRES_HOST_AUTH_METHOD=trust "$IMAGE" >/dev/null
ready=false
for _ in $(seq 1 80); do
 if docker exec "$NAME" pg_isready -q -h127.0.0.1 -U bootstrap -d postgres;then ready=true;break;fi
 sleep .2
done
test "$ready" = true
bootstrap(){ docker exec -i "$NAME" psql -X -v ON_ERROR_STOP=1 -U bootstrap -d postgres -Atq; }
admin(){ docker exec -i "$NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -Atq; }
bootstrap < "$ROOT/scripts/tests/pr107-finance-synthetic-baseline.sql" >/dev/null
bootstrap <<'SQL' >/dev/null
CREATE ROLE postgres LOGIN CREATEROLE CREATEDB NOINHERIT NOSUPERUSER BYPASSRLS;
ALTER DATABASE postgres OWNER TO postgres;
DO $owners$ DECLARE x record; BEGIN
 FOR x IN SELECT tablename FROM pg_tables WHERE schemaname='public'
 LOOP EXECUTE format('ALTER TABLE public.%I OWNER TO postgres',x.tablename); END LOOP;
END $owners$;
CREATE TYPE mkt_po_status AS ENUM ('pending','confirmed','cancelled');
CREATE TYPE vi_status AS ENUM ('draft','submitted','ready_for_ap');
CREATE TYPE mkt_ap_preparation_status AS ENUM ('ap_preparation','finance_review','waiting_payment');
CREATE TYPE pay_req_status AS ENUM ('draft','submitted','paid');
ALTER TABLE public.vendor_invoices ADD COLUMN journal_entry_id integer;
ALTER TABLE public.mkt_ap_preparations ADD COLUMN vendor_invoice_id integer;
ALTER TABLE public.mkt_accounting_handoffs ADD COLUMN accounting_status text,
 ADD COLUMN ap_preparation_id integer,ADD COLUMN payment_request_id integer;
ALTER TABLE public.payment_requests ADD COLUMN status text,ADD COLUMN source_type text,
 ADD COLUMN mkt_ap_preparation_id integer,ADD COLUMN journal_entry_id integer;
SQL
admin < "$ROOT/scripts/tests/pr121-real-finance-rls-predicates-disposable.sql" >/dev/null
test "$(printf '%s\n' "SELECT NOT rolsuper AND rolcreaterole AND rolbypassrls FROM pg_roles WHERE rolname=current_user;" | admin)" = t
test "$(printf '%s\n' 'SHOW createrole_self_grant;' | admin)" = ''
echo FINANCE_PHASE2_NON_SUPERUSER_ADMIN_CONFIRMED
admin < "$ROOT/scripts/sql/20261117_dev_finance_dormant_roles_phase0.sql" >/dev/null
admin < "$ROOT/scripts/sql/20261117_dev_finance_company_rls_phase1.sql" >/dev/null
admin < "$ROOT/scripts/sql/20261117_dev_finance_parent_lock_phase2.sql" >/dev/null
test "$(printf '%s\n' "SELECT pg_has_role('postgres','bizportal_finance_parent_lock_owner_dev','SET');" | admin)" = f
echo FINANCE_PHASE2_EXACT_LIVE_RLS_AND_OWNER_TRANSFER_PASS

admin <<'SQL' >/dev/null
UPDATE public.mkt_purchase_orders SET vendor_token=repeat(CASE WHEN id=11 THEN 'a' ELSE 'b' END,64),
 vendor_token_expires_at=(clock_timestamp() AT TIME ZONE 'UTC')+interval '1 day';
ALTER ROLE bizportal_finance_cst_login_dev LOGIN CONNECTION LIMIT 2 PASSWORD 'synthetic-cst-phase2-only';
ALTER ROLE bizportal_finance_diva_login_dev LOGIN CONNECTION LIMIT 2 PASSWORD 'synthetic-diva-phase2-only';
SQL
for pair in "bizportal_finance_cst_login_dev:11:13:10:a:3" "bizportal_finance_diva_login_dev:31:33:35:b:1";do
 IFS=: read -r role po gr vendor token_char spoof <<<"$pair"
 result="$(printf '%s\n' "BEGIN;SET LOCAL app.marketplace_company_id='$spoof';SELECT current_user=session_user,finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev($po,$gr,$vendor,repeat('$token_char',64));ROLLBACK;" | docker exec -i "$NAME" psql -X -v ON_ERROR_STOP=1 -U "$role" -d postgres -Atq)"
 test "$result" = 't|t'
done
echo FINANCE_PHASE2_BOTH_COMPANY_SESSION_LOCKS_PASS
if admin < "$ROOT/scripts/sql/20261117_dev_finance_parent_lock_phase2_rollback.sql" >/dev/null 2>&1;then
 echo FINANCE_PHASE2_ACTIVE_ROLE_ROLLBACK_UNEXPECTEDLY_ALLOWED;exit 5
fi
test "$(printf '%s\n' "SELECT to_regnamespace('finance_ops_private') IS NOT NULL;" | admin)" = t
admin <<'SQL' >/dev/null
ALTER ROLE bizportal_finance_cst_login_dev NOLOGIN CONNECTION LIMIT 0 PASSWORD NULL;
ALTER ROLE bizportal_finance_diva_login_dev NOLOGIN CONNECTION LIMIT 0 PASSWORD NULL;
SQL
admin < "$ROOT/scripts/sql/20261117_dev_finance_parent_lock_phase2_rollback.sql" >/dev/null
test "$(printf '%s\n' "SELECT to_regnamespace('finance_ops_private') IS NULL AND to_regrole('bizportal_finance_parent_lock_owner_dev') IS NULL;" | admin)" = t
admin < "$ROOT/scripts/sql/20261117_dev_finance_company_rls_phase1_rollback.sql" >/dev/null
admin < "$ROOT/scripts/sql/20261117_dev_finance_dormant_roles_phase0_rollback.sql" >/dev/null
test "$(printf '%s\n' "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname LIKE 'pr50_finance_dev_%';" | admin)" = 18
echo FINANCE_PHASE2_NON_SUPERUSER_FULL_ROLLBACK_PASS
