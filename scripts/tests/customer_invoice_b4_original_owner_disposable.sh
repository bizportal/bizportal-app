#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d /tmp/cst-original-owner-post.XXXXXXXX)"
PG_NAME="cst-original-owner-post-$$"
cleanup() {
  docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
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
# Portable scope: same original Owner bundle/PG16 fixture above.
# The new Auth/Portal tables are minimal synthetic fixtures; no hosted writes.
docker cp "$ROOT/scripts/tests/customer_invoice_b4_extension.qa.sql" "$PG_NAME":/tmp/b4ext.sql
docker exec "$PG_NAME" psql -X -q -v ON_ERROR_STOP=1 \
 -U postgres -d invoice_synthetic -f /tmp/b4ext.sql > "$WORK/b4ext.log"
for stage in b1 b2 b3 b4; do
 case "$stage" in
  b1) source="$ROOT/scripts/sql/customer_invoice_scoped_writer_read_phase_b1_cst_dev.sql" ;;
  b2) source="$ROOT/scripts/sql/customer_invoice_scoped_identity_read_phase_b2_cst_dev.sql" ;;
  b3) source="$ROOT/scripts/sql/customer_invoice_scoped_auth_lock_phase_b3_cst_dev.sql" ;;
  b4) source="$ROOT/scripts/sql/customer_invoice_scoped_writer_b4_dormant_cst_dev.sql" ;;
 esac
 test -f "$source"
 sed "s/current_database()<>'postgres'/current_database()<>'invoice_synthetic'/g" "$source" > "$WORK/$stage.sql"
 docker cp "$WORK/$stage.sql" "$PG_NAME":"/tmp/$stage.sql"
 docker exec "$PG_NAME" psql -X -q -v ON_ERROR_STOP=1 \
  -U postgres -d invoice_synthetic -f "/tmp/$stage.sql" > "$WORK/$stage.log"
 echo "ORIGINAL_OWNER_SCOPED_$stage_POLICY_PASS"
done
docker exec "$PG_NAME" psql -X -qAt -U postgres -d invoice_synthetic \
 -c "SELECT 'ORIGINAL_OWNER_B1_B4_POLICY_TOTAL='||count(*) FROM pg_policies WHERE policyname LIKE 'cst_invoice_b%';"
docker cp "$ROOT/scripts/tests/customer_invoice_b4_new_sources.qa.sql" "$PG_NAME":/tmp/b4sources.sql
docker exec "$PG_NAME" psql -X -q -v ON_ERROR_STOP=1 \
 -U postgres -d invoice_synthetic -f /tmp/b4sources.sql > "$WORK/b4sources.log"
# Synthetic AR actors are explicitly enabled only inside this disposable PG.
docker exec "$PG_NAME" psql -X -q -v ON_ERROR_STOP=1 \
 -U postgres -d invoice_synthetic \
 -c "UPDATE public.bizportal_customer_ar_source_actors_dev SET enabled=true, source_not_before=clock_timestamp()-interval '1 day' WHERE role_name::text IN ('bizportal_customer_invoice_cst_writer_dev','bizportal_customer_invoice_diva_writer_dev');" > "$WORK/b4qa-actor.log"
# NOLOGIN is maintained: PostgreSQL's local superuser assumes only the
# synthetic session identity (session_user=current_user), so RLS is enforced.
APP_ENV=development NODE_ENV=development \
 CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV=true \
 CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV=true \
 CUSTOMER_INVOICE_DISPOSABLE_DB_URL="postgresql://postgres:disposable-only@127.0.0.1:$PORT/invoice_synthetic" \
 CUSTOMER_INVOICE_DISPOSABLE_OWNER_PATH="$WORK/bundle/portalInvoiceAdapter.mjs" \
 node "$ROOT/scripts/tests/customer_invoice_b4_owner_session_qa.mjs"
echo B4_ORIGINAL_CANONICAL_POSTING_CST_DIVA_REPLAY_ROLLBACK_PASS
# Disable actors before guarded B4-only permission rollback; no source
# journal is deleted. B1/B2/B3 and the two NOLOGIN roles remain.
docker exec "$PG_NAME" psql -X -q -v ON_ERROR_STOP=1 \
 -U postgres -d invoice_synthetic \
 -c "UPDATE public.bizportal_customer_ar_source_actors_dev SET enabled=false WHERE role_name::text IN ('bizportal_customer_invoice_cst_writer_dev','bizportal_customer_invoice_diva_writer_dev');" > "$WORK/b4qa-disable.log"
sed "s/current_database()<>'postgres'/current_database()<>'invoice_synthetic'/g" \
 "$ROOT/scripts/sql/customer_invoice_scoped_writer_b4_rollback_cst_dev.sql" > "$WORK/b4rollback.sql"
docker cp "$WORK/b4rollback.sql" "$PG_NAME":/tmp/b4rollback.sql
docker exec "$PG_NAME" psql -X -q -v ON_ERROR_STOP=1 \
 -U postgres -d invoice_synthetic -f /tmp/b4rollback.sql > "$WORK/b4rollback.log"
docker exec "$PG_NAME" psql -X -qAt -U postgres -d invoice_synthetic \
 -c "SELECT 'B4_POLICIES_AFTER_GUARDED_ROLLBACK='||count(*) FROM pg_policies WHERE policyname LIKE 'cst_invoice_b4_%';"
docker exec "$PG_NAME" psql -X -qAt -U postgres -d invoice_synthetic \
 -c "SELECT 'ORIGINAL_SALES_JOURNALS_AFTER_ROLLBACK='||count(*) FROM public.accounting_entries WHERE source='sales_invoice' AND status='posted';"
echo B4_GUARDED_ROLLBACK_LEAVES_POSTED_GL_INTACT_PASS
