-- CST-DEV ONLY: complete minimal reads for the EXISTING Super Admin approver.
-- No new role/account/password, login activation, schema, salary, journal or payout.
-- All five tables already have dedicated company-scoped RLS policies.
DO $guard$
DECLARE
 t text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='bizportal_payroll_approver_dev'
  AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb)
 THEN RAISE EXCEPTION 'PAYROLL_APPROVER_RESTRICTED_ROLE_REQUIRED'; END IF;
 FOREACH t IN ARRAY ARRAY['payroll_runs','payroll_items','employees',
  'cash_advances','payroll_kasbon_auto_reservations'] LOOP
  IF NOT EXISTS(
   SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relname=t AND c.relkind='r'
   AND c.relrowsecurity
  ) THEN RAISE EXCEPTION 'PAYROLL_APPROVER_RLS_MISSING_%',t; END IF;
 END LOOP;
 IF has_schema_privilege('bizportal_payroll_approver_dev','public','CREATE') OR
  COALESCE(has_table_privilege('bizportal_payroll_approver_dev',
   to_regclass('public.salary_payments'),'INSERT'),false)
 THEN RAISE EXCEPTION 'PAYROLL_APPROVER_PRIVILEGE_TOO_BROAD'; END IF;
END $guard$;

-- One signed Super Admin approval reads a scoped Draft run + all employee items,
-- their parent employees and prepared kasbon holds. Only those exact columns
-- are needed; do not grant SELECT on salary-payment or bank tables.
GRANT SELECT(id,company_id,status,posting_status,accounting_entry_id,
 payment_entry_id,approved_at,notes)
 ON public.payroll_runs TO bizportal_payroll_approver_dev;
GRANT SELECT(id,run_id,employee_id,is_paid,base_salary,allowance,gross_salary,
 bpjs_jht_employee,bpjs_kes_employee,pph21,other_deductions,kasbon_deduction,
 total_deductions,net_salary)
 ON public.payroll_items TO bizportal_payroll_approver_dev;
GRANT SELECT(id,company_id,status,deleted_at)
 ON public.employees TO bizportal_payroll_approver_dev;
GRANT SELECT(id,company_id,employee_id,type,remaining_amount,status,lifecycle_status,
 approved_at,approved_by,disbursed_at,disbursed_by,accounting_entry_id,
 posting_status,voided_at)
 ON public.cash_advances TO bizportal_payroll_approver_dev;
GRANT SELECT(id,company_id,run_id,employee_id,payroll_item_id,advance_id,
 amount,balance_at_preparation,state)
 ON public.payroll_kasbon_auto_reservations TO bizportal_payroll_approver_dev;
