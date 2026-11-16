#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NAME="cst-pr106-company-policy-disposable"
IMAGE="${PR106_DISPOSABLE_PG_IMAGE:-postgres:16-alpine}"
case "$IMAGE" in
  postgres:16-alpine|postgres:17-alpine) ;;
  *) echo REFUSE_UNTRUSTED_POSTGRES_IMAGE; exit 7 ;;
esac
test -s "$ROOT/scripts/tests/pr106-company-policy-preflight.sql"
test -z "$(docker ps -a --filter "name=^$NAME$" --format '{{.Names}}')"
cleanup(){ docker rm -f "$NAME" >/dev/null 2>&1 || :; }
trap cleanup EXIT
docker run -d --rm --network none --name "$NAME" --memory 256m --cpus 1 \
 --tmpfs /var/lib/postgresql/data:rw,nosuid,size=192m \
 -e POSTGRES_DB=cst_pr106_disposable \
 -e POSTGRES_USER=postgres \
 -e POSTGRES_HOST_AUTH_METHOD=trust "$IMAGE" >/dev/null
ready=false
for _ in $(seq 1 70);do
 if docker exec "$NAME" pg_isready -q -U postgres -d cst_pr106_disposable >/dev/null 2>&1;then
   sleep 0.4
   if docker exec "$NAME" pg_isready -q -U postgres -d cst_pr106_disposable >/dev/null 2>&1;then
     ready=true;break
   fi
 fi
 sleep 0.25
done
test "$ready" = true || { echo DISPOSABLE_DATABASE_STARTUP_FAILED; exit 8; }
docker exec "$NAME" pg_isready -q -U postgres -d cst_pr106_disposable
RESULT="$(docker exec -i "$NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d cst_pr106_disposable -Atq \
 < "$ROOT/scripts/tests/pr106-company-policy-preflight.sql")"
for marker in \
  PR106_ELEVEN_RESTRICTIVE_RLS_GUARDS_PASS \
  PR106_MISSING_RESTRICTIVE_POLICY_DETECTED_PASS \
  PR106_UNEXPECTED_ROLE_MEMBERSHIP_DETECTED_PASS \
  PR106_CATALOG_RLS_NO_RESIDUE_ROLLBACK_PASS; do
  grep -q "$marker" <<< "$RESULT"
  echo "$marker"
done
echo PR106_COMPANY_CATALOG_PREFLIGHT_DISPOSABLE_PASS
