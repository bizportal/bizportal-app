# DEV Purchase PDF parity — main baseline

Source: existing tested `develop` Purchase PDF renderer and tests. This branch is based on the Hostinger-connected official `bizportal/bizportal-app` `main` commit `120fabe6`, and does not merge `develop` wholesale.

* DEV-only endpoint: `GET /api/purchase/documents/:id/pdf` (authenticated Admin, strictly company-scoped purchase document).
* Default OFF: `BIZPORTAL_DOCUMENT_TEMPLATES_ENABLED_DEV` must be `true`, and `APP_ENV` must be development. Existing HTML fallback remains untouched.
* Produces an A4 binary PDF from canonical read-only purchase tables and same-origin CST logo. No financial posting, invoice issuance, payment, bank mutation, or new purchase order.
* No automatic Hostinger deployment or config changes are part of this PR. Keep production and all finance flags unchanged.
* Unit tests cover actual PDF bytes, document header, company mismatch, missing auth, flag OFF, and logo/tax rendering. Full API regression and CI must pass prior to DEV activation.
