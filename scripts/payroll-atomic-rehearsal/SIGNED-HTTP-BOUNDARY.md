# DEV Payroll accounting HTTP boundary — source candidate only

`payroll-accounting-http.ts` connects the exact POST endpoint
`/api/payroll/runs/:id/post-accounting?companyId=<selected-company>` to the
existing application-owned atomic transaction. `payroll.ts` registers the
router before its ordinary read-only authorization middleware, so this exact
financial path cannot inherit the legacy DEV-cookie fallback. No login,
Payroll calculation, journal engine or payment transport is rebuilt.

## Activation and trusted binding

Registration requires **both** `PAYROLL_DEV_ATOMIC_ROUTE_MOUNT_ENABLED=true`
and `PAYROLL_DEV_ATOMIC_POSTING_ENABLED=true`, with exact `APP_ENV=development`.
Each request checks the same gates again. PROD and default-OFF registration
have no handler. Active services were not changed or restarted.

Trusted server bootstrap must separately call `bindDevPayrollAtomicHttpRuntime`
with the dedicated settlement pool, verified patched native writer and one
explicit allowed web origin. There is no automatic credential loading or shared
pool fallback. An unbound configured route returns 503. Rebinding different
objects/origin requires process restart. No current production bootstrap calls
this function; therefore this source change alone cannot perform live posting.
The transaction service independently verifies the actual PostgreSQL settlement
role and the transaction-aware native writer compatibility contract.

## Request and authorization contract

Only the existing signed-session verifier and active DB account lookup identify
the actor. Super Admin is mandatory; no `getDevSession` fallback. The actor is
passed to the transaction from server-side verified data, never HTTP JSON. The
service still requires its ID/email and expected digest to match the original
approval receipt. This operation executes that prior approval; it does not
create a second approval or issue another signed session.

The configured Origin must match exactly, cross-site fetch metadata is denied,
and JSON content type is mandatory. Allowed body fields are only
`expectedDigest` and `postingDate`; actor, company, salary, COA and writer overrides
are rejected. Company selection must be one positive bounded integer, never
`all`, duplicate query parameters or implicit fallback. Calendar dates and
snapshot digest are checked before acquiring the settlement connection.
Responses are no-store. Raw DB errors, SQL, credentials, salary amounts and
identity details are not echoed or logged. Successful response explicitly says
`salaryPaid: false`. GET cannot post; disabling a gate disables subsequent
requests. Ambiguous failures return a redacted error advising status inspection,
not an automatic retry.

## Evidence limits

The HTTP contract tests exercise an actual Express listener but simulate the
authentication provider and transaction boundary. They verify routing, validation,
role checks, Origin checks, trusted actor extraction, default-OFF, redaction,
and safe responses. **They are not real signed-cookie or financial SQL E2E.**
The existing application PostgreSQL suite remains a separate test of the actual
transaction/native SQL writer. Passing these two layers separately does not
prove their complete authenticated composition.

A planned combined real-signed-session/HTTP/PostgreSQL harness was rejected by
the tool security gate. It was not executed or saved, and no alternate execution
path was attempted. No additional OTP was sent/read and no user cookie or live
credential was accessed. Do not claim that combined test PASS.

Outstanding release work remains: authorized end-to-end session composition,
trusted live DEV runtime binding, actual schema/RLS/trigger/outbox compatibility,
fiscal period, real HR data and supported deduction/legacy installment mapping.
All financial activation remains OFF. This does not authorize PROD deployment.
