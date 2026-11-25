#!/usr/bin/env bash
# PO14 test-only: canonical Invoice/AP/approval/bank/GL functions, ephemeral PG.
# NEVER connects to CST-DEV or PROD Supabase. Do not run in business DB hosts.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
ONE="cst-po14-local-invoice-pg-$$"
TWO="cst-po14-local-bank-pg-$$"
cleanup() {
  docker stop "$ONE" "$TWO" >/dev/null 2>&1 || true
}
trap cleanup EXIT
for port in 55493 55497; do
  if command -v ss >/dev/null 2>&1 && ss -H -ltn "( sport = :$port )" | grep -q .; then
    echo "Refusing: localhost test port $port is in use" >&2
    exit 9
  fi
done
docker run -d --rm --name "$ONE" --memory=400m --cpus=1 --pids-limit=130 \
  -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55497:5432 \
  postgres:16-alpine >/dev/null
docker run -d --rm --name "$TWO" --memory=256m --cpus=1 --pids-limit=90 \
  -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55493:5432 \
  postgres:16-alpine >/dev/null
for name in "$ONE" "$TWO"; do
  ready=0
  for i in $(seq 1 35); do
    if docker exec "$name" pg_isready -U postgres >/dev/null 2>&1; then
      ready=1;break
    fi
    sleep 1
  done
  test "$ready" = "1" || { echo "DB $name failed preflight" >&2;exit 10; }
done
docker exec -i "$ONE" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < scripts/sql/20261125_po14_isolated_marketplace_schema_ONLY.sql >/dev/null
pnpm --filter @workspace/api-server exec vitest run \
  src/lib/finance/marketplaceInvoiceApRealPg.test.ts \
  src/lib/finance/marketplacePaymentFinalization.test.ts \
  src/lib/finance/marketplacePaymentReleaseGate.test.ts \
  src/lib/services/mktAccountingHandoff.test.ts \
  src/lib/services/mktVendorInvoiceParentLock.dev.test.ts \
  src/routes/dev-marketplace-finance-writer.test.ts \
  src/__tests__/bank-reconciliation-canonical-posting.test.ts \
  --reporter=dot
echo "PO14 isolated service test complete; no CST business DB connection used"
