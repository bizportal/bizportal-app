#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PG=cst-pr102-private-lock-sql-disposable
IMAGE="${PR102_DISPOSABLE_PG_IMAGE:-postgres:16-alpine}"
case "$IMAGE" in
  postgres:16-alpine|postgres:17-alpine) ;;
  *) echo "REFUSE_UNTRUSTED_DISPOSABLE_POSTGRES_IMAGE"; exit 7 ;;
esac

DB=postgres
INSTALL="$ROOT/scripts/sql/20261116_pr102_finance_parent_lock_dev_REVIEW_ONLY.sql"
ROLLBACK="$ROOT/scripts/sql/20261116_pr102_finance_parent_lock_dev_ROLLBACK_REVIEW_ONLY.sql"
test -f "$INSTALL" && test -f "$ROLLBACK"
if docker ps -a --filter "name=^$PG$" --format '{{.Names}}' | grep -q .; then
  echo DUPLICATE_DISPOSABLE_CONTAINER_ABORT; exit 7
fi
cleanup(){ docker rm -f "$PG" >/dev/null 2>&1 || :; }
trap cleanup EXIT
docker run -d --rm --network none --name "$PG"   --memory 256m --cpus 1 --tmpfs /var/lib/postgresql/data:rw,nosuid,size=192m   -e POSTGRES_DB="$DB" -e POSTGRES_USER=postgres   -e POSTGRES_HOST_AUTH_METHOD=trust "$IMAGE" >/dev/null
for i in $(seq 1 60); do
  if docker exec "$PG" pg_isready -q -U postgres -d "$DB" >/dev/null 2>&1;then break;fi
  sleep 0.25
done
docker exec "$PG" pg_isready -q -U postgres -d "$DB"
execsql(){ docker exec -i "$PG" psql -v ON_ERROR_STOP=1 -U postgres -d "$DB" -Atq; }
cat <<'SQL' | execsql
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE bizportal_marketplace_finance_login_dev LOGIN NOINHERIT NOBYPASSRLS;
CREATE TABLE public.mkt_purchase_orders(
 id integer PRIMARY KEY,company_id integer,vendor_id integer,
 status text,vendor_token text,vendor_token_expires_at timestamp);
CREATE TABLE public.mkt_po_shipments(id integer PRIMARY KEY,po_id integer,shipment_status text);
CREATE TABLE public.mkt_po_goods_receipts(
 id integer PRIMARY KEY,shipment_id integer,inspection_status text);
ALTER TABLE public.mkt_purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_po_shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_po_goods_receipts ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.mkt_purchase_orders,public.mkt_po_shipments,
 public.mkt_po_goods_receipts TO bizportal_marketplace_finance_login_dev;
GRANT USAGE ON SCHEMA public TO bizportal_marketplace_finance_login_dev;
INSERT INTO public.mkt_purchase_orders
 VALUES (11,1,10,'confirmed',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  (now() AT TIME ZONE 'UTC')+interval '1 day');
INSERT INTO public.mkt_po_shipments VALUES (12,11,'delivered');
INSERT INTO public.mkt_po_goods_receipts VALUES (13,12,'passed');
DO $pol$
BEGIN
 FOR i IN 1..18 LOOP
   EXECUTE format('CREATE POLICY ci_finance_baseline_%s ON public.mkt_purchase_orders FOR SELECT TO bizportal_marketplace_finance_login_dev USING (company_id = nullif(current_setting(''app.marketplace_company_id'',true),'''')::integer)',i);
 END LOOP;
END
$pol$;
SQL
# Original files must STOP before any CREATE, even on isolated PG16.
if execsql < "$INSTALL" >/dev/null 2>&1;then
  echo REVIEW_ONLY_INSTALL_GUARD_FAILED; exit 8
fi
test "$(echo "select to_regnamespace('finance_ops_private') is null;" | execsql)" = t
echo INSTALL_DO_NOT_APPLY_GUARD_PASS
if execsql < "$ROLLBACK" >/dev/null 2>&1;then
  echo REVIEW_ONLY_ROLLBACK_GUARD_FAILED; exit 9
fi
echo ROLLBACK_DO_NOT_APPLY_GUARD_PASS
# Strip only the intentionally blocking guard in the disposable CI copy.
python3 - "$INSTALL" "$ROLLBACK" <<'PY' > /tmp/pr102-unused-stdout
from pathlib import Path
import re,sys
for src,dest in zip(sys.argv[1:],['/tmp/pr102-review-install-ci.sql','/tmp/pr102-review-rollback-ci.sql']):
 s=Path(src).read_text()
 start=s.index('DO $no_go$\n');end=s.index('$no_go$;\n',start)+len('$no_go$;\n')
 cleaned=s[:start]+s[end:]
 Path(dest).write_text(cleaned)
PY
execsql < /tmp/pr102-review-install-ci.sql > /dev/null
test "$(echo "select to_regnamespace('finance_ops_private') is not null;" | execsql)" = t
echo PRIVATE_SCHEMA_INSTALL_POSTFLIGHT_PASS
result=$(cat <<'SQL' | execsql
BEGIN;
SET LOCAL ROLE bizportal_marketplace_finance_login_dev;
SELECT set_config('app.marketplace_company_id','1',true);
SELECT finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(
 11,13,10,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
ROLLBACK;
SQL
)
test "$(printf "%s\n" "$result" | tail -n 1)" = t
echo SCOPED_FUNCTION_NATIVE_LOCK_PASS
execsql < /tmp/pr102-review-rollback-ci.sql > /dev/null
test "$(echo "select to_regnamespace('finance_ops_private') is null;" | execsql)" = t
test "$(echo "select count(*) from pg_roles where rolname='bizportal_finance_parent_lock_owner_dev';" | execsql)" = 0
test "$(echo "select count(*) from pg_policies where schemaname='public' and 'bizportal_marketplace_finance_login_dev'=ANY(roles);" | execsql)" = 18
echo REVIEW_SQL_INSTALL_ROLLBACK_DISPOSABLE_PASS
rm -f /tmp/pr102-review-install-ci.sql /tmp/pr102-review-rollback-ci.sql
