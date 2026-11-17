#!/usr/bin/env bash
# PR124: independently prove PostgreSQL non-superuser CREATEROLE can transfer
# function ownership with temporary SET option and revoke ONLY self-grant.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${PR124_POSTGRES_IMAGE:-postgres:16-alpine}"
case "$IMAGE" in postgres:16-alpine|postgres:17-alpine) ;; *) echo PR124_UNAPPROVED_PG_IMAGE;exit 8;; esac
NAME=cst-pr124-nonsuper-owner-ci
test -z "$(docker ps -a --filter "name=^$NAME$" --format '{{.Names}}')"
TMP="$(mktemp -d -t pr124-owner-XXXXXX)"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || :; rm -rf "$TMP"; }
trap cleanup EXIT
docker run -d --rm --pull never --network none --name "$NAME" --memory 256m --cpus 1 \
 --tmpfs /var/lib/postgresql/data:rw,nosuid,size=192m \
 -e POSTGRES_USER=postgres -e POSTGRES_DB=postgres -e POSTGRES_HOST_AUTH_METHOD=trust \
 "$IMAGE" >/dev/null
ready=false
for _ in $(seq 1 80);do
 if docker exec "$NAME" pg_isready -q -h127.0.0.1 -U postgres -d postgres >/dev/null 2>&1;then ready=true;break;fi
 sleep .2
done
test "$ready" = true
as_admin() { docker exec -i "$NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -Atq; }
as_nonsuper() { docker exec -i "$NAME" psql -X -v ON_ERROR_STOP=1 -U pr124_ci_admin -d postgres -Atq; }
as_admin <<'SQL' >/dev/null
CREATE ROLE pr124_ci_admin LOGIN NOINHERIT CREATEROLE NOBYPASSRLS;
CREATE SCHEMA pr124_scratch AUTHORIZATION pr124_ci_admin;
SQL
as_nonsuper <<'SQL' >/dev/null
CREATE ROLE pr124_ci_owner NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT USAGE,CREATE ON SCHEMA pr124_scratch TO pr124_ci_owner;
CREATE FUNCTION pr124_scratch.check_owner() RETURNS boolean LANGUAGE sql SECURITY DEFINER AS 'SELECT true';
SQL
before="$(printf '%s\n' "SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE r.rolname='pr124_ci_owner' AND u.rolname='pr124_ci_admin' AND m.admin_option AND NOT m.set_option;" | as_admin)"
test "$before" = 1
if as_nonsuper <<'SQL' >/dev/null 2>&1
ALTER FUNCTION pr124_scratch.check_owner() OWNER TO pr124_ci_owner;
SQL
then echo PR124_EXPECTED_NON_SUPERUSER_DENIAL_MISSING;exit 9;fi
echo PR124_NON_SUPERUSER_OWNER_TRANSFER_REQUIRES_SET_PASS

# Rehearse the *three exact statements* in the checked-in Finance phase2 SQL.
# Only map fixed synthetic identifiers/qualified function to this scratch DB.
python3 - "$ROOT/scripts/sql/20261117_dev_finance_parent_locks_phase2.sql" "$TMP/scratch-grant.sql" <<'PY'
from pathlib import Path
import sys,re
s=Path(sys.argv[1]).read_text()
lines=s.splitlines()
keys=[
 "GRANT bizportal_finance_parent_lock_owner_dev TO postgres WITH SET TRUE;",
 "ALTER FUNCTION finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text) OWNER TO bizportal_finance_parent_lock_owner_dev;",
 "REVOKE bizportal_finance_parent_lock_owner_dev FROM postgres GRANTED BY postgres;",
]
assert [line for line in lines if line in keys]==keys, "owner transfer not bracketed by exact temporary grant/revoke"
out=(
 keys[0].replace("bizportal_finance_parent_lock_owner_dev","pr124_ci_owner").replace("postgres","pr124_ci_admin")+"\n"
 +"ALTER FUNCTION pr124_scratch.check_owner() OWNER TO pr124_ci_owner;\n"
 +keys[2].replace("bizportal_finance_parent_lock_owner_dev","pr124_ci_owner").replace("postgres","pr124_ci_admin")+"\n"
)
Path(sys.argv[2]).write_text(out)
PY
as_nonsuper < "$TMP/scratch-grant.sql" >/dev/null
after="$(printf '%s\n' "SELECT count(*)::text||':'||max(m.admin_option::integer)::text||':'||max(m.set_option::integer)::text FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE r.rolname='pr124_ci_owner' AND u.rolname='pr124_ci_admin';" | as_admin)"
test "$after" = "1:1:0"
owner="$(printf '%s\n' "SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE proname='check_owner';" | as_admin)"
test "$owner" = pr124_ci_owner
echo PR124_NON_SUPERUSER_TEMPORARY_SET_REVOKED_WITH_ORIGINAL_ADMIN_PRESERVED_PASS
as_nonsuper <<'SQL' >/dev/null
DROP FUNCTION pr124_scratch.check_owner();
REVOKE USAGE,CREATE ON SCHEMA pr124_scratch FROM pr124_ci_owner;
DROP ROLE pr124_ci_owner;
SQL
left="$(printf '%s\n' "SELECT count(*) FROM pg_roles WHERE rolname='pr124_ci_owner';" | as_admin)"
test "$left" = 0
echo PR124_NON_SUPERUSER_ROLE_OWNER_ROLLBACK_PASS
