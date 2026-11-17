# Actual DEV vendor acceptance

This is a separately reviewed acceptance harness for CST-DEV
`xssrfshdrtdfupgqwfdw`, using the private Finance preview at
`https://finance-pr81.72.61.210.205.sslip.io`. Building it does not run it.

## Boundaries

The harness creates two labelled synthetic supplier/RFQ/quote/PO/Shipment/GR
chains, one for company 1 with a 48-hex Portal-compatible token and one for
company 3 with a 64-hex canonical token. It uploads an actual synthetic
PDF through the vendor capability HTTPS route, repeats the upload, submits the
invoice and repeats submission. It then calls the unchanged canonical AP
services through the real GCP-resolved company login sessions, ending at a
PaymentRequest draft and an accounting handoff marked `draft_not_posted`.

It checks cross-company GUC spoofing, actual role/RLS readiness, durable audit,
private Storage bytes, zero notifications for its POs, and replay identity.
It preserves existing PO 14 and requires its invoice/AP/handoff counts to start
and end at zero. No authenticated admin cookie is created or fabricated.
**This proves vendor capability HTTP plus company-session backend behavior.
The genuine owner/admin signed HTTP flow remains a separate acceptance gate.**

The prerequisite Finance runtime must already contain the reviewed suppression
code and have the explicit DEV notification, writer, company role, bundle,
accounting handoff, and Storage flags enabled. The harness only reads these
settings; it never changes systemd units, live credentials, roles, grants,
policies, or functions.

The preflight pins the reviewed PR126 function body hash
`f74ae1995c4ec52505b06624c6010950`. Its only change from the previous reviewed
body is accepting exactly 48 or 64 hex characters; session identity, parent
lock order, ownership, privileges, and the post-lock expiry check remain intact.

## Build and read-only check

From the reviewed repository on `srv1792369`, with frozen pnpm dependencies:

```bash
node scripts/qa/build-dev-vendor-acceptance.cjs
node artifacts/api-server/.dev-vendor-acceptance.mjs --check
```

The check resolves company credentials through the existing application GCP
resolver and the preview service's systemd credential mount. The temporary
administrative connection comes only from the already verified live DEV issuer
service (`cst-bizportal-gmail-dev.service`), read in process memory. Its host,
project and postgres identity are pinned, and TLS verification is mandatory.
The only temporary credential-related file is a **public** Supabase root CA;
database passwords, service keys and vendor capabilities are never persisted.

## Reviewed execution

Only after the check succeeds and the source/cleanup procedure is reviewed:

```bash
BIZPORTAL_VENDOR_ACCEPTANCE_EXECUTE_DEV=true \
  node artifacts/api-server/.dev-vendor-acceptance.mjs --execute
```

The explicit flag prevents a build/test job from accidentally running against
shared DEV. No command changes PROD or approves/posts a payment or GL entry.

## Cleanup and reporting

Cleanup runs after success and normal failures. It reads only this run's exact
labelled parent IDs, checks that financial rows remain draft/unpaid/unposted,
deletes their private upload objects using the existing Storage method, and
deletes synthetic rows in foreign-key order. Audit history is retained; the
existing `ON DELETE SET NULL` reference behavior detaches deleted QA parents.

If another actor changes a QA invoice/payment to an unexpected state, cleanup
refuses to erase it. The log contains the run marker and synthetic parent IDs
for a reviewed recovery; it contains no token or credential. An interruption
before cleanup likewise requires recovery by the recorded exact marker/IDs.
Never run a broad prefix delete or delete another run's rows.

The final PASS is emitted only after cleanup and the protected PO check. A
failed preflight writes no business rows. A failed operation is reported with
a redacted stage/code after cleanup, and is not converted into a PASS.
