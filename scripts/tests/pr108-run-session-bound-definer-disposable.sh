#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${PR108_DISPOSABLE_PG_IMAGE:-postgres:16-alpine}"
case "$IMAGE" in postgres:16-alpine|postgres:17-alpine) ;; *) echo PR108_UNKNOWN_IMAGE;exit 7;; esac
NAME=cst-pr108-company-definer-ci
DB=cst_pr107_ci
BASE="$ROOT/scripts/tests/pr107-finance-synthetic-baseline.sql"
PR107="$ROOT/scripts/sql/20261117_pr107_finance_company_roles_RLS_REVIEW_ONLY.sql"
BACK107="$ROOT/scripts/sql/20261117_pr107_finance_company_roles_ROLLBACK_REVIEW_ONLY.sql"
PR108="$ROOT/scripts/sql/20261117_pr108_session_bound_vendor_lock_REVIEW_ONLY.sql"
BACK108="$ROOT/scripts/sql/20261117_pr108_session_bound_vendor_lock_ROLLBACK_REVIEW_ONLY.sql"
for f in "$BASE" "$PR107" "$BACK107" "$PR108" "$BACK108";do test -s "$f";done
test -z "$(docker ps -a --filter "name=^$NAME$" --format '{{.Names}}')"
TMP="$(mktemp -d -t pr108-session-ci-XXXXXX)"
HOLDER_PID=''
cleanup(){
  if test -n "$HOLDER_PID";then kill "$HOLDER_PID" >/dev/null 2>&1 || :;fi
  docker rm -f "$NAME" >/dev/null 2>&1 || :
  rm -rf "$TMP"
}
trap cleanup EXIT
docker run -d --rm --network none --name "$NAME" --memory 256m --cpus 1 \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,size=192m \
  -e POSTGRES_DB="$DB" -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=synthetic-admin-only \
  -e POSTGRES_HOST_AUTH_METHOD=scram-sha-256 "$IMAGE" >/dev/null
ready=false
for _ in $(seq 1 80);do
 if docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U postgres -d "$DB" >/dev/null 2>&1;then
   sleep .4
   if docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U postgres -d "$DB" >/dev/null 2>&1;then ready=true;break;fi
 fi
 sleep .25
done
test "$ready" = true || { echo PR108_PG_STARTUP_FAILED;exit 8; }
admin(){ docker exec -i -e PGPASSWORD=synthetic-admin-only "$NAME" \
  psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d "$DB" -Atq; }
company(){
 local username="$1" pass="$2"
 docker exec -i -e "PGPASSWORD=$pass" "$NAME" \
  psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$username" -d "$DB" -Atq
}
query(){ printf '%s\n' "$1" | admin; }
admin < "$BASE" >/dev/null
test "$(query "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND 'bizportal_marketplace_finance_login_dev'=ANY(roles);")" = 18
for f in "$PR107" "$BACK107" "$PR108" "$BACK108";do
 if admin < "$f" >/dev/null 2>&1;then echo PR108_REVIEW_ONLY_GUARD_MISSING;exit 9;fi
done
echo PR108_ALL_FOUR_REVIEW_ONLY_GUARDS_PASS
python3 - "$TMP" "$PR107" "$BACK107" "$PR108" "$BACK108" <<'PY'
from pathlib import Path
import sys
dest=Path(sys.argv[1])
for p in sys.argv[2:]:
 s=Path(p).read_text();guard="DO $no_go$\nBEGIN\n"
 assert s.count(guard)==1,(p,'guard count mismatch')
 a=s.index(guard);b=s.index("$no_go$;\n",a)+len("$no_go$;\n")
 (dest/Path(p).name).write_text(s[:a]+s[b:])
PY
strip107="$TMP/$(basename "$PR107")"
strip107back="$TMP/$(basename "$BACK107")"
strip108="$TMP/$(basename "$PR108")"
strip108back="$TMP/$(basename "$BACK108")"
admin < "$strip107" >/dev/null
admin < "$strip108" >/dev/null
test "$(query "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname IN ('pr108_definer_read','pr108_definer_lock');")" = 6
test "$(query "SELECT to_regprocedure('finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)') IS NOT NULL;")" = t
echo PR108_SIX_TENANT_BOUND_OWNER_POLICIES_INSTALLED_PASS

# These roles are NOLOGIN in the reviewed design. Set synthetic login/pw
# ONLY here in this disposable container for genuine PostgreSQL authentication.
admin <<'SQL' >/dev/null
UPDATE public.mkt_purchase_orders
  SET vendor_token=repeat('a',64),vendor_token_expires_at=(now() AT TIME ZONE 'UTC')+interval '1 day'
  WHERE id=11;
UPDATE public.mkt_purchase_orders
  SET vendor_token=repeat('b',64),vendor_token_expires_at=(now() AT TIME ZONE 'UTC')+interval '1 day'
  WHERE id=31;
ALTER ROLE bizportal_finance_cst_login_dev LOGIN PASSWORD 'synthetic-cst-db-only';
ALTER ROLE bizportal_finance_diva_login_dev LOGIN PASSWORD 'synthetic-diva-db-only';
ALTER ROLE bizportal_marketplace_finance_login_dev PASSWORD 'synthetic-legacy-db-only';
SQL
# Actual synthetic SCRAM login for CST with session GUC pointing to Diva.
cst_output="$(company bizportal_finance_cst_login_dev synthetic-cst-db-only <<'SQL'
BEGIN;
SELECT set_config('app.marketplace_company_id','3',true);
DO $pr108$
DECLARE first boolean;second boolean;
BEGIN
 IF session_user <> 'bizportal_finance_cst_login_dev'
    OR current_user <> 'bizportal_finance_cst_login_dev'
 THEN RAISE EXCEPTION 'PR108_WRONG_CST_AUTHENTICATED_IDENTITY'; END IF;
 SELECT finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(
    11,13,10,repeat('a',64)) INTO first;
 SELECT finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(
    31,33,35,repeat('b',64)) INTO second;
 IF first IS DISTINCT FROM true OR second IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'PR108_CST_CROSS_COMPANY_LOCKED'; END IF;
END
$pr108$;
ROLLBACK;
SELECT 'PR108_REAL_CST_LOGIN_TENANT_LOCK_PASS';
SQL
)"
grep -q PR108_REAL_CST_LOGIN_TENANT_LOCK_PASS <<< "$cst_output"
echo PR108_REAL_CST_LOGIN_TENANT_LOCK_PASS

diva_output="$(company bizportal_finance_diva_login_dev synthetic-diva-db-only <<'SQL'
BEGIN;
SELECT set_config('app.marketplace_company_id','1',true);
DO $pr108$
DECLARE first boolean;second boolean;
BEGIN
 IF session_user <> 'bizportal_finance_diva_login_dev'
    OR current_user <> 'bizportal_finance_diva_login_dev'
 THEN RAISE EXCEPTION 'PR108_WRONG_DIVA_AUTHENTICATED_IDENTITY'; END IF;
 SELECT finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(
    31,33,35,repeat('b',64)) INTO first;
 SELECT finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(
    11,13,10,repeat('a',64)) INTO second;
 IF first IS DISTINCT FROM true OR second IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'PR108_DIVA_CROSS_COMPANY_LOCKED'; END IF;
END
$pr108$;
ROLLBACK;
SELECT 'PR108_REAL_DIVA_LOGIN_TENANT_LOCK_PASS';
SQL
)"
grep -q PR108_REAL_DIVA_LOGIN_TENANT_LOCK_PASS <<< "$diva_output"
echo PR108_REAL_DIVA_LOGIN_TENANT_LOCK_PASS

# Generic Finance role can set any tenant GUC but must have NO EXECUTE.
if company bizportal_marketplace_finance_login_dev synthetic-legacy-db-only <<'SQL' >"$TMP/generic.out" 2>&1
SELECT set_config('app.marketplace_company_id','1',false);
SELECT finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(11,13,10,repeat('a',64));
SQL
then echo PR108_LEGACY_FINANCE_LOCK_UNEXPECTEDLY_ALLOWED;exit 10;fi
grep -qi 'permission denied' "$TMP/generic.out"
echo PR108_GENERIC_FINANCE_LOGIN_DENIED_EXECUTE_PASS

# Rotate and expire CST token in a parent transaction to prove new function
# still rejects stale or expired token and does not leak cross-company.
admin <<'SQL' >/dev/null
UPDATE public.mkt_purchase_orders SET vendor_token=repeat('c',64) WHERE id=11;
SQL
rotated="$(company bizportal_finance_cst_login_dev synthetic-cst-db-only <<'SQL'
SELECT finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(11,13,10,repeat('a',64)) AS locked;
SQL
)"
test "$(echo "$rotated" | tail -n 1)" = f
echo PR108_ROTATED_TOKEN_REJECTED_PASS
admin <<'SQL' >/dev/null
UPDATE public.mkt_purchase_orders
 SET vendor_token=repeat('a',64),
 vendor_token_expires_at=(now() AT TIME ZONE 'UTC')-interval '2 minutes' WHERE id=11;
SQL
expired="$(company bizportal_finance_cst_login_dev synthetic-cst-db-only <<'SQL'
SELECT finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(11,13,10,repeat('a',64)) AS locked;
SQL
)"
test "$(echo "$expired" | tail -n 1)" = f
echo PR108_EXPIRED_TOKEN_REJECTED_PASS

# Native row locks must also block independent writers. A synthetic
# CST transaction holds PO->GR->Shipment for a few seconds, while a separate
# PostgreSQL superuser session attempts to update each row.
admin <<'SQL' >/dev/null
UPDATE public.mkt_purchase_orders
 SET vendor_token=repeat('a',64),
     vendor_token_expires_at=(now() AT TIME ZONE 'UTC')+interval '1 day'
 WHERE id=11;
SQL
docker exec -i -e PGPASSWORD=synthetic-cst-db-only "$NAME" \
 psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 \
 -U bizportal_finance_cst_login_dev -d "$DB" -Atq >"$TMP/holder.out" 2>&1 <<'SQL' &
BEGIN;
SELECT set_config('app.marketplace_company_id','3',true);
SELECT finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(11,13,10,repeat('a',64));
SELECT pg_sleep(8);
ROLLBACK;
SQL
HOLDER_PID="$!"
sleeping=false
for _ in $(seq 1 60);do
 if test "$(query "SELECT count(*) FROM pg_stat_activity WHERE usename='bizportal_finance_cst_login_dev' AND wait_event='PgSleep';")" = 1;then
  sleeping=true;break
 fi
 sleep .1
done
test "$sleeping" = true || { echo PR108_LOCK_HOLDER_NOT_READY;cat "$TMP/holder.out";exit 14; }
for fixture in \
 "UPDATE public.mkt_purchase_orders SET status='cancelled' WHERE id=11" \
 "UPDATE public.mkt_po_goods_receipts SET inspection_status='failed' WHERE id=13" \
 "UPDATE public.mkt_po_shipments SET shipment_status='cancelled' WHERE id=12";do
 if admin <<SQL >"$TMP/blocked.out" 2>&1
\set VERBOSITY verbose
SET lock_timeout='350ms';
$fixture;
SQL
 then echo PR108_WRITER_NOT_BLOCKED;exit 15;fi
 grep -q '55P03' "$TMP/blocked.out" || { cat "$TMP/blocked.out";exit 16; }
done
echo PR108_PO_GR_SHIPMENT_INDEPENDENT_WRITERS_BLOCKED_PASS
wait "$HOLDER_PID"
HOLDER_PID=''
test "$(query "SELECT status FROM public.mkt_purchase_orders WHERE id=11;")" = confirmed
test "$(query "SELECT inspection_status FROM public.mkt_po_goods_receipts WHERE id=13;")" = passed
test "$(query "SELECT shipment_status FROM public.mkt_po_shipments WHERE id=12;")" = delivered
test "$(query "SELECT status FROM public.mkt_purchase_orders WHERE id=31;")" = confirmed
test "$(query "SELECT inspection_status FROM public.mkt_po_goods_receipts WHERE id=33;")" = passed
test "$(query "SELECT shipment_status FROM public.mkt_po_shipments WHERE id=32;")" = delivered
echo PR108_NATIVE_LOCK_RELEASE_OTHER_TENANT_UNCHANGED_PASS

# Revert the synthetic login grant BEFORE the deliberately guarded rollback.
admin <<'SQL' >/dev/null
ALTER ROLE bizportal_finance_cst_login_dev NOLOGIN PASSWORD NULL;
ALTER ROLE bizportal_finance_diva_login_dev NOLOGIN PASSWORD NULL;
SQL
admin < "$strip108back" >/dev/null
test "$(query "SELECT to_regnamespace('finance_ops_private') IS NULL;")" = t
test "$(query "SELECT to_regrole('bizportal_finance_parent_lock_owner_dev') IS NULL;")" = t
test "$(query "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname LIKE 'pr108_definer_%';")" = 0
echo PR108_OWNER_FUNCTION_SCHEMA_ROLLBACK_PASS
admin < "$strip107back" >/dev/null
test "$(query "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname LIKE 'pr50_finance_dev_%' AND roles=ARRAY['bizportal_marketplace_finance_login_dev']::name[];")" = 18
test "$(query "SELECT count(*) FROM pg_roles WHERE rolname IN ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev','bizportal_finance_parent_lock_owner_dev');")" = 0
echo PR108_PR107_BASELINE_18_POLICIES_PRESERVED_PASS
echo PR108_SESSION_BOUND_DEFINER_DISPOSABLE_PASS
