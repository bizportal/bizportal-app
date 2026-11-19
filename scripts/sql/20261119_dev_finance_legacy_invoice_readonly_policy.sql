-- CST-DEV ONLY. Historical Invoice list read support for existing restricted
-- company Finance logins. No mutation grants and no bypass of restrictive RLS.
-- Existing canonical PO-backed policy remains unchanged.
DO $audit$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='vendor_invoices'
      AND policyname='pr107_company_role_restrictive_all' AND permissive='RESTRICTIVE'
  ) THEN
    RAISE EXCEPTION 'DEV_FINANCE_RESTRICTIVE_GUARD_MISSING';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='vendor_invoices'
      AND policyname='dev_finance_legacy_invoice_reader_20261119'
  ) THEN
    RAISE EXCEPTION 'DEV_FINANCE_LEGACY_READER_ALREADY_EXISTS';
  END IF;
END $audit$;

CREATE POLICY dev_finance_legacy_invoice_reader_20261119
ON public.vendor_invoices AS PERMISSIVE FOR SELECT
TO bizportal_finance_cst_login_dev, bizportal_finance_diva_login_dev
USING (
  mkt_purchase_order_id IS NULL
  AND company_id = NULLIF(current_setting('app.marketplace_company_id', true), '')::integer
  AND (
    (CURRENT_USER = 'bizportal_finance_cst_login_dev' AND company_id = 1)
    OR (CURRENT_USER = 'bizportal_finance_diva_login_dev' AND company_id = 3)
  )
);
