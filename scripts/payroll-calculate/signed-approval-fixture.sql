-- Additional synthetic fixture for actual signed HTTP Calculate -> Super Admin approval.
-- Run ONLY in a newly created localhost disposable PostgreSQL instance.
-- Never use these synthetic test passwords or roles on CST-DEV/PROD.
CREATE ROLE bizportal_payroll_approver_dev
  LOGIN PASSWORD 'payroll_approver_fixture_only_2026'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
CREATE TABLE public.users (
 id text PRIMARY KEY,
 email text NOT NULL UNIQUE,
 role text NOT NULL,
 company_id integer,
 status text NOT NULL DEFAULT 'active',
 is_active boolean NOT NULL DEFAULT true,
 first_name text, last_name text
);
INSERT INTO public.users (id,email,role,company_id,status,is_active) VALUES
 ('ci-super-1','payroll-ci-super@example.test','super_admin',NULL,'active',true),
 ('ci-owner-1','payroll-ci-owner@example.test','owner',1,'active',true),
 ('ci-finance-1','payroll-ci-finance@example.test','finance',1,'active',true);

GRANT USAGE ON SCHEMA public TO bizportal_payroll_approver_dev;
GRANT SELECT ON public.employees,public.payroll_runs,public.payroll_items,
 public.cash_advances,public.payroll_kasbon_auto_reservations
 TO bizportal_payroll_approver_dev;
GRANT UPDATE(status,approved_at,notes)
 ON public.payroll_runs TO bizportal_payroll_approver_dev;

CREATE POLICY payroll_approver_fixture_employee_read ON public.employees
 FOR SELECT TO bizportal_payroll_approver_dev
 USING (company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer);
CREATE POLICY payroll_approver_fixture_run_read ON public.payroll_runs
 FOR SELECT TO bizportal_payroll_approver_dev
 USING (company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer);
CREATE POLICY payroll_approver_fixture_run_once ON public.payroll_runs
 FOR UPDATE TO bizportal_payroll_approver_dev
 USING (
  company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer
  AND status='draft' AND posting_status='pending'
  AND accounting_entry_id IS NULL AND payment_entry_id IS NULL
  AND approved_at IS NULL
  AND COALESCE(notes,'') NOT LIKE '%[PAYROLL_SUPER_ADMIN_APPROVAL_V1]%'
 ) WITH CHECK (
  company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer
  AND status='reviewed' AND posting_status='pending'
  AND accounting_entry_id IS NULL AND payment_entry_id IS NULL
  AND approved_at IS NOT NULL
  AND COALESCE(notes,'') LIKE '%[PAYROLL_SUPER_ADMIN_APPROVAL_V1]%'
 );
CREATE POLICY payroll_approver_fixture_item_read ON public.payroll_items
 FOR SELECT TO bizportal_payroll_approver_dev
 USING (
  EXISTS(SELECT 1 FROM public.payroll_runs r
   WHERE r.id=run_id AND
   r.company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer)
 );
CREATE POLICY payroll_approver_fixture_advance_read ON public.cash_advances
 FOR SELECT TO bizportal_payroll_approver_dev
 USING (
  type='kasbon' AND
  company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer
 );
CREATE POLICY payroll_approver_fixture_hold_read ON public.payroll_kasbon_auto_reservations
 FOR SELECT TO bizportal_payroll_approver_dev
 USING (company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer);
