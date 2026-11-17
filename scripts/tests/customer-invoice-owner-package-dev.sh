#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$(mktemp "${TMPDIR:-/tmp}/cst-canonical-owner-package.XXXXXXXX.mjs")"
trap 'rm -f "$OUT"' EXIT
cd "$ROOT"

# No second writer or live database. Bundle the original owner with the
# node-postgres CommonJS shim required by the ESM runtime.
pnpm --dir artifacts/api-server exec esbuild \
  src/lib/posting-engine/portalInvoiceAdapter.ts \
  --bundle --platform=node --format=esm --target=node22 \
  --outfile="$OUT" \
  --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
  --log-level=warning

# Production Node.js module mode on a DEV-only application; both flags OFF.
NODE_ENV=production APP_ENV=development \
CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV=false \
CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV=false \
node --input-type=module - "$OUT" <<'NODE'
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const owner = await import(pathToFileURL(process.argv[2]).href);
assert.equal(typeof owner.postCustomerInvoiceWithOriginalOwner, "function");
await assert.rejects(
  owner.postCustomerInvoiceWithOriginalOwner({}),
  /CUSTOMER_INVOICE_POSTING_DEV_FLAGS_OFF/,
);
console.log("CUSTOMER_INVOICE_EXISTING_OWNER_ESM_IMPORT_PASS");
console.log("CUSTOMER_INVOICE_NO_DATABASE_OR_POSTING_WHEN_FLAGS_OFF_PASS");
NODE

# No compiled artifact copied into the active app and no tracked changes.
git diff --exit-code -- artifacts/api-server/src lib/db/src scripts/tests pnpm-lock.yaml
