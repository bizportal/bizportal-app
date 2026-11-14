-- STAGED REVIEW ONLY. NO DDL EXECUTED FROM THIS FILE.
-- Do NOT reapply the two already-installed PR50 Finance migrations.
-- CST-DEV currently has 18 finance policies across 11 tables.
--
-- In selected existing INSERT WITH CHECK expressions, unqualified
-- "company_id" inside a referenced-table subquery binds to the INNER table.
-- e.g., "ap.company_id = company_id" resolves to ap.company_id=ap.company_id.
-- This is not a referential company guard, even if other SELECT RLS policies
-- currently hide foreign records. Existing FKs confirm IDs, not company equality.
-- A staged correction must explicitly refer to the OUTER target table.
--
-- The existing canonical AP service inserts 'ap_preparation' and transitions
-- via 'finance_review' before 'waiting_payment'. The current AP INSERT policy
-- does not require this initial status. Future ALTER POLICY should preserve
-- the existing GUC and three-way-match rules, while adding an initial status
-- constraint and qualified company comparisons.
--
-- CANDIDATE ONLY (commented out, NOT an applied migration):
--
-- ALTER POLICY pr50_finance_dev_ap_insert ON public.mkt_ap_preparations
--   WITH CHECK (
--     company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer
--     AND status = 'ap_preparation'::public.mkt_ap_preparation_status
--     AND EXISTS (SELECT 1 FROM public.vendor_invoices vi
--       WHERE vi.id = mkt_ap_preparations.vendor_invoice_id
--         AND vi.company_id = mkt_ap_preparations.company_id
--         AND vi.mkt_purchase_order_id IS NOT NULL
--         AND vi.three_way_match_status='passed'));
--
-- ALTER POLICY pr50_finance_dev_payment_insert ON public.payment_requests
--   WITH CHECK (
--     company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer
--     AND source_type='marketplace_ap' AND status='draft'
--     AND mkt_ap_preparation_id IS NOT NULL AND journal_entry_id IS NULL
--     AND EXISTS (SELECT 1 FROM public.mkt_ap_preparations ap
--       WHERE ap.id = payment_requests.mkt_ap_preparation_id
--         AND ap.company_id = payment_requests.company_id));
--
-- ALTER POLICY pr50_finance_dev_handoff_insert ON public.mkt_accounting_handoffs
--   WITH CHECK (
--     company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer
--     AND accounting_status='draft_not_posted'
--     AND EXISTS (SELECT 1 FROM public.mkt_ap_preparations ap
--       WHERE ap.id = mkt_accounting_handoffs.ap_preparation_id
--         AND ap.company_id = mkt_accounting_handoffs.company_id)
--     AND EXISTS (SELECT 1 FROM public.payment_requests pr
--       WHERE pr.id = mkt_accounting_handoffs.payment_request_id
--         AND pr.company_id = mkt_accounting_handoffs.company_id
--         AND pr.source_type='marketplace_ap' AND pr.status='draft'));
--
-- PRECONDITIONS:
-- - Review whether the platform-specific schema/type names match CST-DEV.
-- - Validate same-company parent references, permissions, API transaction role,
--   existing 3-way match and idempotency; preserve all passed business behavior.
-- - Verify real signed Super Admin and dedicated Finance DB login, not a GUC
--   derived from user input or arbitrary SQL. A GUC is not identity proof.
-- - Check the existing active Hostinger deployment, prepare and test rollback.
-- - Never apply to PROD or enable payment/journal postings in this change.
--
-- READ-ONLY INFORMATIONAL AUDIT (safe by itself):
SELECT tablename,policyname,cmd,with_check
FROM pg_policies
WHERE schemaname='public'
  AND policyname IN (
    'pr50_finance_dev_ap_insert',
    'pr50_finance_dev_payment_insert',
    'pr50_finance_dev_handoff_insert')
ORDER BY tablename,policyname;
