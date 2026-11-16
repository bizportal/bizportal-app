#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NAME="cst-pr104-tenant-rls-disposable"
IMAGE="${PR104_DISPOSABLE_PG_IMAGE:-postgres:16-alpine}"
case "$IMAGE" in
  postgres:16-alpine|postgres:17-alpine) ;;
  *) echo REFUSE_UNTRUSTED_POSTGRES_IMAGE; exit 7 ;;
esac
test -s "$ROOT/scripts/tests/pr104-tenant-boundary.sql"
test -z "$(docker ps -a --filter "name=^$NAME$" --format '{{.Names}}')"
cleanup(){ docker rm -f "$NAME" >/dev/null 2>&1 || :; }
trap cleanup EXIT
docker run -d --rm --network none --name "$NAME" --memory 256m --cpus 1 \
 --tmpfs /var/lib/postgresql/data:rw,nosuid,size=192m \
 -e POSTGRES_DB=cst_pr104_disposable \
 -e POSTGRES_USER=postgres \
 -e POSTGRES_HOST_AUTH_METHOD=trust "$IMAGE" >/dev/null
for _ in $(seq 1 70);do
 if docker exec "$NAME" pg_isready -q -U postgres -d cst_pr104_disposable >/dev/null 2>&1;then break;fi
 sleep 0.25
done
docker exec "$NAME" pg_isready -q -U postgres -d cst_pr104_disposable
RESULT="$(docker exec -i "$NAME" psql -X -v ON_ERROR_STOP=1 -U postgres -d cst_pr104_disposable -Atq \
 < "$ROOT/scripts/tests/pr104-tenant-boundary.sql")"
echo "$RESULT" | tail -n 4
grep -q PR104_CALLER_SETTABLE_TENANT_SCOPE_REPRODUCED_AND_CLEANED_PASS <<< "$RESULT"
echo TENANT_BOUNDARY_DISPOSABLE_NO_REAL_DATABASE_CONTACT_PASS
