-- CST-DEV ONLY; applied as Supabase migration
-- bizportal_payroll_dev_dedicated_rls_20261107.
-- The role starts NOLOGIN. Provision a random password and enable LOGIN
-- through an authorized secure credential workflow. Never commit credentials.
-- Do not grant these privileges to aicore_dev_runtime or other shared roles.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bizportal_payroll_dev') THEN
    CREATE ROLE bizportal_payroll_dev NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
END $$;
ALTER ROLE bizportal_payroll_dev NOLOGIN NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO bizportal_payroll_dev;
REVOKE ALL PRIVILEGES ON public.payroll_runs FROM bizportal_payroll_dev;
REVOKE ALL PRIVILEGES ON public.payroll_items FROM bizportal_payroll_dev;
REVOKE ALL PRIVILEGES ON public.employees FROM bizportal_payroll_dev;
GRANT SELECT ON public.payroll_runs TO bizportal_payroll_dev;
GRANT INSERT (company_id, month, year, notes, status) ON public.payroll_runs TO bizportal_payroll_dev;
GRANT USAGE ON SEQUENCE public.payroll_runs_id_seq TO bizportal_payroll_dev;
GRANT SELECT ON public.payroll_items TO bizportal_payroll_dev;
GRANT SELECT (id, company_id, first_name, last_name) ON public.employees TO bizportal_payroll_dev;

CREATE POLICY payroll_dev_runs_select_scoped
ON public.payroll_runs FOR SELECT TO bizportal_payroll_dev
USING (company_id = NULLIF(current_setting('app.payroll_company_id', true), '')::integer);

CREATE POLICY payroll_dev_runs_insert_draft_scoped
ON public.payroll_runs FOR INSERT TO bizportal_payroll_dev
WITH CHECK (
  company_id = NULLIF(current_setting('app.payroll_company_id', true), '')::integer
  AND status = 'draft'
  AND posting_status = 'pending'
  AND accounting_entry_id IS NULL
  AND payment_entry_id IS NULL
);

CREATE POLICY payroll_dev_items_select_scoped
ON public.payroll_items FOR SELECT TO bizportal_payroll_dev
USING (EXISTS (
  SELECT 1 FROM public.payroll_runs pr
  WHERE pr.id = payroll_items.run_id
    AND pr.company_id = NULLIF(current_setting('app.payroll_company_id', true), '')::integer
));

CREATE POLICY payroll_dev_employee_names_scoped
ON public.employees FOR SELECT TO bizportal_payroll_dev
USING (company_id = NULLIF(current_setting('app.payroll_company_id', true), '')::integer);
