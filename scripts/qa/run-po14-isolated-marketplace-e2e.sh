#!/usr/bin/env bash
# PO14 test-only: canonical Invoice/AP/approval/bank/GL functions, ephemeral PG.
# NEVER connects to CST-DEV or PROD Supabase. Only these temporary localhost
# containers are used; no inherited application DSNs or provider credentials.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
ONE="cst-po14-local-invoice-pg-$$"
TWO="cst-po14-local-bank-pg-$$"
THREE="cst-po14-local-adapter-pg-$$"
FOUR="cst-po14-local-approval-pg-$$"
cleanup() {
  docker stop "$ONE" "$TWO" "$THREE" "$FOUR" >/dev/null 2>&1 || true
}
trap cleanup EXIT
for port in 55493 55494 55495 55497; do
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
docker run -d --rm --name "$THREE" --memory=256m --cpus=1 --pids-limit=90 \
  -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55494:5432 \
  postgres:16-alpine >/dev/null
docker run -d --rm --name "$FOUR" --memory=256m --cpus=1 --pids-limit=90 \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=finance_approval_qa \
  -p 127.0.0.1:55495:5432 postgres:16-alpine >/dev/null
for name in "$ONE" "$TWO" "$THREE" "$FOUR"; do
  ready=0
  for i in $(seq 1 35); do
    if docker exec "$name" pg_isready -U postgres >/dev/null 2>&1; then
      ready=1;break
    fi
    sleep 1
  done
  test "$ready" = "1" || { echo "DB $name failed preflight" >&2;exit 10; }
done
# The QA fixture database must exist before its schema can be loaded.
qa_db_ready=0
for i in $(seq 1 30); do
  if docker exec "$FOUR" psql -X -U postgres -d finance_approval_qa -Atc "select 1" >/dev/null 2>&1; then qa_db_ready=1; break; fi
  sleep 1
done
test "$qa_db_ready" = 1 || { echo "QA approval fixture unavailable" >&2; exit 10; }
docker exec -i "$ONE" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < scripts/sql/20261125_po14_isolated_marketplace_schema_ONLY.sql >/dev/null
docker exec -i "$FOUR" psql -v ON_ERROR_STOP=1 -U postgres -d finance_approval_qa \
  < scripts/sql/20261127_finance_approval_qa_localhost_ONLY.sql >/dev/null
env -i PATH="$PATH" HOME="$HOME" CI=true \
pnpm --filter @workspace/api-server exec vitest run \
  src/lib/finance/marketplaceInvoiceApRealPg.test.ts \
  src/lib/finance/marketplaceBankIngestionRealPg.test.ts \
  src/lib/finance/marketplaceInvoiceBankStatusAdapter.test.ts \
  src/lib/finance/marketplacePaymentFinalization.test.ts \
  src/lib/finance/marketplacePaymentReleaseGate.test.ts \
  src/lib/services/mktAccountingHandoff.test.ts \
  src/lib/services/mktVendorInvoiceParentLock.dev.test.ts \
  src/routes/dev-marketplace-finance-writer.test.ts \
  src/routes/dev-finance-po14-e2e-qa.test.ts \
  src/routes/dev-finance-approval-qa.test.ts \
  src/__tests__/bank-reconciliation-canonical-posting.test.ts \
  --maxWorkers=1 --reporter=dot
echo "PO14 isolated service test complete; no CST business DB connection used"
