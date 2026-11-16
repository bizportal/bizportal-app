# DEV Freight A4 preview parity on Hostinger-connected main

This is a small source-only port of the previously tested `develop` freight template changes onto the official `main` baseline. It does not merge `develop`, change finance writers, or deploy to Hostinger.

* `GET /api/settings/documents/{delivery_note,manifest,packing_list}/transaction-preview/:id` renders A4 from the **existing** Marketplace shipment/PO lines, with SQL tenant company isolation and authenticated Admin. It does not issue a legal document, book freight, send notifications, charge customers, reconcile a bank entry, or post GL.
* Retains existing template styles, company logo and fallback views. Missing or cross-company shipment returns a refusal; no generic empty document.
* Existing `BIZPORTAL_DOCUMENT_TEMPLATES_ENABLED_DEV` flag is OFF by default. Do not activate on PROD.
* 32/32 focused document-template tests PASS. Full API regression must pass and CI must complete before any DEV cutover. The Purchase PDF binary lives in separate Draft PR #96 to avoid accidental feature coupling.
