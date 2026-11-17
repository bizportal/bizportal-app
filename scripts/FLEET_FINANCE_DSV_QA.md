# Fleet Finance → PT Diva Servis: PostgreSQL verification

These files verify the existing Fleet cash-payment integration with source company 1 and Finance destination company 3, PT Diva Servis.

- `test-fleet-finance-dsv-postgres.mjs` bundles the actual Fleet client and canonical BizPortal Express router with a database adapter pointing only to a private Unix socket. It commits synthetic source payments and accounting journals in disposable PostgreSQL.
- `fixtures/fleet-finance-dev-schema.sql` contains schema captured from CST-DEV on 17 November 2026: ten relevant tables, 47 constraints, eleven unique indexes, and sixteen installed triggers. It contains no customer or driver records. Unused cost-center/tax foreign-key targets are empty ID stubs. The Customer AR actor registry is empty.
- `qa-fleet-finance-dsv-rollback.sql` checks installed CST-DEV guards. It requires the verified Diva settings (company 3, cash account 49187, driver receivable 49191, cash journal 20), creates synthetic fixtures inside one transaction, and ends with `ROLLBACK`. Run it only through CST-DEV project `xssrfshdrtdfupgqwfdw`. It is not an HTTP or operational-login test.
- `sql/dev/20261117140646_dev_fleet_diva_company_metadata_read.sql` records the narrow DEV metadata grant and company policy applied for the existing dedicated Diva reader. It is deliberately outside automatic PROD migration paths.

## Company contract

The authorized mapping is `FLEET_FINANCE_COMPANY_MAP={"1":3}` on both sides. Company 1 remains the Fleet source owner; company 3 is PT Diva Servis in Finance. Existing Fleet rows retain their source ownership.

- Settings GET supplies `sourceCompanyId=1` in the query and targets `/companies/3/accounting-settings`. Settings PUT and cash payment/reversal bodies carry `sourceCompanyId: 1` and `companyId: 3`.
- Successful responses return both IDs. The Fleet client rejects a mismatched response and does not fall back to direct database access for mapped operations.
- Receiver writes require `FLEET_FINANCE_WRITE_ENABLED=true`; its default is OFF. The Fleet caller retains its independent `CENTRAL_FINANCE_WRITE_ENABLED` gate.
- Cash provenance is stored as `source_event_id=fleet-cash-payment:1:<paymentId>`. The receiver locks and validates the committed source payment before writing. Reversals retain the original accounting company and reverse the actual original lines.
- Replays validate the posted entry, journal ownership, amounts, line provenance, and derived ledger before acknowledging success.

The installed line trigger catches ledger INSERT failures as warnings. The receiver therefore checks the trigger's result before COMMIT: exactly two derived rows must match the actual posted header and lines by company, date, source type, header source ID, entry number, account, debit, and credit. Missing or inconsistent ledger rows produce a controlled HTTP 409 and roll back a new payment or reversal. Replays use the same integrity check.

## Isolated PostgreSQL reproduction

Use a fresh PostgreSQL container with `--network none`, no published ports, tmpfs data storage, and a root-private Unix socket under `/tmp/fleet-finance-dsv-qa-*/pgsocket`. The harness rejects other socket locations and database names. The HTTP router executes the actual dedicated DEV transaction wrapper through the real LOGIN `bizportal_fleet_finance_login_dev`, using the exact reviewed role/RLS migration. Only pg transport is redirected to the private socket; identity, RLS, scope, readiness and commit checks run unchanged. Strict TLS options are verified; real TLS negotiation is a separate actual-DEV check. Its source access is company 1; its journal and ledger writes are limited to company 3.

The test roles are local to the disposable database. The Finance source lock uses SELECT plus UPDATE(id), a hardcoded source-company boundary, and a restrictive UPDATE WITH CHECK(false). The separate `test-fleet-source-lock-rls-postgres.mjs` with `fixtures/fleet-source-lock-rls-qa.sql` passed 8/8 actual-LOGIN checks, proving a real row lock succeeds while id=id and amount mutation fail with 42501 even with an additional permissive PUBLIC update policy. Run that fixture in a fresh isolated environment or after the main scoped migration; do not pre-create its role before the main migration preflight.

1. Start fresh cached `postgres:16-alpine` as described above, with database `postgres`. Wait until container PID 1 is `postgres` and `pg_isready` succeeds; the image briefly runs a temporary init server.
2. Load `scripts/fixtures/fleet-finance-dev-schema.sql` through `docker exec -i ... psql -U postgres -d postgres -v ON_ERROR_STOP=1`. As the isolated owner, seed active company 1 and active company 3 named PT Diva Servis, then apply the exact reviewed `scripts/sql/dev/20261117143910_dev_fleet_finance_scoped_runtime_roles.sql`. Its preflight requires those company masters and an unused pair of runtime roles. Do not run this preparation against shared DEV or PROD.
3. Run `node scripts/test-fleet-finance-dsv-postgres.mjs`. Optional nonsecret path overrides are `FLEET_QA_PG_SOCKET` (private disposable socket), `FLEET_QA_DEPENDENCIES` (installed canonical BizPortal dependencies), and `FLEET_QA_CLIENT_REPO` (Fleet candidate).
4. Stop/remove only that disposable container after collecting the result.
5. Recreate a fresh disposable container before rerunning the complete test: successful tests commit immutable synthetic journals. Do not bypass the copied protections to delete posted fixtures.

The service token is randomly generated in memory and is never printed. Both writer flags are enabled only in the isolated harness process. Neither application starts background schedulers.

## Verification results

The final actual PostgreSQL HTTP run passed **27/27** checks with the actual new wrapper and exact scoped runtime roles. Coverage includes eight simultaneous payment deliveries (one creation and seven idempotent replays), five simultaneous reversal replays, all six derived ledger lines under Diva company 3, source ownership under company 1, original-account reversal, closed-period rejection, strict JSON amounts, inactive-company rejection, and historical-journal ownership.

Runtime settings are intentionally read-only: GET verifies mapped settings and actual write readiness; PUT returns controlled 403 before database access. Fixture settings are seeded or changed only by the isolated owner when exercising negative posting cases. The four ledger checks cover both new transactions and both replay paths:

- Removing ledger INSERT from the isolated role makes the actual trigger emit exactly two permission warnings for a new payment and for a reversal. Each request returns 409, and complete source/header/line/ledger snapshots remain unchanged after rollback.
- A temporary restrictive SELECT policy hides the existing ledger for a payment replay and a reversal replay. Each returns 409 while the two physical immutable rows remain intact. Restoring visibility restores successful idempotent replay.

The counterpart Fleet source create/retry/cancel/recovery harness passed **10/10** against this final receiver, including duplicate delivery and ownership-conflict cases. The receiver harness itself exercises the Finance boundary.

The scoped HTTP suite and existing integration contract suite and dedicated connection tests passed **71/71**; the API TypeScript check passed:

```sh
pnpm --filter @workspace/api-server exec vitest run src/__tests__/fleet-finance-company-http.test.ts src/__tests__/fleet-finance-integration-contract.test.ts src/__tests__/fleet-finance-dev-connection.test.ts
pnpm --filter @workspace/api-server exec tsc -p tsconfig.json --noEmit
```

The isolated PostgreSQL version is 16.15; CST-DEV uses PostgreSQL 17.6. The separate rollback script passed **10/10** against actual CST-DEV, with all source/journal/line/ledger fixtures absent afterward.

## Actual CST-DEV read proof

Company 3 settings were persisted from existing Diva defaults: cash 49187, driver receivable 49191, journal 20. An initial probe using the generic `bizportal_marketplace_finance_login_dev` identity connected with verified TLS but received PostgreSQL `42501` on `accounting_settings`.

The existing company credential bundle `bizportal-marketplace-finance-dev-companies`, version 1, already provided the dedicated `bizportal_finance_diva_login_dev` identity. This role could read Diva accounting settings, COAs, and journals. It needed only the active-company metadata check. The DEV SQL recorded above adds:

- SELECT on only `companies(id,is_active)`.
- An exact-role, exact-session permissive SELECT policy limited to active company 3.
- A matching restrictive policy that retains the same boundary if another permissive policy is added.

The role remains LOGIN, NOINHERIT, non-superuser and non-`BYPASSRLS`, with company RLS enabled. Company name access, company UPDATE, source-cash access/locking, Finance entry INSERT/UPDATE, and ledger INSERT remain unavailable. No Finance write grant was added.

At **2026-11-17 14:08:02 UTC**, an ephemeral loopback instance of the actual receiver passed **9/9** checks against real CST-DEV using that existing Diva identity:

| Check | Observed result |
| --- | --- |
| TLS, login and transaction mode | Trusted CA verified; current/session user both Diva; transaction read-only |
| Company boundary | Only company 3 visible from a query for companies 1 and 3 |
| Restricted company column | Selecting `name` denied with SQL `42501` |
| Existing privilege boundary | Broad company read, source-cash access/locking, and Finance/ledger writes still absent |
| Mapped settings GET | HTTP 200, source 1 / target 3, cash 49187, receivable 49191, journal 20 |
| Wrong destination | HTTP 403 before a database connection |
| Wrong source | HTTP 403 before a database connection |
| Invalid service token | HTTP 401 before a database connection |
| Writer OFF | Payment POST HTTP 503 before a database connection |

The probe used credentials only in memory, strict TLS, mandatory read-only transactions, and a randomly generated ephemeral service token. Its server and pool were closed afterward. Supabase security-advisor category/count totals remained unchanged after the metadata grant, with no company-table finding before or after.

## Release and operational limits

The counterpart change is [Fleet PR #112](https://github.com/Travelintrips/Fleet-Intelligence/pull/112); this receiver is [BizPortal draft PR #128](https://github.com/bizportal/bizportal-app/pull/128). Feature branch pushes do not deploy. The Release Gate runs on pull requests to main/develop and contains validation jobs only.

The earlier 9/9 real read used an ephemeral candidate with its database adapter bound to the existing Diva reader. The new activation candidate now uses a separate Fleet-only selector, never the global or existing Diva reader pool. It supports explicitly selected protected DSN or dedicated GCP credentials with identical strict DEV role/project/TLS checks, bounded connections, transaction-local scopes and fail-closed rotation. The thin runtime imports only this existing canonical router. Build, private deployment, capability probes and rollback instructions are in `docs/fleet-finance-dev-runtime.md`. Actual service activation and committed operational acceptance are recorded separately from the earlier read-only milestone.

At the preceding read-only milestone, both shared writers remained OFF. The authorized next stage activates only the scoped DEV cash flow; PROD remains unchanged. Candidate tests and the earlier Diva read proof do not themselves establish deployed public Fleet acceptance or convert imported Gojek fee rows into accounting entries.
