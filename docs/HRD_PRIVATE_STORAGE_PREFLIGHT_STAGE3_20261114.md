# HRD Private Storage — Stage 3 metadata-only preflight

Tracking [Issue #40](https://github.com/bizportal/bizportal-app/issues/40).

## Existing PROD source and evidence
The legacy Hostinger repository `Travelintrips/CST-BIZPORTAL` uses private bucket `bizportal-hrd-documents-prod` and has OCR, employee photo, signed storage URL, document approval and audit workflows. Those are **not** brought into the canonical repo by this stage because they can read or mutate sensitive employee documents.

Supabase PROD metadata read (no document access, no writes) found:
- Bucket ID: `bizportal-hrd-documents-prod`, `public=false`
- `file_size_limit=5242880` (5 MiB)
- `allowed_mime_types`: `image/jpeg`, `image/png`, `image/webp`, `application/pdf`
- A search for `storage.objects` policies mentioning this bucket or HRD returned no matches. This is a **limited metadata check**, not proof that every authenticated storage API permission or future signed URL is safe.

## Canonical feature scope
Adds `GET /api/hrd/storage-readiness?companyId=N` only, after the existing active-account, verified Owner/Super Admin and company-scope middleware. The endpoint is OFF unless **both** `HRD_CANONICAL_READONLY_ENABLED=true` and `HRD_CANONICAL_STORAGE_PREFLIGHT_ENABLED=true` in production.

The server uses the existing backend-only `HRD_PROD_STORAGE_SERVICE_KEY` and a pinned `HRD_PROD_SUPABASE_URL`. It sends only a GET to the fixed Supabase Storage bucket metadata endpoint. It checks the exact bucket ID, private flag, finite positive <=5 MiB size limit and exact MIME allowlist. No path/list, signed-URL, OCR, upload, object read, deletion, database write, or financial action is registered. The key, upstream error, URL and raw bucket response are never returned to the client.

## Release gates
- API and unit tests: disabled flag, PROD-only, tenant/Owner checks, redacted 503, pinned URL, missing secret, invalid bucket metadata, and non-GET route rejection.
- CI Typecheck/build/runtime smoke and code/security review must PASS before merge consideration.
- Do not enable any flag in Hostinger. No PROD deployment, database migration, storage upload or canary run.
- Full OCR/document lifecycle parity, private document access and employee status writes remain blocked by Issue #40.
