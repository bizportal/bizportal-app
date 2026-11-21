-- CST-DEV review-only migration. Do not run in PROD or auto-apply with drizzle-kit push.
-- Prevent future Sales Order rows without registered customers, including non-UI writers.
-- NOT VALID leaves historical Sales Orders untouched for separately approved remediation.
-- Database name and role must be verified by the authorized DEV DBA before executing.

BEGIN;

ALTER TABLE public.sales_documents
  ADD CONSTRAINT sales_order_customer_required
  CHECK (kind <> 'order' OR (customer_id IS NOT NULL AND customer_id > 0))
  NOT VALID;

-- Customer ID must also belong to the SAME company. The existing foreign key
-- proves existence only; it does not prove tenant ownership.
CREATE OR REPLACE FUNCTION public.sales_order_customer_company_guard_dev()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linked_company_id integer;
BEGIN
  IF NEW.kind <> 'order' THEN
    RETURN NEW;
  END IF;

  IF NEW.customer_id IS NULL OR NEW.company_id IS NULL THEN
    RAISE EXCEPTION 'Sales Order requires customer_id and company_id'
      USING ERRCODE = '23514';
  END IF;

  SELECT company_id INTO linked_company_id
  FROM public.customers
  WHERE id = NEW.customer_id;

  IF NOT FOUND OR linked_company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'Sales Order customer does not belong to its company'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER sales_order_customer_company_guard_dev_trigger
BEFORE INSERT OR UPDATE OF kind, customer_id, company_id
ON public.sales_documents
FOR EACH ROW EXECUTE FUNCTION public.sales_order_customer_company_guard_dev();

COMMIT;

-- Authorized read-only preflight before applying this reviewed migration:
-- SELECT company_id, count(*) FROM public.sales_documents
-- WHERE kind='order' AND (customer_id IS NULL OR company_id IS NULL)
-- GROUP BY company_id;
-- SELECT d.id, d.company_id, d.customer_id, c.company_id AS customer_company
-- FROM public.sales_documents d LEFT JOIN public.customers c ON c.id=d.customer_id
-- WHERE d.kind='order' AND (c.id IS NULL OR c.company_id IS DISTINCT FROM d.company_id);
--
-- Historical rows require verified customer reconciliation; never guess an ID.
-- Once every historical row is remediated, validate constraint under a separate
-- reviewed database change. This migration does NOT authorize Invoice issuance,
-- change Order #108, enable financial writers, or replace signed Owner OTP.
