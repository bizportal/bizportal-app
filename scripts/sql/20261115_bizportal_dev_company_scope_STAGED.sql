-- STAGED REVIEW ONLY: never apply as part of PR or CI.
-- CST-DEV current policies for bizportal_dev_runtime on customers and
-- sales_documents allow rows for ANY active company, not the selected tenant.
--
-- PRECONDITIONS before real deployment:
-- 1. Verify actual Hostinger runtime identity and session middleware.
-- 2. Server must derive the company from a verified signed session, then set
--    app.bizportal_company_id with SET LOCAL in the SAME read transaction.
--    Do not trust a client-provided company_id parameter.
-- 3. Preserve legitimate global Super Admin/Owner behavior via explicit
--    per-company queries or a separately audited global read capability.
--    Do not add a client-settable role-bypass custom setting.
-- 4. Verify real nonprivileged role, missing scope, cross-tenant denial,
--    active DEV behavior, payroll/HRD/accounting/QRIS compatibility & rollback.
--
-- FUTURE CANDIDATE ONLY; commented so cannot alter policies accidentally:
-- CREATE POLICY bizportal_dev_customer_tenant_guard
--   ON public.customers AS RESTRICTIVE FOR SELECT
--   TO bizportal_dev_runtime
--   USING (company_id = NULLIF(
--     current_setting('app.bizportal_company_id',true),'')::integer);
--
-- CREATE POLICY bizportal_dev_sales_tenant_guard
--   ON public.sales_documents AS RESTRICTIVE FOR SELECT
--   TO bizportal_dev_runtime
--   USING (company_id = NULLIF(
--     current_setting('app.bizportal_company_id',true),'')::integer);
--
-- ROLLBACK ONLY if explicitly authorized:
-- DROP POLICY IF EXISTS bizportal_dev_customer_tenant_guard ON public.customers;
-- DROP POLICY IF EXISTS bizportal_dev_sales_tenant_guard ON public.sales_documents;
--
-- WARNING: with no trusted scope these policies intentionally yield zero rows.
-- The current bizportal_dev_runtime is NOLOGIN and could not be SET ROLE via
-- the available Supabase audit connector. CI proves synthetic RLS only.
SELECT tablename,policyname,permissive,cmd,roles,qual
FROM pg_policies
WHERE schemaname='public' AND tablename IN ('customers','sales_documents')
ORDER BY tablename,policyname;
