#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NETWORK="cst-customer-ar-source-ci-internal"
PG="cst-customer-ar-source-ci-pg17"
NODE="cst-customer-ar-source-ci-node"
BUNDLE="$ROOT/artifacts/api-server/.customer-ar-source-e2e.mjs"
PG_IMAGE="${CUSTOMER_AR_DISPOSABLE_PG_IMAGE:-postgres:17-alpine}"
case "$PG_IMAGE" in
 postgres:16-alpine) PG_MAJOR=16 ;;
 postgres:17-alpine) PG_MAJOR=17 ;;
 *) echo CUSTOMER_AR_UNAPPROVED_POSTGRES_IMAGE; exit 4 ;;
esac
for image in "$PG_IMAGE" node:22-alpine; do
  if ! docker image inspect "$image" >/dev/null 2>&1; then docker pull "$image" >/dev/null; fi
done
for name in "$PG" "$NODE"; do
  if test -n "$(docker ps -aq --filter "name=^/${name}$")"; then
    echo CUSTOMER_AR_REFUSE_REUSE_CONTAINER; exit 4
  fi
done
if docker network ls --format '{{.Name}}' | grep -qx "$NETWORK"; then
  echo CUSTOMER_AR_REFUSE_REUSE_NETWORK; exit 4
fi
cleanup() {
  docker rm -f "$NODE" "$PG" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -f "$BUNDLE"
}
trap cleanup EXIT
cd "$ROOT"
pnpm --filter @workspace/api-server exec esbuild ../../scripts/tests/customer-ar-source-e2e.ts \
  --bundle --platform=node --format=esm --external:pg --outfile=.customer-ar-source-e2e.mjs
docker network create --internal "$NETWORK" >/dev/null
docker run -d --rm --pull never --network "$NETWORK" --name "$PG" \
  --network-alias customerarpg --memory 350m --cpus 1 \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,size=192m \
  -e POSTGRES_DB=cst_customer_ar_ci -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=synthetic-admin-only -e POSTGRES_HOST_AUTH_METHOD=scram-sha-256 \
  "$PG_IMAGE" >/dev/null
ready=0
for _ in $(seq 1 80); do
  if docker exec "$PG" pg_isready -q -h 127.0.0.1 -U postgres -d cst_customer_ar_ci; then
    ready=1; break
  fi
  sleep 0.25
done
test "$ready" = 1 || { echo CUSTOMER_AR_PG_START_FAILED; exit 5; }
docker run --rm --pull never --network "$NETWORK" --name "$NODE" \
  --memory 600m --cpus 2 --read-only --tmpfs /tmp:rw,nosuid,size=32m \
  --security-opt no-new-privileges --cap-drop ALL --user 1000:1000 \
  --mount "type=bind,source=$ROOT,target=/src,readonly" -w /src \
  -e CUSTOMER_AR_DISPOSABLE_INTEGRATION=true \
  -e CUSTOMER_AR_EXPECTED_PG_MAJOR="$PG_MAJOR" \
  -e CUSTOMER_AR_DISPOSABLE_ADMIN_URL=postgresql://postgres:synthetic-admin-only@customerarpg:5432/cst_customer_ar_ci \
  node:22-alpine node artifacts/api-server/.customer-ar-source-e2e.mjs
echo CUSTOMER_AR_INTERNAL_ONLY_PG${PG_MAJOR}_PASS
