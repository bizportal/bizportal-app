# HRD OCR Stage 5 — synthetic-only validation parity

Tracking [Issue #40](https://github.com/bizportal/bizportal-app/issues/40).

## Scope and provenance
This stage copies **pure validation functions** without reimplementing their rules from the existing PROD source at
`Travelintrips/CST-BIZPORTAL/artifacts/api-server/src/routes/hrd-document-ocr.ts`:
`validDocType`, `validMime`, `normalizeExtraction`, `validateReviewFields`,
`fieldsAllowedForDocument`, `ocrProviderFailureCode`, and `documentMimeMatches`.
All functions live in `hrd-ocr-validation.ts` with no external imports or provider calls.

The test file `hrd-ocr-validation.test.ts` uses **invented synthetic values only**, including obviously fake 16-digit numeric placeholders, synthetic MIME header bytes and fake provider errors. No employee document bytes, extracted identity data, live Storage API keys or OpenAI requests are loaded.

## What this protects
- 8 legacy document types and the 4 recognized MIME types
- NIK/KK format filtering without inventing missing values
- date/length normalization, bounded confidence and warning strings
- allowlist of reviewable fields for each document type
- rejection of unknown review fields, overlong values and invalid NIK/KK
- MIME magic header checks
- public-safe provider error codes
- no network or filesystem side effects

## Deliberate limits
- **No new API endpoints, feature flags, database permissions or UI.**
- Does not port or exercise real OCR extraction, local Tesseract processing, image upscale, OpenAI fallback, upload, signed preview, document verification, employee status change or salary deductions.
- Unit tests are *not* proof of full OCR behavioral parity. Test those integrations in a controlled isolated environment with synthetic documents and zero access to live employee files.
- Hostinger PROD remains on existing source and migration stays blocked by Issue #40.

Run `pnpm --filter @workspace/api-server exec vitest run src/routes/hrd-ocr-validation.test.ts` in the repository workspace. CI/review must PASS before any merge consideration.
