# BizPortal dual-repository parity audit — 2026-11-16

**Target canonical repository:** `bizportal/bizportal-app`.
**Legacy comparison:** `Travelintrips/CST-BIZPORTAL`.
**Comparison refs:** `bizportal/bizportal-app@120fabe64de4d3568ce15fbfe170bf75c8d97323` and `Travelintrips/CST-BIZPORTAL@647f27786d`.
**Scope:** tracked Git blob paths and blob IDs in application/runtime/workflow directories, excluding migration backups, upstream super-app trees, secrets, and other unrelated archived assets. This is an inventory, **not** a claim that changed files are semantically compatible.

## Exact inventory

| Classification | Count |
| --- | ---: |
| Canonical scoped files | 953 |
| Legacy scoped files | 986 |
| Identical at Git blob level | 727 |
| Same path, different contents | 66 |
| Only canonical | 160 |
| Only legacy | 193 |

Selected hotspot breakdown:

| Prefix | Legacy-only | Canonical-only | Changed |
| --- | ---: | ---: | ---: |
| `artifacts/api-server/src/routes/` | 44 | 42 | 23 |
| `artifacts/api-server/src/__tests__/` | 26 | 26 | 5 |
| `artifacts/bizportal/src/` | 26 | 5 | 19 |
| `scripts/` | 14 | 24 | 1 |
| `lib/` | 1 | 26 | 2 |

## Highest priority parity gates (do not blindly overwrite)

1. **HRD / OCR:** legacy-only `hrd-db`, `hrd-document-ocr`, `hrd-employee-status`, and related routes/tests. Canonical also has newer dev read-only / scoped HRD work. Check route registration, role/tenant isolation, service dependencies, and feature flags before any port. Do not enable PROD features.
2. **Payroll / kasbon:** legacy-only payroll production draft/automatic kasbon code and payroll schema CI workflows. Compare against canonical payroll routes and RLS; do not port production writers into DEV by default.
3. **Bank reconciliation / QRIS:** legacy-only recovery, rule-auto-approval and tenant tests; shared reconciliation routes have diverged. Preserve idempotency and no-double-journal guarantees.
4. **Vendor invoice / AP:** legacy-only contract tests for component payments, void/reversal and disbursement safety; ensure canonical service/API parity, retain company isolation and 3-way-match gates.
5. **Build parity:** Node 22.x and root build/start scripts appear aligned, but `package.json` and `pnpm-lock.yaml` differ. The legacy root declares `pdf-parse` and `tesseract.js`; canonical root declares `sharp`. Resolve actual imports and package ownership, never concatenate dependencies without testing.
6. **Deployment:** hPanel screenshots show the existing Hostinger deployment tracking `Travelintrips/CST-BIZPORTAL`, while the canonical repo is selectable. Do not trigger the Hostinger 'Deploy' action on the live website as a parity test.

## Implementation sequence

- First compare each legacy-only **runtime** module with actual imports and routing, mapping to a canonical replacement or marking as a missing feature.
- Port one minimal cohesive feature/test group at a time on a dedicated branch. Preserve canonical DEV authentication, Finance TLS, RLS, and shutdown protections.
- Run `pnpm install --frozen-lockfile`, `pnpm --filter @workspace/api-server test`, `pnpm --filter @workspace/bizportal test`, `pnpm run typecheck`, and `pnpm run build`. Run relevant disposable PostgreSQL/HTTP E2E gates for every changed feature.
- Only after all gates pass: prepare a **DEV-only** shadow candidate, assert environment isolation and actual frontend/backend runtime parity, then rehearse rollback. No new deployment to the live Hostinger website until environment ownership and rollback are verified.

## Audit limitations

- File presence and blob identity **do not** prove functional completeness. Some missing legacy modules could have been deliberately superseded.
- No secrets, environment values, database data, production deployment, branch `main`, or runtime configuration were changed by this audit.
- A PR containing this report is documentation-only; **it is not a cutover approval**.
