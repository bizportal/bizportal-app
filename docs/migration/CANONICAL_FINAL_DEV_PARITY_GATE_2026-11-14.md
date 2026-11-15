# BizPortal canonical DEV — final integrated candidate review

Date: 14 November 2026. **Decision: NO-GO for live Hostinger DEV cutover or PROD.**

## Provenance

- Official target: `bizportal/bizportal-app`, branch `test/canonical-final-dev-parity-20261114`.
- Built from approved **source reviews**, not from the deployment mirror: integrated the cumulative PR #44 ancestry (OTP, templates, Customer AR, geofence, Gmail previews/review, Purchase admin-only parity, rollback readiness), the **non-overlapping** Purchase company-join patch PR #28 and canonical Vendor AP code PR #5.
- PR #5's route conflict was resolved by retaining **all** previously imported routes plus Vendor/AP's existing default-off feature gates. Do not separately merge this integration candidate and its ancestor/stacked source PRs.
- Current Hostinger DEV remains on `Travelintrips/CST-BIZPORTAL` SHA `2705d4c720fb7aa5d34f72ba60ef55be4dd91d7d` under systemd `cst-bizportal-gmail-dev.service`. Nginx root remains `/opt/cst-bizportal-gmail-dev/dist/public`.

## Source parity evidence, narrowed to runtime and tests

Compared `git ls-tree` Git blob IDs within `artifacts/`, `lib/`, `scripts/`, and `.github/workflows/` between the active DEV SHA and this candidate, as checked before this report commit.

- 647 same-path identical blobs, 88 same-path changed blobs, 75 active-only paths, 112 canonical-only paths.
- Among 75 active-only paths, 69 are mockup-sandbox sources. Other missing files include a legacy `dev-first-promotion.yml` workflow, its verification script, a GPT02 approval bridge test, and local Replit metadata. **The old promotion workflow must not be copied automatically** because that could rewire deployment.
- **All active route files** have a canonical counterpart, but semantic behavior still differs in Accounting, bank reconciliation, Gmail, Purchase, auth and realtime.
- Filename-keyword module audit, not an E2E assertion:

| Module | Active paths | Canonical paths | Missing active paths | Same-name changed |
| --- | ---: | ---: | ---: | ---: |
| Payroll/Kasbon | 3 | 3 | 0 | 0 |
| HRD/OCR | 4 | 5 | 0 | 0 |
| Accounting/GL | 75 | 78 | 0 | 4 |
| QRIS/Bank | 42 | 63 | 0 | 19 |
| Vendor/AP | 54 | 77 | 0 | 3 |
| Gmail-related | 19 | 27 | 0 | 6 |

The counts overlap across modules. They do not establish production functionality or RLS safety.

## Regression-driven selective fixes

Existing active-only regression tests were copied into the canonical candidate. They initially exposed seven failures across DEV OTP Gmail, UI parity and failed-OCR hash reuse. The candidate was corrected **instead of deleting the tests**; the same fifteen legacy tests then passed.

- Restored the allowlisted DEV email login choice and its original frontend test, without rewriting Supabase Auth.
- Restored Gmail/OCR provider 429 backpressure and safe deferred extraction, plus original tests.
- Preserved manual-only Gmail source sync and explicit `autoSyncEnabled=false` status; removed the background organizer timer from the candidate.
- Preserved Gmail reject/restore UI, supporting-document badges and source-navigation link. The review UI requires explicit build-time opt-in; server-side `BIZPORTAL_GMAIL_REVIEW_ENABLED_DEV` remains OFF by default and independently enforces verified same-company scope.
- Preserved the active DEV company/mailbox warnings and the blocking of Sync/Connect if no dedicated DEV Gmail address is configured.
- Restored failed OCR content-hash reuse after Gmail attachment IDs rotate, and a rejected-candidate import conflict 409. Existing canonical invoice duplicate handling was otherwise preserved.
- Integrated existing Purchase allocation-to-bank-mutation company equality. The admin-only DEV role guard remains in place.
- Imported canonical Vendor/AP source from PR #5 with feature flags OFF by default; no AP posting, journal or payment execution performed.

## Testing / release gates

Local focused purchase, Gmail review, accounting and QRIS suite had **99/99 PASS** on the integrated candidate before the final Gmail/UI parity adjustments. Subsequent targeted Gmail source tests, Gmail rate-limit, frontend login and active-only regression tests passed. Final full-suite CI and build need to be cited for the **final exact SHA**; earlier CI runs for parent PRs are not sufficient.

**Not established / mandatory blockers:**

1. Live DEV authenticated OTP Admin session + verified company scope through real dedicated non-production role; mock HTTP PASS is not real login.
2. Supabase CST-DEV active BizPortal uses a privileged `postgres.<CST-DEV-ref>` database connection, not the restricted `bizportal_dev_runtime` role. Do not claim RLS prevents cross-company reads from the privileged backend. Test company authorization under a least-privileged isolated DB role before cutover.
3. Authorized browser A4 PDF print test with official CST letterhead and zero issued financial documents.
4. Full Accounting/QRIS/Payroll/HRD/AP read-only behavioral parity with active DEV; detailed integration and idempotency checks still needed.
5. The old workflow `dev-first-promotion.yml` and its verifier are deliberately **not copied** until deployment safety and GitHub branch protection are verified.
6. Full isolated deployment/rollback rehearsal restoring actual shadow serving source and API behavior; the read-only source/Nginx/service preflight PASS does not establish rollback PASS.

No PROD, live Hostinger service, source remote, Nginx, database schema, bank transaction, payroll or Gmail candidate row was changed during this work.
