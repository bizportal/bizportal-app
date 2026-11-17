# Customer AR: connect the existing invoice source (Issue #69)

This change connects new, complete customer invoice events to the existing
`ar_subledger`. It does not introduce a journal writer, payment writer, invoice
number generator, bank matching approval, or historical backfill.

## Existing owner and missing link

The verified CST-DEV issuer is the existing upstream accounting owner used by
`cst-bizportal-gmail-dev.service`. A read-only runtime probe on 2026-11-17 found
`session_user = current_user = postgres`, database `postgres`, project
`xssrfshdrtdfupgqwfdw`. The default isolation is READ COMMITTED; the postgres role
and database have no isolation override. The owner already posts
`accounting_entries.source = sales_invoice`, `source_id = sales_documents.id`.

Canonical main/develop and draft PR #95 did not contain the upstream
`lib/accounting.ts`, `routes/sales.ts`, or `arApEngine.ts` issuance implementation.
The upstream accounting library alone is approximately 3,955 lines. Its legacy
AR sync references nonexistent `sales_documents.type` and `document_number`,
omits the required posted journal link, lacks the partial-index conflict
predicate, and adds the same paid amount again on repeated syncs. Porting that
sync would neither fix issuance ownership nor safely reconcile the current
schema.

The database connection below integrates the existing owner without copying or
replacing its journal lifecycle. The issuer still owns invoice issuance,
invoice metadata and payments. A document without its real invoice number,
dates or complete posted journal remains unproven; this change does not
fabricate those facts. Historical sources are excluded by an activation cutoff.

## Behavior and boundaries

`customer_ar_source_dev_INSTALL_REVIEW.sql` is a reviewed release proposal for
**CST-DEV only**. It is not applied by application startup or CI. It must be
submitted as a named migration against the verified DEV project. Its actor
configuration starts disabled. It never alters LOGIN, passwords, memberships,
existing vendor Finance policies, or existing grants.

Three deferred constraint triggers observe the existing sales document,
journal header, and journal lines. At the transaction boundary they inspect
the final source. This handles invoice-first, journal-first, later line
completion, and concurrent commits. One transaction-scoped advisory lock
serializes the small DEV projection; later statements use fresh READ COMMITTED
snapshots. Explicit non-READ-COMMITTED source transactions for enabled companies
receive retry SQLSTATE `40001`, rather than silently missing linkage. Unlisted
actors and companies keep their original behavior and isolation. Missing
projection grants warn and leave the source transaction intact.

Evidence must prove all of the following:

- A confirmed/done invoiced document, with number, dates, nonnegative bounded
  paid amount, and matching payment status.
- One normalized invoice number per company, one accounting settings row, and
  one exact same-company `sales_invoice` journal source for that document.
- A posted, nonvoid, nonreversed header in the company's mapped sales journal.
- Balanced final lines and header totals equal to the invoice gross amount,
  with the full debit on that company's active, postable receivables account.
- Every line's account belongs to the same company. An explicit conflicting
  line company is rejected. Legacy nullable line company values are accepted
  only through the same-company header and account relationships.
- No posted same-company/same-journal reversal using either supported owner
  convention: sales document ID or original journal entry ID.

The projection uses absolute `amount_paid`, never an additive payment call.
Gross, paid and remaining amounts refresh idempotently. The existing partial
unique index is targeted with `ON CONFLICT (company_id, invoice_id) WHERE
invoice_id IS NOT NULL`. A previously linked GL identity is never reassigned,
and a row owned by another process is never overwritten.

Only rows with the exact `bizportal:customer-ar-source:v1` marker may become
`STALE` on cancellation, reversal or invalidated evidence. A separate invoker
guard forbids changing any financial or identity field while marking a row
stale. The preview rechecks all source facts independently, including customer
and accounting period, so a privileged or unlisted actor cannot leave stale
data looking verified. Exact/partial/overpayment results remain review
suggestions; no bank mutation or payment is approved or posted.

## Actor permissions and activation

The existing privileged issuer is explicitly mapped to companies 1 and 3 in an
administrator-owned configuration table. SECURITY INVOKER adds no privilege to
that issuer. Its positive tests do not establish tenant RLS.

The two existing Finance login identities receive company-scoped reads and
only source-proven AR insert/update columns. Restrictive policies bind company
1/3 to the real session identity, require `current_user = session_user`, and
ignore caller-supplied company GUCs. The actor configuration is read-only to
these logins. No source invoice, journal or payment write privilege is added.
They may read the existing issuer's projections while their own activation
rows remain disabled.

After release validation, the existing issuer can be enabled for **new** source
events with an administrator statement scoped to this verified DEV database:

```sql
UPDATE public.bizportal_customer_ar_source_actors_dev
SET enabled = true, source_not_before = clock_timestamp()
WHERE role_name = 'postgres' AND company_id IN (1, 3);
```

Do not automatically enable other actors or replay historical invoices. The
Finance actors would require separately owned invoice issuance privileges to
originate source events; this change does not grant them.

## Executable verification

```sh
# Required release evidence: PostgreSQL 17.
bash scripts/tests/customer-ar-run-source-pg17.sh

# An explicitly labeled PG16 compatibility run, if only that image is cached.
CUSTOMER_AR_DISPOSABLE_PG_IMAGE=postgres:16-alpine \
  bash scripts/tests/customer-ar-run-source-pg17.sh

pnpm --dir artifacts/api-server exec vitest run \
  src/__tests__/customer-ar-match-preview.test.ts \
  src/__tests__/customer-ar-dev-only-gate.test.ts \
  src/routes/customer-ar-company-scope-http.test.ts
pnpm --dir artifacts/api-server typecheck
```

The integration harness uses an internal Docker network, no published ports,
synthetic credentials, a temporary PostgreSQL volume, and no live database or
outbound business integration. Its 20 scenario groups execute the exact
release/rollback SQL and the real preview SQL/matcher. They cover deferred
completion, missing/ambiguous/void/reversed evidence, both reversal ID
conventions, cross-company lines/accounts/headers, absolute partial payments,
overpayment rejection, duplicate replays, two concurrent commit orders,
restricted real login sessions, GUC/SET ROLE attacks, stale-row tampering,
accidental grant loss, unlisted issuer invalidation, and rollback preservation.

The synthetic source fixture intentionally gives its company logins source
write grants **only inside the disposable database** to prove the invoker path
under RLS. The release SQL does not grant those source writes. This fixture
tests the projection and its permissions; it does not replace the deployed
issuer's other posting/period/immutability constraints.

Local executor evidence on 2026-11-17: PostgreSQL 16 passed all 20 scenario
groups, Customer Vitest passed 20/20, and canonical API TypeScript passed.
The first PG17 image download on that executor was blocked by a registry
network timeout. The canonical workflow runs PG17; its result must be inspected
before claiming a PG17 PASS. No live release is implied by this file.

For an additional actual DEV PG17 rollback probe, create a uniquely marked
synthetic invoice and source using the existing canonical posting order:
**draft header → balanced same-company lines → posted header**. Force deferred
triggers with `SET CONSTRAINTS ALL IMMEDIATE`, verify one linked AR row and an
unchanged result on a sales metadata replay, then `ROLLBACK`. Do not disable
period or immutability guards. Posted journal updates/deletes are forbidden by
the live owner's guards; use sales metadata for replay and a new reversal
source for reversal validation. Sequences can advance during a rollback probe;
no synthetic financial rows should remain.

## Rollback

Disable the actor rows to stop new automatic projections. The reviewed
`customer_ar_source_dev_ROLLBACK_REVIEW.sql` removes only this change's triggers,
functions, view, configuration, policies and grants. Installation checks that
the new read/write/sequence grants were absent beforehand, so rollback does
not revoke prior permissions. All invoice, journal, AR, bank and payment rows
are retained. The application preview keeps revalidating source proof and does
not depend on the new view existing.
