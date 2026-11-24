-- CST-DEV ONLY. DO NOT APPLY TO PROD.
-- Reviewed source of migration:
-- sales_order_customer_company_prospective_guard_dev_20261121
-- Applied to Supabase CST-DEV (xssrfshdrtdfupgqwfdw) on 21 November 2026.
-- This source is for audit/recovery, not Hostinger startup auto-migrations.
--
-- Protect future Sales Orders without blocking harmless updates to historical
-- documents. At application of this migration, 30 orders existed, of which
-- 29 had NULL customer_id, and the remaining demo had NULL company_id.
-- Do not invent or backfill legacy customer/company associations.
--
-- In particular DO NOT include UPDATE OF status or invoice_status here:
-- that would block legacy transitions unrelated to customer identity.

BEGIN;

CREATE OR REPLACE FUNCTION public.sales_order_customer_company_guard_dev()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.kind::text <> 'order' THEN
    RETURN NEW;
  END IF;

  IF NEW.customer_id IS NULL OR NEW.company_id IS NULL THEN
    RAISE EXCEPTION 'Sales Order requires registered customer_id and company_id'
      USING ERRCODE='23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.customers c
    WHERE c.id = NEW.customer_id
      AND c.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'Sales Order customer/company mismatch'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER sales_order_customer_company_guard_dev_trigger
BEFORE INSERT OR UPDATE OF kind, customer_id, company_id
ON public.sales_documents
FOR EACH ROW
EXECUTE FUNCTION public.sales_order_customer_company_guard_dev();

COMMIT;

-- Read-only verification:
-- SELECT pg_get_triggerdef(oid) FROM pg_trigger
-- WHERE tgrelid='public.sales_documents'::regclass
-- AND tgname='sales_order_customer_company_guard_dev_trigger';
--
-- This guard does not authorize Sales confirmation, Invoice/AR/GL posting, or
-- unlocking a financial writer. Those remain signed-OTP gated and default OFF.
