# PR81 canonical Finance Writer service -> PostgreSQL 16 disposable

This is a **real service-to-PostgreSQL integration test**, not a mocked
service-unit test. It bundles the unmodified source functions:
reviewApPreparation, markApPreparationWaitingPayment,
createApPreparation, getApPreparation, and
createMarketplaceAccountingHandoff. The test invokes them using actual
Drizzle query execution and nested PostgreSQL transactions.

The bundled service's database import is **test-injected** with a fresh
PG pool whose connection URL must be exactly the Docker-only host pr81pg,
database cst_pr81_writer_ci, username postgres, and password synthetic-only.
It does not import the canonical Finance Supabase connection helper,
which correctly refuses non-CST-DEV hosts.

The disposable schema's columns are derived from **real Drizzle table
definitions**. The test mirrors the narrowly scoped CST-DEV column-level
UPDATE privileges for Vendor Invoice (status/matching/updated_at) and AP
(status/review/handoff/updated_at), and uses only three required sequence
USAGE grants. The canonical Invoice FOR UPDATE / AP transitions PASS with
these grants, **without whole-table UPDATE**. Do not widen CST-DEV grants.
The test adds reduced, synthetic tenant RLS policies,
unique indexes, draft-only constraints and a restricted role; it
intentionally does NOT replicate the full production foreign-key graph
or all 18 CST-DEV Finance policies. Thus it is **not** a live CST-DEV
Writer E2E, signed browser HTTP test or production schema attestation.

The service's activity-log and notification publishers are replaced
with test-only fail-closed stubs; post-commit callbacks are not published.
All schema objects, temporary role, test rows, AP transition, Payment
Request and Accounting Handoff are created inside an **outer PostgreSQL
transaction**. Canonical service nested transactions use savepoints,
then an intentional outer ROLLBACK is verified using to_regclass and
pg_roles.

The harness asserts:
- restricted role, tenant-bound RLS, and no GL INSERT privilege;
- real canonical AP creation and duplicate creation returning the same ID;
- real AP finance-review and waiting-payment transitions, with replay;
- real draft-only Payment Request and draft_not_posted Accounting Handoff;
- replay handoff returns the same Payment Request/Handoff IDs;
- Diva cannot read CST AP/Payment/Handoff through the same RLS connection;
- no extra row from replay; no tables, role or data after outer ROLLBACK.

CI uses two disposable containers on an **internal Docker network**, no
published ports, host DB volumes or real secrets. Node runs unprivileged
with a read-only bind-mounted source and read-only root filesystem.
A trap removes both containers and the network.

This does NOT call Finance HTTP endpoints, activate Finance Writer,
run against Supabase or PROD, send notifications, make payments, or
post journals. Production service and shared preview remain unchanged.
