# BizPortal canonical DEV — existing behavior parity blockers (14 November 2026)

> Source comparison and decision record. **Not a declaration of complete runtime parity**. This document must not be used as a deployment authorization.

## Scope and source fingerprints

Compared read-only on VPS `srv1792369`:

| Role | Repository | Checkout | SHA |
| --- | --- | --- | --- |
| Nginx-served DEV runtime | `Travelintrips/CST-BIZPORTAL` | `/opt/cst-bizportal-gmail-dev` | `2705d4c720fb7aa5d34f72ba60ef55be4dd91d7d` |
| Canonical isolated integration candidate | `bizportal/bizportal-app` | `/opt/bizportal-canonical-dev-candidate-20261114` | `4a7ee06f2f923b47a8a1e898f2556704e736d11f` |

Git blob SHA comparison restricted to `artifacts/`, `lib/`, `scripts/` and `.github/workflows/`: 638 matching paths with identical blobs, 86 same-path changed blobs, 86 paths available only on active DEV, 54 only on canonical candidate. This is **file parity evidence**, not a semantic regression count.

The canonical candidate at PR #19 already passed 46/46 targeted tests and GitHub Release Gate; neither result proves that the active runtime behavior is reproduced.

## Verified route-contract discrepancies

| Area | Active DEV | Candidate PR #19 | Safe action |
| --- | --- | --- | --- |
| Driver geofence dashboard | `GET /drivers/geofence-alerts` authenticated `[]`; `POST /drivers/geofence-alerts/:id/resolve` authenticated 404/no update | Route absent | **Ported in stacked canonical PR #21** with existing behavior and 5 HTTP tests; no geofence writer built |
| Gmail provisional Match INV preview | `GET /recon-classification/invoice-sources/gmail/match-proposals` read-only with company scope | Route absent | Keep blocked until source/DB/auth and no-posting semantics are checked |
| Gmail candidate review | `POST /recon-classification/invoice-sources/gmail/candidates/:id/review` rejects/restores an existing candidate | Route absent | **Do not blindly port**: it modifies candidate status; requires idempotence/audit/tenant E2E |
| Purchase Workflow | Route names match; role eligibility and final mutation-state handling differ | Existing implementation differs | Compare authorized role matrix and payment lifecycle before changing either side |
| Bank Reconciliation | Canonical contains additional QRIS and vendor-batch endpoints | More endpoints, substantial internal differences | Verify posted-payment safety and QRIS scenarios independently; no bulk copy |
| Gmail background organizer | Active DEV code documents manual-only Gmail scanning | Candidate retains a timer that runs only when `!isDevelopmentEnvironment()` | Verify real `APP_ENV`/`NODE_ENV`, scheduler status and mailbox isolation; do not enable in isolated tests |
| Admin realtime | Same route signatures, SSE/flush behavior differs | Streaming implementation differs | Check real EventSource reconnect and auth; do not replace a working subscriber without browser evidence |
| Accounting | Canonical has an extra account-creation API | Existing accounting code differs | Run non-posting route parity and journal safety checks separately |

### Why missing routes are not copied wholesale

A missing read-only route can be brought across with preserved authentication and tests; a missing mutation route or source containing new scheduling requires stricter evidence. In particular, importing the Gmail candidate-review endpoint or a background timer as an unreviewed chunk could affect financially relevant records or mail processing even without changing Nginx.

## Current release disposition

- Canonical PR #19: integration CI PASS, **NO-GO for Hostinger source switch**.
- Canonical PR #21: targeted driver-geofence compatibility migration, initial CI PASS; **not independently merged or deployed**.
- All new DEV OTP/document/Customer AR flags remain OFF.
- No authenticated Hostinger DEV login OTP, Customer AR data E2E or actual browser PDF printing has been demonstrated in this comparison.
- Do **not** modify the active `Travelintrips` worktree, Nginx, secrets, bank posting, GCP mail settings or PROD as part of parity inspection.

## Required gate before cutover

1. Review each active-only route and changed critical module against canonical source, classify `must preserve` / `intentional fix` / `retired contract` and test accordingly.
2. Execute signed, company-scoped DEV authentication on an authorized isolated runtime and inspect runtime flags and dedicated DEV database/mail permissions without exposing secrets.
3. Exercise existing Accounting, QRIS, bank reconciliation, purchase workflow and Gmail paths without any real posting, email send, settlement or unapproved background worker.
4. Browser-test PDF A4 preview and account/session boundaries; compare with active behavior.
5. Confirm full CI on final SHA, isolated deployment on non-public localhost, rollback, then separately authorize switching Hostinger DEV remote and release source.
