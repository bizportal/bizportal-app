#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
NET=cst-pr102-vendor-concurrency-e2e
PG=cst-pr102-vendor-concurrency-postgres
NODE=cst-pr102-vendor-concurrency-node
test -s "$ROOT/artifacts/api-server/.pr102-vendor-concurrency-proof.mjs"
for name in "$PG" "$NODE";do
 test -z "$(docker ps -a --filter "name=^$name$" --format '{{.Names}}')" || { echo DUPLICATE_CONTAINER_ABORT;exit 7; }
done
test -z "$(docker network ls --filter "name=^$NET$" --format '{{.Name}}')" || { echo DUPLICATE_NETWORK_ABORT;exit 7; }
LOG=$(mktemp -t pr102-vendor-concurrency-run.XXXXXX)
cleanup(){
 docker rm -f "$NODE" "$PG" >/dev/null 2>&1 || :
 docker network rm "$NET" >/dev/null 2>&1 || :
 rm -f "$LOG"
}
trap cleanup EXIT
docker network create --internal "$NET" >/dev/null
docker run -d --rm --name "$PG" --network "$NET" --network-alias pr81pg \
  --memory 256m --cpus 1 --tmpfs /var/lib/postgresql/data:rw,nosuid,size=192m \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_DB=cst_pr81_writer_ci \
  -e POSTGRES_USER=postgres postgres:16-alpine >/dev/null
ready=false
for _ in $(seq 1 70);do
 if docker exec "$PG" pg_isready -q -h127.0.0.1 -U postgres -d cst_pr81_writer_ci >/dev/null 2>&1;then
  ready=true
  break
 fi
 sleep 0.25
done
test "$ready" = true || { echo PG_START_FAIL;exit 8; }
echo INTERNAL_DISPOSABLE_POSTGRES_READY
if ! docker run --rm --name "$NODE" --network "$NET" --memory 512m --cpus 2 \
  --read-only --tmpfs /tmp:rw,nosuid,size=32m \
  --security-opt no-new-privileges --cap-drop ALL --user 1000:1000 \
  --mount "type=bind,source=$ROOT,target=/src,readonly" \
  -w /src/artifacts/api-server \
  -e PR81_DISPOSABLE_SERVICE_E2E=true \
  -e PR81_DISPOSABLE_PG_URL=postgresql://postgres:synthetic-only@pr81pg:5432/cst_pr81_writer_ci \
  node:22-alpine node .pr102-vendor-concurrency-proof.mjs >"$LOG" 2>&1;then
 echo ACTUAL_SERVICE_INTEGRATION_FAILED
 tail -50 "$LOG"
 exit 9
fi
grep -E 'PASS|FAILED|ERROR' "$LOG" | tail -20
grep -q 'PR102_VENDOR_PARENT_LOCK_CONCURRENT_WRITERS_PASS' "$LOG"
docker rm -f "$PG" >/dev/null
docker network rm "$NET" >/dev/null
echo CONTAINERS_AND_NETWORK_CLEAN=true
