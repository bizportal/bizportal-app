#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="$(mktemp -d /tmp/cst-canonical-owner-package.XXXXXXXX)"
trap 'rm -rf -- "$OUT_DIR"' EXIT
cd "$ROOT/artifacts/api-server"

# Original project's esbuild-plugin-pino is required to include logger workers.
# No new Accounting implementation, DB access or service activation.
OWNER_PKG_OUT="$OUT_DIR" node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import pinoPlugin from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);
const outdir = process.env.OWNER_PKG_OUT;
assert(outdir && outdir.startsWith("/tmp/cst-canonical-owner-package."));
await build({
  entryPoints: ["src/lib/posting-engine/portalInvoiceAdapter.ts"],
  outdir,
  outExtension: { ".js": ".mjs" },
  platform: "node",
  format: "esm",
  bundle: true,
  plugins: [pinoPlugin({ transports: ["pino-pretty"] })],
  banner: {
    js: 'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);',
  },
  logLevel: "warning",
});
const hashes = {
  "portalInvoiceAdapter.mjs": "44a1e2b840b41dd1c1f7b0c36e0554a70b4c47ee4e9cc90b95c7117362c78b95",
  "pino-file.mjs": "bbc4281497fe72cf43c497927570f930aaed27f73481e652ccfef6a5d1e102f2",
  "pino-pretty.mjs": "db4343e9a60574d43281e8e6731ec71a1317c53737c5cfc11049cd565ceae8ea",
  "pino-worker.mjs": "b1905ab6d4843945437af840160a682b9d86c3bee9ae7cb96f21032a98652297",
  "thread-stream-worker.mjs": "8d292b213919ff58dce983d0a34f68f3224345411fea8af1b64b11ec8cbeb249",
};
const relocate = new Set(["portalInvoiceAdapter.mjs", "pino-file.mjs", "pino-worker.mjs"]);
const literal = 'const outputDir = "' + outdir + '";';
for (const [file, expectedHash] of Object.entries(hashes)) {
  const filePath = path.join(outdir, file);
  let source = readFileSync(filePath, "utf8");
  const occurrences = source.split(literal).length - 1;
  assert.equal(occurrences, relocate.has(file) ? 1 : 0, "pino output layout drift: " + file);
  if (occurrences) {
    // The existing Pino bundler embeds the BUILD directory. Change only that
    // exact generated constant to the module's OWN directory; signed bytes
    // then remain the same after the complete five-file bundle is relocated.
    source = source.replace(literal, 'const outputDir = new URL(".", import.meta.url).pathname;');
    writeFileSync(filePath, source);
  }
  const digest = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  assert.equal(digest, expectedHash, "reviewed original-owner artifact SHA mismatch: " + file);
}
console.log("CUSTOMER_INVOICE_ALL_FIVE_OWNER_PACKAGE_HASHES_PASS");
NODE

# NODE_ENV=development is crucial! Portal database selection treats
# NODE_ENV=production as production even if APP_ENV=development.
APP_ENV=development NODE_ENV=development \
CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV=false \
CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV=false \
node --input-type=module - "$OUT_DIR/portalInvoiceAdapter.mjs" <<'NODE'
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const owner = await import(pathToFileURL(process.argv[2]).href);
assert.equal(typeof owner.postCustomerInvoiceWithOriginalOwner, "function");
await assert.rejects(owner.postCustomerInvoiceWithOriginalOwner({}),
  /CUSTOMER_INVOICE_POSTING_DEV_FLAGS_OFF/);
console.log("CUSTOMER_INVOICE_EXISTING_OWNER_ESM_DEV_IMPORT_PASS");
console.log("CUSTOMER_INVOICE_NO_DATABASE_OR_POSTING_WHEN_FLAGS_OFF_PASS");
// Pino's test-only transport worker must not keep this ephemeral check alive.
process.exit(0);
NODE
cd "$ROOT"
git diff --exit-code -- artifacts/api-server/src lib/db/src scripts/tests pnpm-lock.yaml
