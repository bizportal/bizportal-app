-- CST-DEV only: rollback this SELECT-only policy without changing data.
DROP POLICY IF EXISTS dev_finance_legacy_invoice_reader_20261119
ON public.vendor_invoices;
