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
docker run --rm -d --name "$NAME" -p "127.0.0.1:${PORT}:5432" \
  -e POSTGRES_PASSWORD="payroll_container_fixture_only_2026" postgres:16-alpine >/dev/null
for n in $(seq 1 45); do
  if docker exec "$NAME" pg_isready -U postgres -d postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$NAME" pg_isready -U postgres -d postgres
cd "$ROOT"
export PAYROLL_CALC_PG_ADMIN_URL="postgresql://postgres:payroll_container_fixture_only_2026@127.0.0.1:${PORT}/postgres"
export PAYROLL_CALC_PG_RESTRICTED_URL="postgresql://bizportal_payroll_dev:payroll_fixture_only_2026@127.0.0.1:${PORT}/postgres"
pnpm --filter @workspace/api-server exec vitest run src/routes/payroll-calculate-real-postgres.test.ts
echo "REAL_POSTGRES_DISPOSABLE_PASS"
