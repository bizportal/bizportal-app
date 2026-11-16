#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${PR107_DISPOSABLE_PG_IMAGE:-postgres:16-alpine}"
case "$IMAGE" in postgres:16-alpine|postgres:17-alpine) ;; *) echo BAD_PG_IMAGE; exit 7;; esac
NAME=cst-pr107-finance-rls-ci
DB=cst_pr107_ci
INSTALL="$ROOT/scripts/sql/20261117_pr107_finance_company_roles_RLS_REVIEW_ONLY.sql"
ROLLBACK="$ROOT/scripts/sql/20261117_pr107_finance_company_roles_ROLLBACK_REVIEW_ONLY.sql"
FIXTURE="$ROOT/scripts/tests/pr107-finance-synthetic-baseline.sql"
test -s "$INSTALL" && test -s "$ROLLBACK" && test -s "$FIXTURE"
test -z "$(docker ps -a --filter "name=^$NAME$" --format '{{.Names}}')"
TMP="$(mktemp -d -t pr107-finance-XXXXXX)"
cleanup(){ docker rm -f "$NAME" >/dev/null 2>&1 || :; rm -rf "$TMP"; }
trap cleanup EXIT
docker run -d --rm --network none --name "$NAME" --memory 256m --cpus 1 \
 --tmpfs /var/lib/postgresql/data:rw,nosuid,size=192m \
 -e POSTGRES_DB="$DB" -e POSTGRES_USER=postgres \
 -e POSTGRES_HOST_AUTH_METHOD=trust "$IMAGE" >/dev/null
ready=false
for _ in $(seq 1 80); do
 if docker exec "$NAME" pg_isready -q -U postgres -d "$DB" >/dev/null 2>&1; then
  sleep .4
  if docker exec "$NAME" pg_isready -q -U postgres -d "$DB" >/dev/null 2>&1; then ready=true;break;fi
 fi
 sleep .25
done
test "$ready" = true || { echo PG_STARTUP_FAILED; exit 8; }
psql_ci(){ docker exec -i "$NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$DB" -Atq; }
query(){ printf '%s\n' "$1" | psql_ci; }
psql_ci < "$FIXTURE" >/dev/null
test "$(query "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND 'bizportal_marketplace_finance_login_dev'=ANY(roles);")" = 18
policy_hash(){
 query "SELECT md5(string_agg(format('%s|%s|%s|%s|%s',tablename,policyname,cmd,coalesce(qual,''),coalesce(with_check,'')),',' ORDER BY tablename,policyname)) FROM pg_policies WHERE schemaname='public' AND policyname LIKE 'pr50_finance_dev_%';"
}
OLD="$(policy_hash)"
test -n "$OLD"
if psql_ci < "$INSTALL" >/dev/null 2>&1; then echo INSTALL_GUARD_BYPASSED;exit 9;fi
if psql_ci < "$ROLLBACK" >/dev/null 2>&1; then echo ROLLBACK_GUARD_BYPASSED;exit 10;fi
test "$(query "SELECT count(*) FROM pg_roles WHERE rolname IN ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev');")" = 0
echo PR107_SOURCE_SQL_GUARDS_REJECT_EXECUTION_PASS
python3 - "$INSTALL" "$ROLLBACK" "$TMP" <<'PY'
from pathlib import Path
import sys
for src,name in zip(sys.argv[1:3],["install.sql","rollback.sql"]):
 s=Path(src).read_text(); marker="DO $no_go$\nBEGIN\n"
 assert s.count(marker)==1, "intentional execution guard missing"
 a=s.index(marker); b=s.index("$no_go$;\n",a)+len("$no_go$;\n")
 (Path(sys.argv[3])/name).write_text(s[:a]+s[b:])
PY
psql_ci < "$TMP/install.sql" >/dev/null
test "$(policy_hash)" = "$OLD"
test "$(query "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname='pr107_company_role_restrictive_all' AND permissive='RESTRICTIVE' AND cmd='ALL';")" = 11
test "$(query "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname LIKE 'pr50_finance_dev_%' AND 'bizportal_marketplace_finance_login_dev'=ANY(roles) AND 'bizportal_finance_cst_login_dev'=ANY(roles) AND 'bizportal_finance_diva_login_dev'=ANY(roles);")" = 18
echo PR107_EIGHTEEN_POLICY_PREDICATES_PRESERVED_PASS
for role in bizportal_finance_cst_login_dev bizportal_finance_diva_login_dev;do
 count="$(query "WITH a AS (SELECT table_name,column_name,privilege_type FROM information_schema.column_privileges WHERE table_schema='public' AND grantee='bizportal_marketplace_finance_login_dev'),b AS (SELECT table_name,column_name,privilege_type FROM information_schema.column_privileges WHERE table_schema='public' AND grantee='$role'), delta AS ((SELECT * FROM a EXCEPT SELECT * FROM b) UNION ALL (SELECT * FROM b EXCEPT SELECT * FROM a)) SELECT count(*) FROM delta;")"
 test "$count" = 0 || { echo GRANT_DRIFT_"$role"_"$count";exit 11; }
done
echo PR107_EFFECTIVE_COLUMN_PRIVILEGE_PARITY_PASS
for company in cst diva; do
 if test "$company" = cst;then role=bizportal_finance_cst_login_dev;own=1;other=3;ownpo=11;otherpo=31;ownvi=14;othervi=34;ownap=16;otherap=36
 else role=bizportal_finance_diva_login_dev;own=3;other=1;ownpo=31;otherpo=11;ownvi=34;othervi=14;ownap=36;otherap=16
 fi
 result="$(psql_ci <<SQL
BEGIN;
SET LOCAL ROLE $role;
SELECT set_config('app.marketplace_company_id','$other',true);
DO \$scope\$
DECLARE nm text;visible integer;
BEGIN
 FOREACH nm IN ARRAY ARRAY['mkt_purchase_orders','mkt_purchase_order_lines','mkt_po_shipments','mkt_po_shipment_items','mkt_po_goods_receipts','mkt_po_goods_receipt_items','vendor_invoices','vendor_invoice_lines','mkt_ap_preparations','payment_requests','mkt_accounting_handoffs'] LOOP
  EXECUTE format('SELECT count(*) FROM public.%I',nm) INTO visible;
  IF visible<>1 THEN RAISE EXCEPTION 'TENANT_VISIBLE_ROWS_BAD % %',nm,visible; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM public.mkt_purchase_orders WHERE id=$ownpo)
 OR EXISTS(SELECT 1 FROM public.mkt_purchase_orders WHERE id=$otherpo) THEN
  RAISE EXCEPTION 'OTHER_COMPANY_PO_VISIBLE'; END IF;
END
\$scope\$;
INSERT INTO public.vendor_invoices(company_id,vendor_invoice_ref) VALUES($own,'ci-owned');
DO \$deny\$
DECLARE blocked boolean:=false;
BEGIN
 BEGIN INSERT INTO public.vendor_invoices(company_id,vendor_invoice_ref) VALUES($other,'ci-denied');
 EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'CROSS_TENANT_INSERT_WAS_ALLOWED'; END IF;
END
\$deny\$;
DO \$update\$
DECLARE affected integer;
BEGIN
 UPDATE public.vendor_invoices SET status='matched' WHERE id=$ownvi;
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>1 THEN RAISE EXCEPTION 'OWN_VENDOR_INVOICE_UPDATE_FAILED'; END IF;
 UPDATE public.vendor_invoices SET status='matched' WHERE id=$othervi;
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>0 THEN RAISE EXCEPTION 'CROSS_VENDOR_INVOICE_UPDATE_ALLOWED'; END IF;
 UPDATE public.mkt_ap_preparations SET status='ready' WHERE id=$ownap;
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>1 THEN RAISE EXCEPTION 'OWN_AP_UPDATE_FAILED'; END IF;
 UPDATE public.mkt_ap_preparations SET status='ready' WHERE id=$otherap;
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>0 THEN RAISE EXCEPTION 'CROSS_AP_UPDATE_ALLOWED'; END IF;
END
\$update\$;
ROLLBACK;
SELECT 'PR107_${company}_READ_WRITE_ISOLATION_PASS';
SQL
)"
 grep -q "PR107_${company}_READ_WRITE_ISOLATION_PASS" <<< "$result"
 echo "PR107_${company}_READ_WRITE_ISOLATION_PASS"
done
test "$(query "SELECT count(*) FROM public.vendor_invoices;")" = 2
psql_ci < "$TMP/rollback.sql" >/dev/null
test "$(policy_hash)" = "$OLD"
test "$(query "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname='pr107_company_role_restrictive_all';")" = 0
test "$(query "SELECT count(*) FROM pg_roles WHERE rolname IN ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev');")" = 0
test "$(query "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname LIKE 'pr50_finance_dev_%' AND roles=ARRAY['bizportal_marketplace_finance_login_dev']::name[];")" = 18
echo PR107_ROLLBACK_EXACT_ORIGINAL_RLS_AND_ROLES_PASS
echo PR107_GUARDED_FINANCE_ROLE_MIGRATION_DISPOSABLE_PASS
