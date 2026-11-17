# Fleet Finance → PT Diva Servis: PostgreSQL verification

These files verify the existing Fleet cash-payment integration. They do not enable any shared DEV or PROD writer.

- `test-fleet-finance-dsv-postgres.mjs` bundles the actual Fleet client and the actual canonical BizPortal Express router with a database adapter pointing only to a private Unix socket. It commits synthetic source payments and accounting journals in disposable PostgreSQL.
- `fixtures/fleet-finance-dev-schema.sql` contains schema captured from CST-DEV on 17 November 2026: ten relevant tables, 47 constraints, eleven unique indexes, and sixteen installed triggers. It contains no customer or driver records. Unused cost-center/tax foreign-key targets are empty ID stubs. The Customer AR actor registry is empty.
- `qa-fleet-finance-dsv-rollback.sql` is a separate check of the installed CST-DEV database guards. It requires the already verified Diva settings (company 3, cash account 49187, driver receivable 49191, cash journal 20), creates synthetic fixtures inside one transaction, and ends with `ROLLBACK`. Run it only through the explicitly selected CST-DEV project `xssrfshdrtdfupgqwfdw`. It is not an HTTP or operational-login test.

## Isolation

Use a fresh PostgreSQL container with `--network none`, no published ports, tmpfs data storage, and a root-private Unix socket under `/tmp/fleet-finance-dsv-qa-*/pgsocket`. The harness rejects other socket locations and database names. The connection used by the HTTP router is a non-superuser, non-`BYPASSRLS` synthetic role. Its source access is company 1; its journal and ledger writes are limited to company 3.

The fixture role is local to the disposable database. It is not a migration or a request to widen an existing Finance role. The receiver's source-row `FOR UPDATE` check requires a lock-capable UPDATE grant, which the existing shared-DEV Finance reader roles do not currently have.

## Reproduction on the authorized VPS

1. Start fresh cached `postgres:16-alpine` as described above, with database `fleet_finance_qa`. Wait until container PID 1 is `postgres` and `pg_isready` succeeds; the image briefly runs a temporary init server, so a readiness probe alone can be premature.
2. Load `scripts/fixtures/fleet-finance-dev-schema.sql` through `docker exec -i ... psql -U postgres -d fleet_finance_qa -v ON_ERROR_STOP=1`.
3. Run `node scripts/test-fleet-finance-dsv-postgres.mjs`. Override these nonsecret paths as needed:
   - `FLEET_QA_PG_SOCKET`: private disposable socket.
   - `FLEET_QA_DEPENDENCIES`: installed canonical BizPortal dependencies.
   - `FLEET_QA_CLIENT_REPO`: Fleet candidate containing the company mapping patch.
4. Stop/remove only that disposable container after collecting the result. Do not delete or alter posted journals to reset the fixture database: the copied immutability protections intentionally reject that.
5. Recreate a fresh disposable container before rerunning the complete test, because successful tests commit immutable synthetic journals.

The service token is randomly generated in memory and is never printed. Both writer flags are enabled only in the harness process. Neither application starts its background schedulers.

## Evidence and limits

The first full run passed 18 checks. After adding strict JSON amount validation, inactive-destination checks, and historical-journal ownership verification, the final actual PostgreSQL run passed 22 checks, including eight simultaneous payment deliveries (one creation and seven idempotent replays), five simultaneous reversal replays, all six derived ledger lines under Diva company 3, source ownership under company 1, original-account reversal, and closed-period rejection.

The isolated PostgreSQL version is 16.15; CST-DEV uses PostgreSQL 17.6. The separate rollback SQL validates the current installed guards on CST-DEV. Neither test substitutes for deployment, the operational service-token/login configuration, or public signed-in Fleet acceptance. The HTTP harness exercises the Finance boundary, not the entire Fleet create/cancel source workflow.

## Separate shared-DEV evidence

The parent task verified the company 3 settings against existing Diva defaults: cash 49187, driver receivable 49191, journal 20. It ran the separate rollback script against CST-DEV: ten checks passed and all source/journal/line/ledger fixtures were absent afterward. The dedicated live service-login TLS connection succeeded but returned PostgreSQL `42501` on `accounting_settings`; its operational permissions are not ready. No access grants were added and public Finance writers remain disabled. This limitation is distinct from the isolated router/SQL test result.

## Company contract and release state

The authorized mapping is `FLEET_FINANCE_COMPANY_MAP={"1":3}` on both sides. Company 1 remains the Fleet source owner; company 3 is PT Diva Servis in Finance. No historical Fleet rows are reassigned.

- Settings GET supplies `sourceCompanyId=1` in the query and targets `/companies/3/accounting-settings`. Settings PUT and cash payment/reversal bodies carry `sourceCompanyId: 1` and `companyId: 3`.
- Successful responses return both IDs. The Fleet client rejects a mismatched response and does not fall back to direct database access for mapped operations.
- Receiver writes require the separate `FLEET_FINANCE_WRITE_ENABLED=true`; its default is OFF. The Fleet caller retains its independent `CENTRAL_FINANCE_WRITE_ENABLED` gate. Source settings alone do not enable either writer.
- Cash source provenance is stored as `source_event_id=fleet-cash-payment:1:<paymentId>`. Reversals retain the original accounting company and reverse the actual original lines. Replays validate the posted entry, journal ownership, amounts and line provenance before acknowledging success.
- The counterpart Fleet client change is [Fleet PR #112](https://github.com/Travelintrips/Fleet-Intelligence/pull/112). This branch does not merge, deploy, grant database privileges, create a PROD journal, or turn imported Gojek fee rows into accounting entries.

The scoped HTTP suite and existing integration contract suite passed **33/33**, and the API TypeScript check passed:

```sh
pnpm --filter @workspace/api-server exec vitest run src/__tests__/fleet-finance-company-http.test.ts src/__tests__/fleet-finance-integration-contract.test.ts
pnpm --filter @workspace/api-server exec tsc -p tsconfig.json --noEmit
```

GitHub workflow inspection confirmed that feature branch pushes do not deploy. The Release Gate runs on pull requests to main/develop and contains validation jobs only. Operational activation remains separate from these source and isolated-database results.
