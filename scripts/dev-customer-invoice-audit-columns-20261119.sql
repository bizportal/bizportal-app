-- CST-DEV SOURCE CANDIDATE ONLY. Do not run on PROD or active CST-DEV
-- until exact project ID/role and rollback gates are separately approved.
-- The current Customer Portal PR231 handler writes these two audit columns
-- inside original GL/PPN/AR/outbox transaction. No broad table grant.
DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles
    WHERE rolname='bizportal_customer_invoice_cst_writer_dev'
      AND NOT rolcanlogin AND NOT rolbypassrls)
    OR NOT EXISTS (SELECT 1 FROM pg_roles
    WHERE rolname='bizportal_customer_invoice_diva_writer_dev'
      AND NOT rolcanlogin AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'CST_DEV_INVOICE_WRITER_MUST_REMAIN_NOLOGIN_NOBYPASSRLS';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public'
      AND tablename='audit_accounting_events'
      AND policyname IN ('cst_invoice_b4_insert_cst','cst_invoice_b4_insert_diva'))<>2
    THEN RAISE EXCEPTION 'CST_DEV_INVOICE_AUDIT_RLS_POLICY_MISSING';
  END IF;
END $preflight$;

GRANT INSERT(change_reason,after_state) ON public.audit_accounting_events
  TO bizportal_customer_invoice_cst_writer_dev,
     bizportal_customer_invoice_diva_writer_dev;

-- Readback with has_column_privilege(..., 'INSERT') for both new columns.
-- This grants no INSERT on other new fields, no role LOGIN, no UPDATE.
