# Native Payroll accrual runtime package — staged DEV assembly

## What changed

The prior candidate had an HTTP binder and transaction service, but the patched
native journal engine was available only inside rehearsal bundles using test
boundary adapters. This build produces a standalone accrual-only artifact and
the actual server candidate now has a gated startup path to load it and bind a
separate settlement connection. No environment flag, credential, database role,
live process or production deployment is changed by these source additions.

## Reuse and provenance, not a second financial engine

`build-artifact.mjs` verifies the existing `provenance.json` SHA256 list BEFORE
copying source to a temporary build directory, applies the already-tested
`legacy-transaction-bound.patch` with zero fuzz, and uses the TypeScript AST to
select the existing functions and `postAccrualJournal` method verbatim. The SQL,
amount calculation, checksum, audit and outbox logic remain the pinned patched
source. Other payroll/payment/closing functions are not exported or copied into
the runtime entrypoint. The real accounting schema and Drizzle dependencies are
bundled from the locked canonical worktree.

The runtime adapter requires an explicit caller transaction and refuses any
attempt to use the old global database, auto-migration, background notification
or scheduler capability. These disabled capabilities THROW; they do not return
mock success or simulate financial writes. Diagnostics contain only a generic
code/level, not SQL or salaries. Only Node's `node:crypto` is allowed as an external
import; there is no pool/secret provider/fixture global in the artifact.

The manifest records original and patched hashes, exact extracted body hashes,
builder/adapter/lockfile hashes, every canonical build input, tool versions and
artifact bytes/hash. Identical inputs produced identical output in the recorded
verification. This is integrity/provenance metadata, not an authorization token.

Build (explicit source and destination; fails instead of overwriting files):

```sh
node scripts/payroll-native-runtime/build-artifact.mjs /absolute/pinned/source /absolute/release-output
node scripts/payroll-native-runtime/verify-build.mjs /absolute/pinned/source
```

## Verified-byte loader and startup

`loadDevPayrollNativeArtifact` requires both DEV atomic flags and a separately
approved SHA256. It opens an absolute regular file without following a leaf
symlink, reads at most 4 MiB, verifies the exact bytes and then imports those
bytes via a data URL. It does NOT check a path and later execute potentially
replaced bytes from that path. The expected hash must come from trusted release
configuration, never from HTTP input or a manifest provided alongside arbitrary
code. Loading trusted pinned code is not a sandbox for untrusted code.

The loader accepts exactly the expected frozen accrual-only exports. The helper
`bindDevPayrollNativeArtifactRuntime` reuses the existing asynchronous binder and
its direct-connection, read-only 18-table structural preflight.

`prepareDevPayrollAtomicRuntime`, now called by `index.ts` ONLY when the existing
DEV route and posting flags are true, performs this order:

1. Require existing signed-OTP mode and explicit server-only configuration.
2. Verify/load the accrual artifact before asking for any database credential.
3. Use the EXISTING `@workspace/db.readSecret` (including its DEV systemd/GCP
   custody), restricted to a `bizportal-payroll-settlement-dev` secret name.
4. Pin the PostgreSQL URL to CST-DEV, exact dedicated settlement identity,
   allowed direct/shared-pooler host/port, `postgres` DB and verified TLS.
   No direct-env/shared/approver/PROD fallback or override query parameter.
5. Create a separate existing dedicated pool and await the original binder's
   real identity/ACL preflight. A failure closes the new pool and leaves posting
   unavailable. No automatic DDL, GRANT, LOGIN or role impersonation is attempted.

Required configuration names (not activated by this patch):

- `PAYROLL_DEV_ATOMIC_ROUTE_MOUNT_ENABLED=true`
- `PAYROLL_DEV_ATOMIC_POSTING_ENABLED=true`
- `PAYROLL_DEV_ATOMIC_NATIVE_ARTIFACT_PATH` (approved release `.mjs` file)
- `PAYROLL_DEV_ATOMIC_NATIVE_SHA256` (independently reviewed artifact fingerprint)
- `PAYROLL_DEV_ATOMIC_ALLOWED_ORIGIN` (exact HTTPS origin)
- `PAYROLL_SETTLEMENT_GCP_SECRET_NAME_DEV` (separate dedicated DEV secret name)

Existing OTP configuration and GCP authentication remain prerequisites. Do not
put passwords or private keys in this repository. Successful same-config startup
is idempotent; a different config requires restart. The GCP secret is not reread
or silently rotated after successful initialization. Routes still recheck flags,
verify the real signed actor/company, and use stored approval evidence for each
posting request. Binding does not itself approve, post, pay, send OTP or WA.

## Verification scopes — do not conflate them

- 11 build/integrity checks: real pinned-source build is reproducible, exports
  and imports restricted, no fixture global/credential embedded, actual generated
  artifact imports without a pool, disabled/missing transaction refused,
  transaction failure propagates, changed/symlink source rejected.
- Loader/startup/HTTP/preflight unit tests use synthetic artifact byte fixtures
  and simulated external secret/pool/session boundaries. These do NOT prove live
  GCP connectivity or a real signed HTTP posting session.
- The new `packaged` mode of the EXISTING PostgreSQL rehearsal builds the real
  artifact, loads it through the actual verified-byte loader, and substitutes
  that real writer for the prior test-boundary native writer. It then runs the
  existing reduced-permission preflight and all application transaction cases.
  No financial write in that package path is mocked; it uses the supplied
  caller-owned disposable transaction. The old baseline audit/outbox regression
  still uses its earlier test fixture solely to reproduce that historic bug.
- This is not the previously blocked combined authentication/HTTP/SQL harness,
  nor the blocked new ledger-fault harness. No session/OTP was handled here.

```sh
bash scripts/payroll-atomic-rehearsal/run-disposable.sh /absolute/pinned/source packaged
```

## Deployment boundary

This is a candidate source/startup assembly, not an installed service. The live
settlement role/managed secret, least-privilege policies, complete schema/trigger
semantics, fiscal period, real salary/deduction data and signed-session E2E must
still be verified before DEV operational acceptance. Other-deduction/legacy
installment limitations remain fail-closed. Post-commit consumers are not proved
by committing an outbox row. No PROD merge or deployment is authorized by a
package hash or these synthetic tests. Existing successful functions remain.

## Recorded candidate results — 17 November 2026

- Native build/integrity: 11/11 PASS; actual artifact SHA256
  `3bad52140b01aeebc0b7bf993785c8072bcaf7d07fae812bd118929ea7729159`,
  543390 bytes; generated binary is not committed.
- Focused loader/bootstrap/HTTP/structural-preflight unit tests: 131/131 PASS
  (19 loader + 35 startup + 44 HTTP + 33 preflight). External boundaries in
  these unit tests remain simulated, not live GCP/OTP acceptance.
- Actual packaged-writer PostgreSQL mode: 22 permission checks + 35 existing
  application transaction cases PASS. Default application35/guards20/native15
  modes rerun separately PASS; overlapping families are not summed.
- Full API: 944 PASS /49 skipped /0 failed; TypeScript and API build PASS.
- Compiled isolated startup without live configuration: liveness HTTP 200
  with flags OFF and ON; unauthenticated posting denied (401 /503 respectively).
  The ON-with-missing-configuration check is fail-closed evidence, not successful
  live startup. Both temporary API processes/ports and PostgreSQL containers
  were stopped; no active DEV or PROD service was restarted.

Live CST-DEV read-only check still shows the settlement role NOLOGIN, one
November Draft, zero Payroll journals/ledger/payment rows, and no November
fiscal period or structured salary/deduction profiles. Source startup assembly
now exists, but those live prerequisites remain unresolved.

## Other-deduction support update — 17 November 2026

The original unconditional nonzero-other-deduction rejection described above is
now narrowed: the candidate accepts an explicitly configured, validated
same-company `payroll_coa_mappings.other_deduction` liability mapping and the
existing native patch writes its exact credit. Missing/invalid mappings remain
blocked. No live configuration is created, and legacy installment gates remain.
See `scripts/payroll-other-deductions/README.md` for current cases, changed
artifact fingerprint, permission requirements and remaining release limits.
