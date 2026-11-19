#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d /tmp/cst-original-owner-post.XXXXXXXX)"
PG_NAME="cst-original-owner-post-$$"
cleanup() {
  docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
  rm -f "$ROOT/artifacts/api-server/.qa-billing-handler-bundle.mjs"
  rm -f "$ROOT/artifacts/api-server/.qa-invoice-issuer-bundle.mjs"
  rm -f "$ROOT/artifacts/api-server/.qa-modern-invoice-handler.mjs"
  rm -f "$ROOT/artifacts/api-server/.qa-modern-otp-signer.mjs"
  rm -rf -- "$WORK"
}
trap cleanup EXIT

# The entire test runs against a fresh, locally bound disposable Postgres.
test -f "$ROOT/scripts/tests/customer-invoice-original-owner-synthetic-fixture.sql"
test -f "$ROOT/scripts/tests/customer-invoice-owner-disposable-runtime-parity.sql"
if docker ps -aq --filter "name=^/$PG_NAME$" | grep -q .; then
  echo "DISPOSABLE_CONTAINER_NAME_IN_USE"; exit 4
fi
cd "$ROOT/lib/db"
pnpm exec drizzle-kit generate --schema './src/schema/*.ts' \
  --dialect postgresql --out "$WORK/schema" --name disposable_owner
GENERATED="$(find "$WORK/schema" -maxdepth 1 -name '*.sql' -type f -print -quit)"
test -n "$GENERATED"
test "$(grep -c '^CREATE TABLE ' "$GENERATED")" = 86
docker run -d --rm --name "$PG_NAME" --pull missing \
  --memory 700m --cpus 1 \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,size=384m \
  -p 127.0.0.1::5432 -e POSTGRES_DB=invoice_synthetic -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=disposable-only postgres:16-alpine > /dev/null
ready=0
for _ in $(seq 1 80); do
  if docker exec "$PG_NAME" pg_isready -q -h 127.0.0.1 -U postgres -d invoice_synthetic &&
     docker exec "$PG_NAME" psql -qAt -h 127.0.0.1 -U postgres -d invoice_synthetic -c 'SELECT 1' 2>/dev/null | grep -qx 1; then
    ready=1; break
  fi
  sleep .25
done
test "$ready" = 1
sleep 2
for file in "$GENERATED" \
 "$ROOT/scripts/tests/customer-invoice-owner-disposable-runtime-parity.sql" \
 "$ROOT/scripts/tests/customer-invoice-original-owner-synthetic-fixture.sql"; do
  docker cp "$file" "$PG_NAME":/tmp/setup.sql
  docker exec "$PG_NAME" psql -v ON_ERROR_STOP=1 -U postgres -d invoice_synthetic \
    -f /tmp/setup.sql > "$WORK/postgres.log"
done
# Reuse the already-reviewed AR source trigger, not a fresh AR writer.
# The existing install SQL targets DEV, so its database-name guard is adapted
# solely in an ephemeral copy, never in the original source file.
docker cp "$ROOT/scripts/tests/customer-invoice-original-owner-ar-prerequisites.sql" \
  "$PG_NAME":/tmp/ar-prerequisites.sql
docker exec "$PG_NAME" psql -v ON_ERROR_STOP=1 -U postgres -d invoice_synthetic \
  -f /tmp/ar-prerequisites.sql > "$WORK/ar-prerequisites.log"
ORIGINAL="$ROOT/scripts/sql/customer_ar_source_dev_INSTALL_REVIEW.sql"
test "$(grep -Fc "('postgres', 'cst_customer_ar_ci')" "$ORIGINAL")" = 1
sed "s/('postgres', 'cst_customer_ar_ci')/('invoice_synthetic')/" \
  "$ORIGINAL" > "$WORK/reviewed-ar-disposable.sql"
grep -Fq "current_database() NOT IN ('invoice_synthetic')" \
  "$WORK/reviewed-ar-disposable.sql"
docker cp "$WORK/reviewed-ar-disposable.sql" "$PG_NAME":/tmp/ar-install.sql
docker exec "$PG_NAME" psql -v ON_ERROR_STOP=1 -U postgres -d invoice_synthetic \
  -f /tmp/ar-install.sql > "$WORK/ar-install.log"
docker exec "$PG_NAME" psql -v ON_ERROR_STOP=1 -U postgres -d invoice_synthetic \
  -c "UPDATE public.bizportal_customer_ar_source_actors_dev SET enabled=true,
             source_not_before=clock_timestamp()-interval '1 minute'
      WHERE role_name='postgres' AND company_id IN (1,3)" > "$WORK/ar-activation.log"
echo ORIGINAL_REVIEWED_AR_TRIGGER_INSTALLED_ON_DISPOSABLE_PASS

echo ORIGINAL_OWNER_SYNTHETIC_SCHEMA_READY

# Build ONLY the reviewed original owner entrypoint. Reuse its Pino plugin,
# including its worker files; verify all known artifact hashes before import.
mkdir "$WORK/bundle"
cd "$ROOT/artifacts/api-server"
OWNER_PKG_OUT="$WORK/bundle" node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import pinoPlugin from 'esbuild-plugin-pino';
globalThis.require = createRequire(import.meta.url);
const outdir = process.env.OWNER_PKG_OUT;
assert(outdir && outdir.startsWith('/tmp/cst-original-owner-post.'));
await build({
  entryPoints: ['src/lib/posting-engine/portalInvoiceAdapter.ts'],
  outdir,
  outExtension: { '.js': '.mjs' },
  platform: 'node',
  format: 'esm',
  bundle: true,
  plugins: [pinoPlugin({ transports: ['pino-pretty'] })],
  banner: { js: 'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);' },
  logLevel: 'warning',
});
const expected = {
  'portalInvoiceAdapter.mjs': '7f6568dd838b18698078ed87d4a2c64bc8014ff73f278df405d62fa35628d367',
  'pino-file.mjs': 'bbc4281497fe72cf43c497927570f930aaed27f73481e652ccfef6a5d1e102f2',
  'pino-pretty.mjs': 'db4343e9a60574d43281e8e6731ec71a1317c53737c5cfc11049cd565ceae8ea',
  'pino-worker.mjs': 'b1905ab6d4843945437af840160a682b9d86c3bee9ae7cb96f21032a98652297',
  'thread-stream-worker.mjs': '8d292b213919ff58dce983d0a34f68f3224345411fea8af1b64b11ec8cbeb249',
};
const relocate = new Set(['portalInvoiceAdapter.mjs','pino-file.mjs','pino-worker.mjs']);
const literal = 'const outputDir = "' + outdir + '";';
for (const [file, hash] of Object.entries(expected)) {
  const filePath = path.join(outdir, file);
  let bytes = readFileSync(filePath,'utf8');
  const count = bytes.split(literal).length - 1;
  assert.equal(count,relocate.has(file)?1:0,'output dir changed: '+file);
  if (count) {
    bytes = bytes.replace(literal,'const outputDir = new URL(".", import.meta.url).pathname;');
    writeFileSync(filePath,bytes);
  }
  assert.equal(createHash('sha256').update(readFileSync(filePath)).digest('hex'),hash,'sha: '+file);
}
console.log('ORIGINAL_OWNER_FIVE_ARTIFACT_HASHES_PASS');
NODE
PORT="$(docker port "$PG_NAME" 5432/tcp | head -1 | awk -F: '{print $NF}')"
test "$PORT" -ge 1024
cd "$ROOT"
APP_ENV=development NODE_ENV=development \
 CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV=true \
 CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV=true \
 CUSTOMER_INVOICE_DISPOSABLE_DB_URL="postgresql://postgres:disposable-only@127.0.0.1:$PORT/invoice_synthetic" \
 CUSTOMER_INVOICE_DISPOSABLE_OWNER_PATH="$WORK/bundle/portalInvoiceAdapter.mjs" \
 node scripts/tests/customer-invoice-original-owner-disposable.mjs
echo ORIGINAL_OWNER_DISPOSABLE_JOURNAL_ACCEPTANCE_PASS
# Original PR142's 12% Diva fixture leaves its disposable default selected
# at tax id 4. Restore the synthetic default id 3 for this subsequent
# completely separate 11% modern E2E fixture. Never touch hosted DB.
docker exec "$PG_NAME" psql -U postgres -d invoice_synthetic -v ON_ERROR_STOP=1 -q -c  "update public.accounting_settings set default_sales_tax_id=3 where company_id=3 and default_sales_tax_id=4" >/dev/null
disposable_tax="$(docker exec "$PG_NAME" psql -U postgres -d invoice_synthetic -Atc "select default_sales_tax_id from public.accounting_settings where company_id=3")"
[ "$disposable_tax" = 3 ] || { echo DISPOSABLE_DIVA_TAX_FIXTURE_NOT_RESTORED;exit 1; }
echo ORIGINAL_DIVA_SYNTHETIC_11_PERCENT_DEFAULT_RESET_PASS

# Install the original Portal's existing synthetic records and the NEW
# company-scoped RLS-only smoke fixture. No HTTP or real identity.
docker cp "$ROOT/scripts/tests/customer-invoice-portal-handler-disposable-extra.sql" "$PG_NAME":/tmp/portal-extra.sql
docker exec "$PG_NAME" psql -v ON_ERROR_STOP=1 -U postgres -d invoice_synthetic -f /tmp/portal-extra.sql > "$WORK/portal-extra.log"
docker cp "$ROOT/scripts/tests/customer-invoice-modern-hosted-portal-tables.sql" "$PG_NAME":/tmp/qa-hosted-portal.sql
docker exec "$PG_NAME" psql -v ON_ERROR_STOP=1 -U postgres -d invoice_synthetic -f /tmp/qa-hosted-portal.sql > "$WORK/hosted-portal.log"
echo ORIGINAL_PORTAL_SCHEMA_MISSING_TABLES_QA_PARITY_PASS
docker cp "$ROOT/scripts/tests/customer-invoice-modern-otp-synthetic-rls.sql" "$PG_NAME":/tmp/modern-rls.sql
docker exec "$PG_NAME" psql -v ON_ERROR_STOP=1 -U postgres -d invoice_synthetic -f /tmp/modern-rls.sql > "$WORK/modern-rls.log"
# Reset earlier broad synthetic grants to the actual hosted CST-DEV
# table/column/sequence grants (read-only introspection snapshot).
docker cp "$ROOT/scripts/tests/customer-invoice-hosted-20261119-grant-parity.sql" "$PG_NAME":/tmp/hosted-qa-acl.sql
docker exec "$PG_NAME" psql -v ON_ERROR_STOP=1 -U postgres -d invoice_synthetic -f /tmp/hosted-qa-acl.sql > "$WORK/acl-parity.log"
echo HOSTED_CSTDEV_WRITER_COLUMN_GRANT_SNAPSHOT_LOADED_PASS
for company in cst diva; do
  role="$(printf 'bizportal_customer_invoice_%s_writer_dev' "$company")"
  denied="$(docker exec "$PG_NAME" psql -U postgres -d invoice_synthetic -Atc "select has_column_privilege('$role','public.audit_accounting_events','after_state','INSERT')::text || ':' || has_column_privilege('$role','public.audit_accounting_events','change_reason','INSERT')::text")"
  test "$denied" = "false:false" || { echo "HOSTED_AUDIT_GRANT_SNAPSHOT_NOT_STRICT:$denied";exit 1; }
done
echo HOSTED_CSTDEV_AUDIT_MISSING_COLUMNS_PROVEN_PASS
for company in cst diva; do
  role="$(printf 'bizportal_customer_invoice_%s_writer_dev' "$company")"
  if [ "$company" = cst ]; then tax_id=1;company_id=1;else tax_id=3;company_id=3;fi
  if docker exec "$PG_NAME" psql -U "$role" -d invoice_synthetic -v ON_ERROR_STOP=1 -Atc "select id from public.accounting_taxes where id=$tax_id and company_id=$company_id for share" >/dev/null 2>&1;then
    echo "HOSTED_TAX_SOURCE_FOR_SHARE_UNEXPECTEDLY_ALLOWED_$company";exit 1
  fi
  echo "HOSTED_CSTDEV_TAX_ROWLOCK_MISSING_PRIVILEGE_PROVEN_$company"_PASS
done

# Opt in exact B6 source policy and two missing audit columns ONLY on the
# throwaway database, never hosted CST-DEV.
docker cp "$ROOT/vendor/customer-portal/scripts/dev-invoice-tax-source-lock-20261119.sql" "$PG_NAME":/tmp/tax-lock.sql
docker exec "$PG_NAME" psql -v ON_ERROR_STOP=1 -U postgres -d invoice_synthetic -f /tmp/tax-lock.sql > "$WORK/taxlock.log"
grep -Fq 'GRANT INSERT(change_reason,after_state)' "$ROOT/scripts/dev-customer-invoice-audit-columns-20261119.sql"
sed -n '/^GRANT INSERT(change_reason,after_state)/,+2p' "$ROOT/scripts/dev-customer-invoice-audit-columns-20261119.sql" > "$WORK/audit-cols-only.sql"
test "$(wc -l < "$WORK/audit-cols-only.sql")" -eq 3
docker cp "$WORK/audit-cols-only.sql" "$PG_NAME":/tmp/audit-cols-only.sql
docker exec "$PG_NAME" psql -v ON_ERROR_STOP=1 -U postgres -d invoice_synthetic -f /tmp/audit-cols-only.sql > "$WORK/audit-grant.log"
echo HOSTED_CSTDEV_ONLY_REVIEWED_B6_AND_TWO_AUDIT_COLUMNS_OPTIN_PASS
echo MODERN_DISPOSABLE_COMPANY_SCOPED_ROLES_READY

for company in cst diva; do
 role="bizportal_customer_invoice_${company}_writer_dev"
 if [ "$company" = cst ]; then company_id=1;tax_id=1;else company_id=3;tax_id=3;fi
 actual="$(docker exec "$PG_NAME" psql -U "$role" -d invoice_synthetic -Atc "select current_user || ':' || session_user || ':' || row_security_active('public.sales_documents'::regclass)")"
 [ "$actual" = "$role:$role:true" ] || { echo ROLE_OR_RLS_INVALID_"$company":"$actual"; exit 1; }
 echo MODERN_WRITER_DIRECT_SESSION_RLS_"$company"_PASS
 docker exec "$PG_NAME" psql -U "$role" -d invoice_synthetic -v ON_ERROR_STOP=1 -Atc "begin; select id from public.accounting_taxes where id=$tax_id and company_id=$company_id for share; select company_id from public.accounting_settings where company_id=$company_id for share; commit;" >/dev/null
 echo MODERN_INVOICE_TAX_SOURCE_LOCK_"$company"_PASS
done
echo MODERN_ORIGINAL_ACCOUNTING_SYNTHETIC_ROLE_SMOKE_PASS

cd "$ROOT/artifacts/api-server"
node "$ROOT/scripts/tests/customer-invoice-modern-owner-bundles.mjs"
cd "$ROOT"
APP_ENV=development NODE_ENV=development  CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV=true  CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV=true  CUSTOMER_PORTAL_REQUIRE_BIZPORTAL_ATTEST_DEV=true  CUSTOMER_PORTAL_INVOICE_CROSS_DEVICE_HANDOFF_DEV=true  CUSTOMER_PORTAL_INVOICE_SIGNED_REVIEW_SNAPSHOT_DEV=true  CUSTOMER_PORTAL_INVOICE_TAX_SOURCE_ROWLOCK_DEV=true  BIZPORTAL_CUSTOMER_INVOICE_ATTEST_DEV=true  BIZPORTAL_CUSTOMER_INVOICE_HANDOFF_DEV=true  BIZPORTAL_CUSTOMER_INVOICE_SIGNED_REVIEW_SNAPSHOT_DEV=true  CUSTOMER_INVOICE_DISPOSABLE_DB_URL="postgresql://postgres:disposable-only@127.0.0.1:$PORT/invoice_synthetic"  CUSTOMER_INVOICE_DISPOSABLE_OWNER_PATH="$WORK/bundle/portalInvoiceAdapter.mjs"  node "$ROOT/scripts/tests/customer-invoice-modern-original-owner-pg16.mjs"
echo MODERN_AND_ORIGINAL_ACCOUNTING_POSTGRES16_E2E_TEST_COMPLETE
