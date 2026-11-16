# PR #81 — Finance Reader preview-only Vendor Invoice UI

The private DEV Finance GET-only preview deliberately exposes only:

- signed Super Admin company selection (POST);
- canonical Vendor Invoice read by numeric ID (GET);
- canonical AP Preparation read by numeric ID (GET).

It does **not** expose the legacy `/api/purchase-workflow/vendor-invoices` list, invoice creation, email import, bank disbursement, or posting endpoints. Those remain unchanged in the main application.

## Explicit frontend-only opt-in

Compile the **isolated private preview only** with:

```text
VITE_BIZPORTAL_FINANCE_READONLY_PREVIEW_DEV=true
VITE_BIZPORTAL_FINANCE_GLOBAL_SCOPE_UI_DEV=true
VITE_BIZPORTAL_DEV_PASSWORD_ONLY=true
```

The new frontend flag is **OFF by default**. In preview mode, the existing Vendor Invoice page displays the signed company-selection card and a plain link to the existing `/finance-readonly-check.html` helper, instead of attempting the blocked legacy list query. Old invoice/write controls are hidden, and React Query requests for legacy list/repair endpoints are disabled. No API, authentication, database role, RLS, or writer permissions are changed.

When the flag is not enabled, the **full existing Vendor Invoice UI and fetch behavior are preserved**, including in PROD. Never turn on this frontend flag for a full writer-enabled BizPortal deployment.

## Validation and limitations

The targeted UI test proves no legacy invoice fetch and no create/payment buttons in preview mode; the existing PPh list test proves unchanged behavior when the flag is off. Build, GitHub gate, and private preview release require separate verification.

This is a **display-only** correction to a misleading error caused by the intentional Nginx allowlist. It does not certify a signed browser session, positive company-scoped Finance reads, data provenance, or payment/Accounting E2E. Only a legitimate company-linked PO → Goods Receipt → Vendor Invoice can support the positive Finance data path. Keep canonical Finance Writer/GL OFF and PROD untouched.
