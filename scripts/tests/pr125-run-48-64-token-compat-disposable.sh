#!/usr/bin/env bash
# PR123: independently test controlled NOLOGIN role stage + exact PR107 Finance
# grants / restrictive RLS + phase-1 rollback on isolated PostgreSQL.
# Never read credentials or connect to shared CST-DEV / PROD.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${PR125_POSTGRES_IMAGE:-postgres:16-alpine}"
case "$IMAGE" in postgres:16-alpine|postgres:17-alpine) ;; *) echo PR125_REFUSE_UNPINNED_IMAGE;exit 5;; esac
NAME="cst-pr125-vendor-token-test"
if docker ps -a --filter "name=^$NAME$" --format '{{.Names}}' | grep -q .; then echo PR125_CONTAINER_EXISTS_ABORT;exit 6;fi
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
# Supabase's built-in API roles exist in live CST-DEV, but not in bare PostgreSQL.
# Create harmless NOLOGIN names in this disposable fixture so privilege-denial
# assertions test real role names rather than raising undefined-role errors.
admin <<'SQL' >/dev/null
CREATE ROLE anon NOLOGIN NOINHERIT NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOINHERIT NOBYPASSRLS;
SQL

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
 '20261117_dev_finance_parent_locks_phase2.sql',
 '20261117_dev_finance_po_vendor_token_48_64_compat.sql',
 '20261117_dev_finance_po_vendor_token_48_64_compat_rollback.sql',
 '20261117_dev_finance_parent_locks_phase2_rollback.sql',
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
echo PR125_PHASE0_NOLOGIN_ROLES_CREATED_PASS
admin < "$TMP/20261117_dev_finance_company_rls_phase1.sql" >/dev/null
verified="$(printf '%s\n' "SELECT (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname='pr107_company_role_restrictive_all')::text || ':' || (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname LIKE 'pr50_finance_dev_%' AND cardinality(roles)=3 AND roles @> ARRAY['bizportal_marketplace_finance_login_dev','bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev']::name[])::text;" | admin)"
test "$verified" = "11:18"
echo PR125_ELEVEN_ROLE_RESTRICTIVE_AND_EIGHTEEN_LEGACY_POLICY_TARGETS_PASS
# Spoof the tenant GUC in each direction; new role identity still isolates.
for pair in "bizportal_finance_cst_login_dev:3" "bizportal_finance_diva_login_dev:1"; do
 role="${pair%%:*}"; spoof="${pair##*:}"
 n="$(printf '%s\n' "BEGIN;SET LOCAL ROLE $role;SET LOCAL app.marketplace_company_id='$spoof';SELECT count(*) FROM public.mkt_purchase_orders;ROLLBACK;" | admin | grep -x '1' | wc -l)"
 test "$n" = 1
done
echo PR125_COMPANY_ROLE_TENANT_GUC_SPOOF_DENIED_PASS
permissions="$(printf '%s\n' "SELECT (has_table_privilege('bizportal_finance_cst_login_dev','public.mkt_purchase_orders','UPDATE') OR has_table_privilege('bizportal_finance_diva_login_dev','public.mkt_purchase_orders','UPDATE'))::text||':'||has_column_privilege('bizportal_finance_cst_login_dev','public.vendor_invoices','invoice_number','INSERT')::text;" | admin)"
test "$permissions" = "false:true" || test "$permissions" = "f:t"
echo PR125_NARROW_GRANTS_PARENT_UPDATE_DENIED_PASS
# Stage-2 private SECURITY DEFINER must retain session_user-based tenant security.
admin <<'SQL' >/dev/null
UPDATE public.mkt_purchase_orders
 SET vendor_token=CASE WHEN id=11 THEN repeat('a',64) ELSE repeat('b',64) END,
 vendor_token_expires_at=(now() AT TIME ZONE 'UTC')+interval '1 day'
 WHERE id IN (11,31);
SQL
admin < "$TMP/20261117_dev_finance_parent_locks_phase2.sql" >/dev/null
verified="$(printf '%s\n' "SELECT (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname IN ('pr108_definer_read','pr108_definer_lock'))::text || ':' || (SELECT count(*) FROM pg_roles WHERE rolname='bizportal_finance_parent_lock_owner_dev' AND NOT rolcanlogin AND NOT rolbypassrls)::text;" | admin)"
test "$verified" = "6:1"
echo PR124_PRIVATE_OWNER_AND_SIX_RLS_POLICIES_PASS
generic="$(printf '%s\n' "SELECT has_function_privilege('bizportal_marketplace_finance_login_dev','finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)','EXECUTE')::text;" | admin)"
test "$generic" = f || test "$generic" = false
echo PR124_GENERIC_FINANCE_NOT_ALLOWED_EXECUTE_PASS
# Synthetic passwords and LOGIN exist ONLY inside this throwaway container.
admin <<'SQL' >/dev/null
ALTER ROLE bizportal_finance_cst_login_dev LOGIN CONNECTION LIMIT 1 PASSWORD 'synthetic-cst-only';
ALTER ROLE bizportal_finance_diva_login_dev LOGIN CONNECTION LIMIT 1 PASSWORD 'synthetic-diva-only';
SQL
# PR125: stage exact currently deployed function, preserving extra post-lock expiry recheck.
admin < "$ROOT/scripts/tests/pr125-current-live-definer-before.sql" >/dev/null
old_md5="$(printf '%s\n' "SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)');" | admin)"
test "$old_md5" = 06d261a1ec4908c31b681d7a0f1f26cd
echo PR125_EXACT_LIVE_DEFENDER_SNAPSHOT_MD5_PASS
admin <<'SQL' >/dev/null
UPDATE public.mkt_purchase_orders SET vendor_token=repeat('a',48) WHERE id=11 AND company_id=1;
SQL
before48="$(docker exec -i "$NAME" psql -X -v ON_ERROR_STOP=1 -U bizportal_finance_cst_login_dev -d postgres -Atq <<'SQL'
BEGIN;
SET LOCAL app.marketplace_company_id='1';
SELECT finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(11,13,10,repeat('a',48))::text;
ROLLBACK;
SQL
)"
test "$before48" = "false" || test "$before48" = "f"
echo PR125_ORIGINAL_LOCK_REJECTS_PORTAL_48_HEX_CONFIRMED
admin < "$TMP/20261117_dev_finance_po_vendor_token_48_64_compat.sql" >/dev/null
new_md5="$(printf '%s\n' "SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)');" | admin)"
test "$new_md5" = f74ae1995c4ec52505b06624c6010950
echo PR125_TOKEN_COMPAT_SQL_MINIMAL_BODY_CHANGE_PASS
for check in "bizportal_finance_cst_login_dev:3:11:13:10:a:31:33:35:b" "bizportal_finance_diva_login_dev:1:31:33:35:b:11:13:10:a"; do
 IFS=: read -r role spoof id gr supplier tok other othergr othersupplier othertok <<< "$check"
 result="$(docker exec -i "$NAME" psql -X -v ON_ERROR_STOP=1 -U "$role" -d postgres -Atq <<SQL
BEGIN;
SET LOCAL app.marketplace_company_id='$spoof';
SELECT finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev($id,$gr,$supplier,repeat('$tok',CASE WHEN $id=11 THEN 48 ELSE 64 END))::text;
SELECT finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev($other,$othergr,$othersupplier,repeat('$othertok',64))::text;
ROLLBACK;
SQL
)"
 test "$result" = "$(printf 'true\nfalse')" || test "$result" = "$(printf 't\nf')"
done
echo PR124_ACTUAL_AUTHENTICATED_COMPANY_LOGINS_BLOCK_TENANT_GUC_SPOOF_PASS
# Explicit malformed lengths remain rejected even after compatibility change.
invalid="$(docker exec -i "$NAME" psql -X -v ON_ERROR_STOP=1 -U bizportal_finance_cst_login_dev -d postgres -Atq <<'SQL'
BEGIN;
SET LOCAL app.marketplace_company_id='1';
SELECT finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(11,13,10,repeat('a',47))::text;
SELECT finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(11,13,10,repeat('a',49))::text;
SELECT finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(11,13,10,repeat('g',48))::text;
ROLLBACK;
SQL
)"
test "$invalid" = "$(printf 'false\nfalse\nfalse')" || test "$invalid" = "$(printf 'f\nf\nf')"
echo PR125_SHORT_INVALID_HEX_LENGTHS_DENIED_PASS
# Restore exact original function before PR124 baseline cleanup.
admin < "$TMP/20261117_dev_finance_po_vendor_token_48_64_compat_rollback.sql" >/dev/null
after_md5="$(printf '%s\n' "SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)');" | admin)"
test "$after_md5" = 06d261a1ec4908c31b681d7a0f1f26cd
echo PR125_TOKEN_COMPAT_ROLLBACK_RESTORES_OLD_HASH_PASS
admin <<'SQL' >/dev/null
ALTER ROLE bizportal_finance_cst_login_dev NOLOGIN CONNECTION LIMIT 0 PASSWORD NULL;
ALTER ROLE bizportal_finance_diva_login_dev NOLOGIN CONNECTION LIMIT 0 PASSWORD NULL;
SQL
admin < "$TMP/20261117_dev_finance_parent_locks_phase2_rollback.sql" >/dev/null
after="$(printf '%s\n' "SELECT (SELECT count(*) FROM pg_roles WHERE rolname='bizportal_finance_parent_lock_owner_dev')::text || ':' || (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname IN ('pr108_definer_read','pr108_definer_lock'))::text || ':' || (SELECT count(*) FROM pg_namespace WHERE nspname='finance_ops_private')::text;" | admin)"
test "$after" = "0:0:0"
echo PR124_PHASE2_ROLLBACK_REMOVES_PRIVATE_FUNCTION_OWNER_AND_POLICIES_PASS
admin < "$TMP/20261117_dev_finance_company_rls_phase1_rollback.sql" >/dev/null
roles="$(printf '%s\n' "SELECT count(*) FROM pg_roles WHERE rolname IN ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev') AND NOT rolcanlogin;" | admin)"
test "$roles" = 2
echo PR125_PHASE1_ROLLBACK_PRESERVES_TWO_DORMANT_ROLES_PASS
admin < "$TMP/20261117_dev_finance_dormant_roles_phase0_rollback.sql" >/dev/null
residue="$(printf '%s\n' "SELECT count(*) FROM pg_roles WHERE rolname IN ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev');" | admin)"
test "$residue" = 0
echo PR125_ORIGINAL_ROLE_POLICY_BASELINE_RESTORED_PASS
echo PR125_DISPOSABLE_ROLE_AND_RLS_CYCLE_PASS
