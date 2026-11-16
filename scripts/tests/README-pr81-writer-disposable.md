# PR81 Finance Writer - disposable PostgreSQL gate

Run by .github/workflows/pr81-finance-writer-disposable.yml on an isolated
GitHub Actions runner. This gate does not connect to CST-DEV or PROD.

The PostgreSQL 16 container has --network none, no published ports, no
shared mounts, and a bounded tmpfs data directory. It requires no secrets.
The SQL rejects any database name other than cst_pr81_writer_ci and any
non-loopback TCP server address, creates
its own disposable role and simplified AP/Finance tables under BEGIN, and
ends with ROLLBACK. Its final assertion verifies both tables and role
were removed. The container is then destroyed.

Assertions cover tenant-scoped RLS and reciprocal company visibility; AP
ap_preparation -> finance_review -> waiting_payment; a draft-only Payment
Request and an Accounting Handoff marked draft_not_posted; unique-key replay
deduplication; denial of paid, cross-company AP insert and GL insert rights.

Evidence limitation: This is a PostgreSQL constraint/lifecycle model,
not an invocation of the full BizPortal production service or CST-DEV API.
Canonical service-level mocked contract tests and prior CST-DEV rollback-only
tests are separate evidence. Do not claim a real HTTP Writer E2E or activate
Finance Writer/Accounting Handoff based solely on this gate.

No PR81 runtime flags, Nginx, App credentials, hPanel, database migrations,
accounting entries, payment, PROD configuration or Docker runtime services on
the active VPS are modified by the GitHub Actions workflow.
