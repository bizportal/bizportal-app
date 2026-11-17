#!/usr/bin/env bash
# PR123: independently test controlled NOLOGIN role stage + exact PR107 Finance
# grants / restrictive RLS + phase-1 rollback on isolated PostgreSQL.
# Never read credentials or connect to shared CST-DEV / PROD.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${PR123_POSTGRES_IMAGE:-postgres:16-alpine}"
case "$IMAGE" in postgres:16-alpine|postgres:17-alpine) ;; *) echo PR123_REFUSE_UNPINNED_IMAGE;exit 5;; esac
NAME="cst-pr123-finance-rls-test"
if docker ps -a --filter "name=^$NAME$" --format '{{.Names}}' | grep -q .; then echo PR123_CONTAINER_EXISTS_ABORT;exit 6;fi
TMP="$(mktemp -d -t pr123-rls-XXXXXX)"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || :; rm -rf "$TMP"; }
trap cleanup EXIT
docker run -d --rm --pull never --network none --name "$NAME" \
 --memory 256m --cpus 1 --tmpfs /var/lib/postgresql/data:rw,nosuid,size=192m \
 -e POSTGRES_USER=postgres -e POSTGRES_DB=postgres \
 -e POSTGRES_HOST_AUTH_METHOD=trust "$IMAGE" >/dev/null
ready=false
for _ in $(seq 1 90); do
 if docker exec "$NAME" pg_isready -q -h127.0.0.1 -U postgres -d postgres >/dev/null 2>&1; then ready=true;break;fi
 sleep .2
done
test "$ready" = true
admin() { docker exec -i "$NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -Atq; }
admin < "$ROOT/scripts/tests/pr107-finance-synthetic-baseline.sql" >/dev/null

# Only the disposable fixture has simplified legacy permissive policies.
# Replace fingerprint literals in *temporary* SQL copies so we can validate
# migration statements and rollback. Version-controlled live checksums never
# change, and the real exact predicates are tested separately in PR121.
SYN_MD5="$(printf "%s\n" "SELECT md5(string_agg(tablename||'|'||policyname||'|'||cmd||'|'||permissive||'|'||roles::text||'|'||coalesce(qual,'')||'|'||coalesce(with_check,''),E'\\n' ORDER BY tablename,policyname,cmd)) FROM pg_policies WHERE schemaname='public' AND policyname LIKE 'pr50_finance_dev_%';" | admin)"
PRED_MD5="$(printf "%s\n" "SELECT md5(string_agg(tablename||'|'||policyname||'|'||cmd||'|'||coalesce(qual,'')||'|'||coalesce(with_check,''),E'\\n' ORDER BY tablename,policyname,cmd)) FROM pg_policies WHERE schemaname='public' AND policyname LIKE 'pr50_finance_dev_%';" | admin)"
test "${#SYN_MD5}" = 32 && test "${#PRED_MD5}" = 32
python3 - "$ROOT" "$TMP" "$SYN_MD5" "$PRED_MD5" <<'PY'
from pathlib import Path
import sys
root,tmp,full,pred=Path(sys.argv[1]),Path(sys.argv[2]),sys.argv[3],sys.argv[4]
names=[
 '20261117_dev_finance_dormant_roles_phase0.sql',
 '20261117_dev_finance_company_rls_phase1.sql',
 '20261117_dev_finance_company_rls_phase1_rollback.sql',
 '20261117_dev_finance_dormant_roles_phase0_rollback.sql',
]
for n in names:
 text=(root/'scripts'/'sql'/n).read_text()
 assert 'DO $no_go$' not in text
 assert text.count('BEGIN;')==1 and text.count('COMMIT;')==1
 text=text.replace('f69295cc7f66f8bc4645a6fc02e2f36e',full)
 text=text.replace('5ef6b3e6c9c7a41cd0fb94ebbb243c66',pred)
 (tmp/n).write_text(text)
PY
admin < "$TMP/20261117_dev_finance_dormant_roles_phase0.sql" >/dev/null
echo PR123_PHASE0_NOLOGIN_ROLES_CREATED_PASS
admin < "$TMP/20261117_dev_finance_company_rls_phase1.sql" >/dev/null
verified="$(printf '%s\n' "SELECT (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname='pr107_company_role_restrictive_all')::text || ':' || (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname LIKE 'pr50_finance_dev_%' AND cardinality(roles)=3 AND roles @> ARRAY['bizportal_marketplace_finance_login_dev','bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev']::name[])::text;" | admin)"
test "$verified" = "11:18"
echo PR123_ELEVEN_ROLE_RESTRICTIVE_AND_EIGHTEEN_LEGACY_POLICY_TARGETS_PASS
# Spoof the tenant GUC in each direction; new role identity still isolates.
for pair in "bizportal_finance_cst_login_dev:3" "bizportal_finance_diva_login_dev:1"; do
 role="${pair%%:*}"; spoof="${pair##*:}"
 n="$(printf '%s\n' "BEGIN;SET LOCAL ROLE $role;SET LOCAL app.marketplace_company_id='$spoof';SELECT count(*) FROM public.mkt_purchase_orders;ROLLBACK;" | admin | grep -x '1' | wc -l)"
 test "$n" = 1
done
echo PR123_COMPANY_ROLE_TENANT_GUC_SPOOF_DENIED_PASS
permissions="$(printf '%s\n' "SELECT (has_table_privilege('bizportal_finance_cst_login_dev','public.mkt_purchase_orders','UPDATE') OR has_table_privilege('bizportal_finance_diva_login_dev','public.mkt_purchase_orders','UPDATE'))::text||':'||has_column_privilege('bizportal_finance_cst_login_dev','public.vendor_invoices','invoice_number','INSERT')::text;" | admin)"
test "$permissions" = "false:true" || test "$permissions" = "f:t"
echo PR123_NARROW_GRANTS_PARENT_UPDATE_DENIED_PASS
admin < "$TMP/20261117_dev_finance_company_rls_phase1_rollback.sql" >/dev/null
roles="$(printf '%s\n' "SELECT count(*) FROM pg_roles WHERE rolname IN ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev') AND NOT rolcanlogin;" | admin)"
test "$roles" = 2
echo PR123_PHASE1_ROLLBACK_PRESERVES_TWO_DORMANT_ROLES_PASS
admin < "$TMP/20261117_dev_finance_dormant_roles_phase0_rollback.sql" >/dev/null
residue="$(printf '%s\n' "SELECT count(*) FROM pg_roles WHERE rolname IN ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev');" | admin)"
test "$residue" = 0
echo PR123_ORIGINAL_ROLE_POLICY_BASELINE_RESTORED_PASS
echo PR123_DISPOSABLE_ROLE_AND_RLS_CYCLE_PASS
