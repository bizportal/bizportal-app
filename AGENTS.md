# BizPortal DEV working guidance

Read the [CST Global Development SOP](https://github.com/Travelintrips/Core-AI-Foundation/blob/develop/CST-GLOBAL-DEVELOPMENT-SOP.md) before classifying a job. Record its version and source commit alongside the BizPortal commit and evidence. Use `bizportal/bizportal-app` as the source repository.

Reuse existing BizPortal flows and valid verification evidence. For Finance, Accounting, HRD and Payroll, use authorized DEV sessions and company-scoped QA data. Verify the actual role and company through the application's normal entry point. Tests involving invoices, bank reconciliation, journals, payments, or outbound notifications must use DEV fixtures and isolated destinations.

Use the existing Release Gate for code changes and record runtime DEV evidence separately from CI. Production changes require explicit owner approval.
