#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${PR105_DISPOSABLE_PG_IMAGE:-postgres:16-alpine}"
case "$IMAGE" in
  postgres:16-alpine|postgres:17-alpine) ;;
  *) echo REFUSE_NON_DISPOSABLE_POSTGRES_IMAGE; exit 7 ;;
esac
NAME=cst-pr105-real-login-isolation-ci
DB=cst_pr105_login_ci
test -s "$ROOT/scripts/tests/pr105-real-login-definer.sql"
test -z "$(docker ps -a --filter "name=^$NAME$" --format '{{.Names}}')"
cleanup(){ docker rm -f "$NAME" >/dev/null 2>&1 || :; }
trap cleanup EXIT
docker run -d --rm --network none --name "$NAME" \
 --memory 256m --cpus 1 --tmpfs /var/lib/postgresql/data:rw,nosuid,size=192m \
 -e POSTGRES_DB="$DB" -e POSTGRES_USER=postgres \
 -e POSTGRES_PASSWORD='synthetic-root-only' -e POSTGRES_HOST_AUTH_METHOD=scram-sha-256 \
 "$IMAGE" >/dev/null
ready=false
for _ in $(seq 1 80);do
 if docker exec "$NAME" pg_isready -q -h127.0.0.1 -U postgres -d "$DB" >/dev/null 2>&1;then
   sleep 0.4
   if docker exec "$NAME" pg_isready -q -h127.0.0.1 -U postgres -d "$DB" >/dev/null 2>&1;then ready=true;break;fi
 fi
 sleep 0.25
done
test "$ready" = true || { echo PG_START_FAIL; exit 8; }
pg_admin(){ docker exec -i -e PGPASSWORD='synthetic-root-only' "$NAME" \
  psql -X -v ON_ERROR_STOP=1 -h127.0.0.1 -U postgres -d "$DB" -Atq; }
pg_company(){
 local role="$1" pass="$2"
 docker exec -i -e "PGPASSWORD=$pass" "$NAME" \
  psql -X -v ON_ERROR_STOP=1 -h127.0.0.1 -U "$role" -d "$DB" -Atq
}
pg_admin < "$ROOT/scripts/tests/pr105-real-login-definer.sql" >/dev/null
# Each actual login has a separate synthetic password; RLS inside the
# SECURITY DEFINER is bound by session_user and cannot follow forged GUC.
CST="$(pg_company ci_pr105_cst_login synthetic-cst-only <<'SQL'
BEGIN;
SELECT set_config('app.marketplace_company_id','3',true);
DO $verify$ BEGIN
 IF session_user <> 'ci_pr105_cst_login' OR current_user <> 'ci_pr105_cst_login'
   OR (SELECT count(*) FROM public.ci_pr105_login_po)<>1
   OR NOT EXISTS(SELECT 1 FROM public.ci_pr105_login_po WHERE id=11)
   OR EXISTS(SELECT 1 FROM public.ci_pr105_login_po WHERE id=31)
   OR NOT ci_pr105_private.lock_vendor_parent(11,'synthetic-cst-token')
   OR ci_pr105_private.lock_vendor_parent(31,'synthetic-diva-token')
 THEN RAISE EXCEPTION 'REAL_CST_LOGIN_SCOPE_BROKEN'; END IF;
END $verify$;
ROLLBACK;
SELECT 'PR105_REAL_CST_LOGIN_DEFINER_COMPANY_BOUND_PASS';
SQL
)"
grep -q PR105_REAL_CST_LOGIN_DEFINER_COMPANY_BOUND_PASS <<< "$CST"
echo PR105_REAL_CST_LOGIN_DEFINER_COMPANY_BOUND_PASS
DIVA="$(pg_company ci_pr105_diva_login synthetic-diva-only <<'SQL'
BEGIN;
SELECT set_config('app.marketplace_company_id','1',true);
DO $verify$ BEGIN
 IF session_user <> 'ci_pr105_diva_login' OR current_user <> 'ci_pr105_diva_login'
   OR (SELECT count(*) FROM public.ci_pr105_login_po)<>1
   OR NOT EXISTS(SELECT 1 FROM public.ci_pr105_login_po WHERE id=31)
   OR EXISTS(SELECT 1 FROM public.ci_pr105_login_po WHERE id=11)
   OR NOT ci_pr105_private.lock_vendor_parent(31,'synthetic-diva-token')
   OR ci_pr105_private.lock_vendor_parent(11,'synthetic-cst-token')
 THEN RAISE EXCEPTION 'REAL_DIVA_LOGIN_SCOPE_BROKEN'; END IF;
END $verify$;
ROLLBACK;
SELECT 'PR105_REAL_DIVA_LOGIN_DEFINER_COMPANY_BOUND_PASS';
SQL
)"
grep -q PR105_REAL_DIVA_LOGIN_DEFINER_COMPANY_BOUND_PASS <<< "$DIVA"
echo PR105_REAL_DIVA_LOGIN_DEFINER_COMPANY_BOUND_PASS
# Role elevation is denied for an ordinary company LOGIN.
if pg_company ci_pr105_cst_login synthetic-cst-only <<'SQL' >/dev/null 2>&1
SET ROLE ci_pr105_diva_login;
SQL
then echo PR105_CROSS_COMPANY_SET_ROLE_UNEXPECTED_SUCCESS;exit 9;fi
echo PR105_CROSS_COMPANY_SET_ROLE_DENIED_PASS
if pg_company ci_pr105_cst_login synthetic-cst-only <<'SQL' >/dev/null 2>&1
SET SESSION AUTHORIZATION ci_pr105_diva_login;
SQL
then echo PR105_CROSS_COMPANY_SESSION_AUTH_UNEXPECTED_SUCCESS;exit 10;fi
echo PR105_CROSS_COMPANY_SESSION_AUTH_DENIED_PASS
# Never leave synthetic roles, function, tables or grants behind.
CLEANED="$(pg_admin <<'SQL'
DROP SCHEMA ci_pr105_private CASCADE;
DROP TABLE public.ci_pr105_login_po;
REVOKE USAGE ON SCHEMA public FROM ci_pr105_cst_login,ci_pr105_diva_login,ci_pr105_lock_owner;
DROP ROLE ci_pr105_cst_login,ci_pr105_diva_login,ci_pr105_lock_owner;
SELECT CASE WHEN to_regclass('public.ci_pr105_login_po') IS NULL
 AND to_regnamespace('ci_pr105_private') IS NULL
 AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN(
  'ci_pr105_cst_login','ci_pr105_diva_login','ci_pr105_lock_owner'))
 THEN 'PR105_REAL_LOGIN_DEFINER_CLEANUP_PASS'
 ELSE 'PR105_REAL_LOGIN_CLEANUP_FAILED' END;
SQL
)"
grep -q PR105_REAL_LOGIN_DEFINER_CLEANUP_PASS <<< "$CLEANED"
echo PR105_REAL_LOGIN_DEFINER_CLEANUP_PASS
