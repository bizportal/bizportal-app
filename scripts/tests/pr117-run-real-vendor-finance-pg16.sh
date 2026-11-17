#!/usr/bin/env bash
# PR117: canonical service + PR107/108 original review SQL, synthetic-only PG16.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NETWORK="cst-pr117-canonical-finance-internal"
PG="cst-pr117-finance-pg16"
NODE="cst-pr117-finance-node"
BUNDLE="$ROOT/artifacts/api-server/.pr117-real-vendor-finance-service.mjs"
PG_IMAGE="${PR117_DISPOSABLE_PG_IMAGE:-postgres:16-alpine}"
case "$PG_IMAGE" in postgres:16-alpine|postgres:17-alpine) ;; *)
  echo "PR117_REFUSE_UNAPPROVED_POSTGRES_IMAGE"; exit 4 ;;
esac
for image in "$PG_IMAGE" node:22-alpine; do
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    docker pull "$image" >/dev/null
  fi
done
for name in "$PG" "$NODE"; do
  if docker ps -aq --filter "name=^/${name}$" | grep -q .; then
    echo "PR117_REFUSE_REUSE_EXISTING_CONTAINER"; exit 4
  fi
done
if docker network ls --format '{{.Name}}' | grep -qx "$NETWORK"; then
  echo "PR117_REFUSE_REUSE_EXISTING_NETWORK"; exit 4
fi
test -s "$BUNDLE"
cleanup() {
  docker rm -f "$NODE" "$PG" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -f "$BUNDLE"
}
trap cleanup EXIT
docker network create --internal "$NETWORK" >/dev/null
docker run -d --rm --pull never --network "$NETWORK" --name "$PG" \
  --network-alias pr117pg --memory 350m --cpus 1 \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,size=192m \
  -e POSTGRES_DB=cst_pr107_ci \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=synthetic-admin-only \
  -e POSTGRES_HOST_AUTH_METHOD=scram-sha-256 \
  "$PG_IMAGE" >/dev/null
ready=0
for _ in $(seq 1 90); do
  if docker exec "$PG" pg_isready -q -h 127.0.0.1 -U postgres -d cst_pr107_ci >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 0.25
done
if [ "$ready" != 1 ]; then
  echo PR117_PG16_START_FAILED; exit 5
fi
echo PR117_INTERNAL_DISPOSABLE_PG16_READY
docker run --rm --pull never --network "$NETWORK" --name "$NODE" \
  --memory 800m --cpus 2 --read-only --tmpfs /tmp:rw,nosuid,size=48m \
  --security-opt no-new-privileges --cap-drop ALL --user 1000:1000 \
  --mount "type=bind,source=$ROOT,target=/src,readonly" \
  --mount "type=bind,source=/opt/bizportal-pr108-finance-definer-session-review-20261117/node_modules,target=/src/node_modules,readonly" \
  --mount "type=bind,source=/opt/bizportal-pr108-finance-definer-session-review-20261117/artifacts/api-server/node_modules,target=/src/artifacts/api-server/node_modules,readonly" \
  -w /src \
  -e PR117_DISPOSABLE_INTEGRATION=true \
  -e APP_ENV=development \
  -e NODE_ENV=test \
  -e BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV=true \
  -e BIZPORTAL_MARKETPLACE_VENDOR_PARENT_LOCK_ENABLED_DEV=true \
  -e PR117_DISPOSABLE_PG_URL=postgresql://bizportal_finance_cst_login_dev:synthetic-cst-only@pr117pg:5432/cst_pr107_ci \
  -e PR117_DISPOSABLE_ADMIN_URL=postgresql://postgres:synthetic-admin-only@pr117pg:5432/cst_pr107_ci \
  node:22-alpine node artifacts/api-server/.pr117-real-vendor-finance-service.mjs
echo PR117_INTERNAL_ONLY_DOCKER_INTEGRATION_PASS
