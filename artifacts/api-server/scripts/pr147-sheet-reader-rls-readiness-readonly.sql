-- PR147 — read-only CST-DEV permission release gate.
-- Running this script performs SELECT only. It neither grants permissions
-- nor creates RLS policies. No password or service_role is required.
-- Result must be reviewed with a signed application session E2E; no
-- production cutover is authorized based on this output alone.
WITH candidate_roles AS (
  SELECT r.rolname, r.rolcanlogin,
         has_table_privilege(r.oid, 'public.bank_sheet_configs', 'SELECT') AS sheet_select,
         has_table_privilege(r.oid, 'public.company_bank_accounts', 'SELECT') AS bank_select,
         has_table_privilege(r.oid, 'public.chart_of_accounts', 'SELECT') AS coa_select
  FROM pg_roles r
  WHERE r.rolname IN (
    'bizportal_pr81_otp_login_dev',
    'bizportal_finance_cst_login_dev',
    'bizportal_finance_diva_login_dev',
    'bizportal_payroll_dev',
    'bizportal_dev_runtime'
  )
),
table_state AS (
  SELECT c.relname, c.relrowsecurity,
         COUNT(p.oid)::integer AS rls_policy_count
  FROM pg_class c
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  LEFT JOIN pg_policy p ON p.polrelid=c.oid
  WHERE ns.nspname='public'
    AND c.relname IN ('bank_sheet_configs','company_bank_accounts','chart_of_accounts')
  GROUP BY c.relname,c.relrowsecurity
)
SELECT
  (SELECT COALESCE(relrowsecurity,false) FROM table_state
   WHERE relname='bank_sheet_configs') AS sheet_rls_enabled,
  (SELECT COALESCE(rls_policy_count,0) FROM table_state
   WHERE relname='bank_sheet_configs') AS sheet_rls_policy_count,
  (SELECT COUNT(*) FROM candidate_roles WHERE rolcanlogin) AS candidate_login_roles,
  (SELECT COUNT(*) FROM candidate_roles
   WHERE sheet_select AND bank_select AND coa_select) AS complete_reader_roles,
  (SELECT CASE WHEN
    EXISTS (SELECT 1 FROM table_state WHERE relname='bank_sheet_configs' AND relrowsecurity AND rls_policy_count>0)
    AND EXISTS (SELECT 1 FROM candidate_roles WHERE sheet_select AND bank_select AND coa_select)
    THEN 'REVIEW_SIGNED_E2E' ELSE 'BLOCKED_MISSING_SCOPED_READER' END) AS cutover_rls_gate;
