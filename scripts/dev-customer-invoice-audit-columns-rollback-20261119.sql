-- CST-DEV rollback only after Invoice feature flags are OFF and writers idle.
-- Revert ONLY these two exact column grants; keep original B1/B4 policies.
REVOKE INSERT(change_reason,after_state) ON public.audit_accounting_events
  FROM bizportal_customer_invoice_cst_writer_dev,
       bizportal_customer_invoice_diva_writer_dev;
