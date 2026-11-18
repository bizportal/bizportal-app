# Other Payroll deductions: reuse the existing company component mapping

## Scope and reuse

The earlier accrual candidate correctly refused every nonzero `otherDeductions`
because the legacy native line builder had no corresponding credit line. This
change completes that component on the candidate rather than zeroing it or
inventing an account. It extends the SAME handoff, transaction and cumulative
native patch. It does not create another journal engine, API, mapping table,
configuration row, login or financial approval.

Live read-only CST-DEV inspection on 17 November 2026 confirmed an existing
`public.payroll_coa_mappings` table with unique (company_id, component), an
`other_deduction` component and a validation trigger requiring liability type
for that component. CST company 1 has no such mapping; mappings observed in
another company are NOT copied or used as fallback. No live data was changed.

## Transaction behavior

When other deductions are positive, the original application transaction reads
exactly one same-company `other_deduction` mapping, joins its account, and locks
both rows (`FOR SHARE OF m,a`) in its existing transaction. Both the standard
account type and the legacy COALESCE(account_type,type) must be liability, with
an explicitly same-company, active, postable, non-header, ACTIVE account. Missing
mapping, access, wrong company or unusable metadata abort before native posting.
The configured account is loaded server-side, never accepted from HTTP input.

The existing native `PayrollJournalService.postAccrualJournal` receives optional
`otherDeductionPayableAccountId` and `totalOtherDeductions` parameters and appends
one credit line for the exact summed amount. That optional extension leaves
all original salary, allowance, tax, BPJS and kasbon formulas unchanged. The
original gross equals net plus all deductions; integer-cent validation includes
the other deduction. No balancing adjustment or invented rounding account.
A nonzero amount without mapping, or a negative/non-finite amount, is rejected
by the packaged native method before any SQL.

Journal and ledger read-back includes the explicit credit on first post AND
replay. Changed item amounts are rejected by the existing approval digest;
changed mapped accounts after posting are rejected by the persisted-line match,
not automatically reposted. Receipt/time, original journal source/reference,
kasbon repayment idempotency and the single transaction are retained.

Zero-other-deduction Payroll does not query the optional mapping or pass new
native parameters. Its established six-line mixed-component example remains
unchanged and does not require a mapping or extra table access.

## Permissions and deployment contract

The settlement service needs SELECT and narrowly guarded row-lock rights on the
existing mapping table only for nonzero amounts. PostgreSQL SELECT FOR SHARE
uses both SELECT and UPDATE policy visibility. The disposable fixture grants
UPDATE(id) only, a company-scoped lock policy with WITH CHECK(false), and a
trigger refusing all actual mapping UPDATEs. The writer cannot insert, change,
or delete mappings; the fixture proves that denial. See PostgreSQL 16 CREATE
POLICY, Per-Command Policies / UPDATE, and SELECT locking documentation.

This is a fixture-only permission design, not a live grant/migration. RLS was
not disabled. The prior runtime 18-table structural preflight remains unchanged;
it does not promise optional mapping access. Missing optional privileges still
fail closed in the actual transaction. An operational rollout must review these
rights and the real account, without copying another company's configuration.

## Verification and honest limits

- 12 additional handoff cases; existing handoff suite now 46 PASS and existing
  transaction unit suite 10 PASS. Nonzero/missing/invalid mapping and exact
  fractional amounts are covered without weakening the prior missing-mapping
  rejection. All 1,019 API tests run PASS, 49 skipped, zero failed. TypeScript
  and API build PASS. Skipped is not PASS.
- Actual packaged native writer, actual PostgreSQL 16 transaction and existing
  ledger trigger snapshots: 22 new mapped-deduction cases PASS, after 22 existing
  privilege checks and 35 original application scenarios. No financial function
  in the mapped native path is mocked; data and role policies are synthetic.
- New cases cover Rp0.01/Rp1/fractional values, zero net, replay/concurrency,
  foreign/missing/inactive accounts, missing SELECT rights, read-but-not-write
  mapping, changed approval inputs, changed mapping on replay, closed period,
  preserved zero-deduction behavior and all 17 employees with nonzero deductions.
- The original application/permission/selected-guard/native suites remain PASS
  independently. Period-registration suite remains PASS. Test groups overlap;
  they are not summed into a unique E2E acceptance number.
- Package integrity now 13 checks PASS; reproducible artifact SHA256
  `a3f15c81fcd845b42d86b9258762adb7f006589cee3baef78813f9e5acdb562b`,
  543873 bytes. Runtime approval of this NEW hash is still a separate deployment
  action. The generated binary is not committed or installed.

The first disposable run revealed the canonical Drizzle fixture omits the
legacy account_type field already present in actual DEV. The fixture models it
explicitly. The next run exposed SELECT-only policy suppression of row locks;
the fixture adds the scoped lock policy with WITH CHECK(false), preserving the
no-mutation trigger. Neither issue was 'fixed' by relaxing an active database,
removing assertions, changing source-of-truth salaries or disabling RLS.

## Remaining FULL PASS gates

This resolves the candidate's blanket rejection of correctly mapped other
liability deductions, not all live Payroll setup. Actual CST-DEV still has no
company-1 other mapping, structured salary/deduction data or November period;
settlement remains NOLOGIN. No live permission, actor/session, credential,
payroll approval, journal, ledger, bank or salary payment was modified here.
Signed-session HTTP→SQL, full active schema/trigger behavior, outbox consumers,
legacy installment schedules and legitimate operational setup remain separate
work. Existing startup and financial flags stay untouched; PROD not deployed.

Run the same existing packaged suite (no new credentialed harness):

```sh
bash scripts/payroll-atomic-rehearsal/run-disposable.sh /absolute/pinned/source packaged
node scripts/payroll-native-runtime/verify-build.mjs /absolute/pinned/source
```
