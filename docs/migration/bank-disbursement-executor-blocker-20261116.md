# Bank Disbursement sole-executor migration blocker — 2026-11-16

**Canonical:** `bizportal/bizportal-app` (PR #95 Draft).
**Legacy application snapshot:** `Travelintrips/CST-BIZPORTAL`.
**Legacy upstream archive (source provenance):** `Travelintrips/CST-BIZPORTAL/.upstream-cst-super-app`.

## Verified ownership and lost dependency

1. Canonical frontend `artifacts/bizportal/src/pages/accounting/bank-disbursements.tsx` calls `POST /api/accounting/bank-disbursements`, plus GET list/detail/outstanding, void and metadata routes.
2. Canonical `artifacts/api-server/src/routes/index.ts` registers `accountingRouter`, but `artifacts/api-server/src/routes/accounting.ts` has no bank-disbursement routes. The trimmed legacy snapshot has the same missing route; this is **not** a normal two-snapshot file mismatch.
3. The upstream archived super-app contains `artifacts/api-server/src/routes/bankDisbursements.ts`, and its upstream `routes/index.ts` mounts this at `/accounting/bank-disbursements` with `financeAuditMiddleware`, `writeMethodGovernanceGuard`, `bdOcrAuthElevation` and `makeRbacGuard("invoice")`. The old route references shared Drizzle database definitions, `postEntryWithClient`, source guards, accounting seed, WHT and vendor-invoice financial helpers.
4. `docs/deprecation/bank-disbursement-sole-executor.md` in the upstream archive declares Bank Disbursement the **sole outbound bank payment executor**. Older vendor-payment and kas-transfer writers were deprecated/disabled. Therefore a hand-written lightweight replacement or direct payment POST in the canonical API would risk bypassing the ledger/journal custody rules.
5. An upstream `bankDisbursementMigration.ts` also exists, but it has historical DDL and must **never** be automatically executed during source migration.

## Safe interpretation

- A successful standalone canonical CI build does **not** prove the old disbursement route is mounted or operational.
- The PR #95 UI now routes list-level vendor invoice payment requests to the detail review; detail-level reversal and orphan warnings are present. **This is only UI guidance**, not backend idempotency/authorization.
- The existing public site or reverse proxy could route the missing endpoint to a separate service. Its currently active runtime must be inspected read-only before declaring the feature absent in production.
- **Cutover blocked** until the executor's ownership (current runtime vs archive), canonical integration approach, API contracts, secrets, role isolation, and rollback are known.

## Required gated recovery

1. Read-only inspect current DEV Nginx proxy, API ownership, and route health without creating transactions or exposing credentials.
2. Inventory the upstream sole-executor's GET/POST/void contract and transitive imports. Map each dependency to the existing canonical library, and identify behavior that must remain in the approved accounting writer service instead of being transplanted.
3. Preserve one writer and original journal custody. Require duplicate/replay locks, exact company/supplier/invoice scope, accepted statuses, WHT and reversal rules, and atomic journal/entry-line/allocation/audit commit.
4. Run disposable PostgreSQL E2E: first payment once, identical replay (no second debit), concurrent replay, crossed company, posted-to-reversed invoice, void and compensation, and invariant on journal count. Tests must not connect to PROD or an active DEV payment queue.
5. Shadow-deploy on DEV only after CI and API parity pass, then rehearse rollback. Hostinger current site and PROD remain unchanged.

**Scope of this note:** documentation only; no new payment writer route, database DDL, journal write, deployment, or feature-flag change.


## Direct VPS DEV runtime evidence (2026-11-16, read-only)

Remote device: `srv1792369`; Nginx site `bizportal-dev.cstlogistic.co.id`.

- Nginx document root: `/opt/cst-bizportal-gmail-dev/dist/public`; API proxy: `http://127.0.0.1:19784`; active service: `cst-bizportal-gmail-dev.service`.
- Active checkout `/opt/cst-bizportal-gmail-dev`: origin `Travelintrips/CST-BIZPORTAL`, HEAD `2705d4c7`.
- Pre-existing shadow checkout `/opt/bizportal-pr38-shadow-check-20261114`: origin `bizportal/bizportal-app`, HEAD `b418856`. **This is not PR #95's tested head** and is not the live document root.
- Local API `GET /api/health/live` returned HTTP 200.
- Unauthenticated requests to `/api/accounting/bank-disbursements`, `/api/accounting/no-such-endpoint-zz` and `/api/definitely-not-a-route-zz` **all returned HTTP 401**. Thus 401 is a general authentication-layer response and gives **no proof** the disbursement endpoint is registered.
- Searched the active and shadow API source for bank-disbursement route registration; neither checkout has `artifacts/api-server/src/routes/bankDisbursements.ts` or the standalone registered route. The upstream archived super-app remains the only located implementation.
- The Nginx vhost also uses HTTP Basic authentication; no authenticated browser/payment request, journal write or manual transfer was attempted.

**Confirmed cutover invariant:** do not replace the active DEV service with a candidate that lacks parity for the Bank Disbursement sole executor. Require source dependency mapping and disposable payment E2E before any live cutover. Do not infer endpoint availability from an unauthenticated 401.


## Legacy executor route contract inventory

Verified by reading the archived `bankDisbursements.ts` (approximately 2,557 source lines). Mounted under `/accounting/bank-disbursements` by the upstream router:

| Method | Relative path | Character |
| --- | --- | --- |
| GET | `/meta/accounts` | Account metadata |
| GET | `/counterparty-search` | Counterparty search |
| GET | `/vendors` | Vendor selection |
| GET | `/` | Disbursement list |
| GET | `/vendor-invoices/outstanding` | Candidate invoice balances |
| GET | `/summary` | Treasury summary |
| GET | `/:id` | Disbursement detail |
| POST | `/` | Financial disbursement writer |
| POST | `/:id/void` | Financial reversal/void writer |
| POST | additional registered handlers | Supplementary operations (must inspect individually) |
| POST | `/ocr-extract` | OCR upload processing |

The 106 KB route imports `drizzle-orm`, `postEntryWithClient`, `accountingSeed`, `resolveCompanyId`, `bdSourceGuard`, `auditLog`, OpenAI/OCR, WHT and vendor payment recalculation helpers. **This is not a stand-alone one-file transplant.**

The first safe implementation slice should be a fully authenticated company-scoped **read-only** parity adapter, but only after the current actual writer service has been identified and there is a documented owner for the bank payment POST. Do not accidentally turn GET data into a new payment authorizer.
