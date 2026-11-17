# PR #95: disposable PostgreSQL payment-lock rehearsal (2026-11-17)

**Evidence class:** isolation test of the *proposed concurrency invariant*, **not** E2E of the archived Bank Disbursement HTTP writer.

## Isolation / environment

- Remote DEV VPS: `srv1792369`.
- Temporary PostgreSQL: existing local `postgres:16-alpine` image, container `bizportal-pr95-disposable-20261117`.
- Docker flags: `--network none`, `--memory 256m`, `--cpus 0.5`, ephemeral `--tmpfs /var/lib/postgresql/data`, `--rm`. No DB URL, network socket, shared volume, CST-DEV/PROD access, or active application process attached.
- Fixture tables and function existed only in ephemeral `pr95` schema. After test, stopped container; subsequent inspection returned `NOT_PRESENT`.

## Synthetic invariant exercised

Defined a `pr95.pay(company,invoice,idempotency_key,amount)` PostgreSQL function:
1. `SELECT ... WHERE id=invoice AND company_id=company FOR UPDATE` before balance check.
2. Look up existing key under `UNIQUE(company_id,key)`; replay returns `REPLAY`.
3. Reject amount exceeding invoice total; otherwise update paid balance and insert exactly one payment row within the function transaction.
4. Fail-closed when company ownership does not match.

Verified cases:

| Scenario | Result |
| --- | --- |
| Initial payment 60 on invoice total 100 | `CREATED` |
| Exact key replay 60 | `REPLAY` (no second row) |
| Additional payment 50 after paid 60 | `OVERPAY` |
| Company 1 attempting to pay company 2 invoice | `FORBIDDEN` |
| Two concurrent clients each paying 80 on invoice total 100 | One `CREATED`, other `OVERPAY`; final paid `80`, payment rows `1` |
| Deliberate exception after payment within PL/pgSQL exception subtransaction | Invoice paid and row count unchanged (`PASS` rollback) |

No real invoice numbers, credentials or journal data were read or changed. The simulated ledger has no production accounting line posting and proves only the *database-level lock-and-idempotency technique*.

## Limits and cutover gates

- This did **not** execute the archived sole-executor `bankDisbursements.ts`, its `postEntryWithClient`, WHT handlers, reverse/void services, or actual API authentication. It does **not** authorize merge/deployment or justify marking Bank Disbursement E2E PASS.
- The archived writer has an existing transaction and a conditional update for linked vendor invoices (recorded in the previous gate document); preserve them. A lock and durable idempotency key must be verified in the canonical **single writer** before any cutover.
- Remaining real-writer tests on isolated PG: exact replay with same HTTP request, concurrent requests, journal/entry lines balanced, WHT and tax account, company scope, void/reversal, failure rollback, and no duplicate bank debit.
- PR remains Draft; DEV runtime, Hostinger, main, and PROD untouched.
