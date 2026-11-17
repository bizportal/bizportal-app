#!/usr/bin/env bash
set -euo pipefail
# Disposable localhost-only PostgreSQL. Never receives Supabase/GCP credentials.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NAME="payroll-calculate-fixture-$$"
PORT=65436
if ss -ltn "( sport = :${PORT} )" | grep -q "127.0.0.1:${PORT}"; then
  echo "Refusing occupied local test port"; exit 2
fi
cleanup(){ docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run --pull=never --rm -d --name "$NAME" --memory=256m \
  --tmpfs /var/lib/postgresql/data:rw -p "127.0.0.1:${PORT}:5432" \
  -e POSTGRES_PASSWORD="payroll_container_fixture_only_2026" postgres:16-alpine >/dev/null
# A single pg_isready observation can race container startup/shutdown on CI.
# Require two successful real SQL probes across separate checks, with bounded
# retries. On failure, preserve diagnostics only; no sensitive credentials.
ready=false
for n in $(seq 1 45); do
  if docker exec "$NAME" pg_isready -U postgres -d postgres >/dev/null 2>&1 &&
     docker exec "$NAME" psql -U postgres -d postgres -Atqc 'SELECT 1' 2>/dev/null | grep -qx 1; then
    sleep 1
    if docker exec "$NAME" pg_isready -U postgres -d postgres >/dev/null 2>&1 &&
       docker exec "$NAME" psql -U postgres -d postgres -Atqc 'SELECT 1' 2>/dev/null | grep -qx 1; then
      ready=true
      break
    fi
  fi
  sleep 1
done
if [ "$ready" != true ]; then
  echo 'DISPOSABLE_POSTGRES_STABLE_SQL_READINESS_FAILED' >&2
  docker logs --tail 45 "$NAME" >&2 || true
  exit 3
fi
cd "$ROOT"
export PAYROLL_CALC_PG_ADMIN_URL="postgresql://postgres:payroll_container_fixture_only_2026@127.0.0.1:${PORT}/postgres"
export PAYROLL_CALC_PG_RESTRICTED_URL="postgresql://bizportal_payroll_dev:payroll_fixture_only_2026@127.0.0.1:${PORT}/postgres"
case "${1:-calculate}" in
  calculate)
    pnpm --filter @workspace/api-server exec vitest run src/routes/payroll-calculate-real-postgres.test.ts
    echo "REAL_POSTGRES_DISPOSABLE_PASS"
    ;;
  signed)
    export PAYROLL_CALC_PG_APPROVER_URL="postgresql://bizportal_payroll_approver_dev:payroll_approver_fixture_only_2026@127.0.0.1:${PORT}/postgres"
    pnpm --filter @workspace/api-server exec vitest run src/routes/payroll-calculate-signed-approval-postgres.test.ts --maxWorkers=1 --no-file-parallelism
    echo "SIGNED_APPROVAL_POSTGRES_DISPOSABLE_PASS"
    ;;
  *)
    echo "Expected fixture mode: calculate or signed"; exit 2
    ;;
esac
