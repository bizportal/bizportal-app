-- CST-DEV ONLY: narrow existing bizportal_payroll_dev Calculate rights.
-- No new tables, accounts, passwords, financial rows, GRANT to PUBLIC, or PROD.
-- Deployment controlled by explicit Supabase DEV project ref and migration history.
-- All statements are transactional in Supabase apply_migration.
DO $guard$
DECLARE
  scope_tables text[] := ARRAY[
    'payroll_items','payroll_runs','payroll_kasbon_auto_reservations',
    'payroll_cash_advance_allocations','cash_advance_installment_schedules',
    'cash_advances','employees'
  ];
  table_name text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname='bizportal_payroll_dev'
      AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls
      AND NOT rolcreaterole AND NOT rolcreatedb
  ) THEN RAISE EXCEPTION 'PAYROLL_CALCULATE_RESTRICTED_ROLE_REQUIRED'; END IF;
  FOREACH table_name IN ARRAY scope_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=table_name
        AND c.relkind='r' AND c.relrowsecurity
    ) THEN RAISE EXCEPTION 'PAYROLL_CALCULATE_RLS_REQUIRED_%',table_name; END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_roles r WHERE r.rolname='bizportal_payroll_dev'
      AND (has_schema_privilege(r.oid,'public','CREATE') OR
        COALESCE(has_table_privilege(r.oid,to_regclass('public.salary_payments'),'INSERT'),false))
  ) THEN RAISE EXCEPTION 'PAYROLL_CALCULATE_ROLE_TOO_BROAD'; END IF;
END $guard$;

-- The existing Generate/Edit role already has company-scoped Draft UPDATE RLS.
-- Add ONLY the column Calculate actually modifies.
GRANT UPDATE(kasbon_deduction) ON TABLE public.payroll_items TO bizportal_payroll_dev;

-- These two existing legacy evidence tables have RLS enabled but no readable
-- policy for this role. Without these company-scoped policies the Calculate
-- legacy-overlap guards silently see zero rows.
GRANT SELECT ON TABLE public.payroll_cash_advance_allocations,
  public.cash_advance_installment_schedules TO bizportal_payroll_dev;

CREATE POLICY payroll_dev_allocations_company_read_20261118
ON public.payroll_cash_advance_allocations
FOR SELECT TO bizportal_payroll_dev
USING (
 EXISTS (
  SELECT 1
  FROM public.payroll_items pi
  JOIN public.payroll_runs pr ON pr.id=pi.run_id
  JOIN public.employees e ON e.id=pi.employee_id
  WHERE pi.id=payroll_cash_advance_allocations.payroll_item_id
    AND pr.company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer
    AND e.company_id=pr.company_id
 )
);

CREATE POLICY payroll_dev_installments_company_read_20261118
ON public.cash_advance_installment_schedules
FOR SELECT TO bizportal_payroll_dev
USING (
 company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer
 AND EXISTS (
  SELECT 1 FROM public.cash_advances a
  WHERE a.id=cash_advance_installment_schedules.advance_id
    AND a.company_id=cash_advance_installment_schedules.company_id
    AND a.type='kasbon'
 )
);

-- Replace the original broad table INSERT grant with the exact nine columns
-- used by Calculate. Preserve existing RLS + unique guards without rebuilding.
REVOKE INSERT ON TABLE public.payroll_kasbon_auto_reservations FROM bizportal_payroll_dev;
GRANT INSERT(company_id,run_id,employee_id,payroll_item_id,advance_id,
  period,amount,balance_at_preparation,state)
ON TABLE public.payroll_kasbon_auto_reservations TO bizportal_payroll_dev;

-- Restrictive in addition to the already-existing company/employee/advance
-- permissive policy: a candidate may PREPARE holds, never confirm or cancel
-- them or predate an already-approved/posting run.
CREATE POLICY payroll_dev_reservation_prepare_only_20261118
ON public.payroll_kasbon_auto_reservations
AS RESTRICTIVE FOR INSERT TO bizportal_payroll_dev
WITH CHECK (
 state='prepared'
 AND amount>0 AND balance_at_preparation>=amount
 AND EXISTS (
  SELECT 1 FROM public.payroll_runs r
  WHERE r.id=payroll_kasbon_auto_reservations.run_id
    AND r.company_id=payroll_kasbon_auto_reservations.company_id
    AND r.status='draft' AND r.posting_status='pending'
    AND r.approved_at IS NULL
    AND r.accounting_entry_id IS NULL
    AND r.payment_entry_id IS NULL
 )
);
