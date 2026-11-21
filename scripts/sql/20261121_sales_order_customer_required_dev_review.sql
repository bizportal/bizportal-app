-- CST-DEV review-only migration. Do not run in PROD or auto-apply with drizzle-kit push.
-- Enforce customer linkage for every NEW Sales Order while preserving historical bad rows for remediation.
-- PostgreSQL CHECK ... NOT VALID validates future INSERT/UPDATE without scanning/rejecting existing rows.
-- Existing #108 with NULL customer_id requires its actual customer association through an authorized workflow.
BEGIN;
ALTER TABLE public.sales_documents
  ADD CONSTRAINT sales_order_customer_required
  CHECK (kind <> 'order' OR (customer_id IS NOT NULL AND customer_id > 0)) NOT VALID;
COMMIT;

-- Pre-deployment read-only audit (run separately):
-- SELECT company_id, count(*) AS unlinked_orders
-- FROM public.sales_documents WHERE kind = 'order' AND customer_id IS NULL GROUP BY company_id;
-- After fixing all historical rows through legitimate document/customer mapping, an authorized
-- administrator may separately VALIDATE CONSTRAINT sales_order_customer_required.
-- Existing FK guarantees customer existence, but company ownership MUST also be checked by
-- the authorized company-scoped Sales API before insertion or confirmation.
