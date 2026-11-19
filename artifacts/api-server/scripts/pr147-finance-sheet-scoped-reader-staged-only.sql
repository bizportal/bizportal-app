-- PR147 — STAGED ONLY. Never run on PROD.
-- CST-DEV least-privilege read policy candidate for dedicated Finance login identities.
-- No password changes, no business-data updates, and no grants to anon/authenticated/service_role.
-- Approved execution is a separate release gate; this file is NOT applied to live CST-DEV.
BEGIN;
DO $pr147$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname='bizportal_finance_cst_login_dev' AND rolcanlogin
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname='bizportal_finance_diva_login_dev' AND rolcanlogin
  ) THEN
    RAISE EXCEPTION 'PR147_READER_BLOCKED: approved login roles missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='bank_sheet_configs' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'PR147_READER_BLOCKED: bank_sheet_configs RLS must already be enabled';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='bank_sheet_configs'
    AND p.polname NOT IN ('pr147_finance_cst_sheet_read_dev','pr147_finance_diva_sheet_read_dev')
  ) THEN
    RAISE EXCEPTION 'PR147_READER_BLOCKED: unexpected existing sheet RLS policies, review first';
  END IF;
END
$pr147$;
GRANT USAGE ON SCHEMA public TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
GRANT SELECT ON public.bank_sheet_configs,public.company_bank_accounts,public.chart_of_accounts
 TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
CREATE POLICY pr147_finance_cst_sheet_read_dev ON public.bank_sheet_configs
 FOR SELECT TO bizportal_finance_cst_login_dev
 USING (company_id=1 AND CURRENT_USER=SESSION_USER);
CREATE POLICY pr147_finance_diva_sheet_read_dev ON public.bank_sheet_configs
 FOR SELECT TO bizportal_finance_diva_login_dev
 USING (company_id=3 AND CURRENT_USER=SESSION_USER);
CREATE POLICY pr147_finance_cst_bank_read_dev ON public.company_bank_accounts
 FOR SELECT TO bizportal_finance_cst_login_dev
 USING (company_id=1 AND CURRENT_USER=SESSION_USER);
CREATE POLICY pr147_finance_diva_bank_read_dev ON public.company_bank_accounts
 FOR SELECT TO bizportal_finance_diva_login_dev
 USING (company_id=3 AND CURRENT_USER=SESSION_USER);
COMMIT;
