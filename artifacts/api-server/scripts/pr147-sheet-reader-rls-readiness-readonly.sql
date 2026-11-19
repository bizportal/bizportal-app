-- PR147 — read-only CST-DEV permission release gate.
-- Running this script performs SELECT only. It neither grants permissions
-- nor creates RLS policies. No password or service_role is required.
-- Result must be reviewed with a signed application session E2E; no
-- production cutover is authorized based on this output alone.
-- Explicitly supply the verified runtime DB principal when investigating:
--   BEGIN; SET LOCAL app.pr147_expected_runtime_role = 'verified_role'; 
--   [execute the SELECT below]; ROLLBACK;
-- This input is a diagnostic selector, NOT an authentication mechanism.
-- Unspecified principal always fails closed.
WITH expected_runtime AS (
  SELECT nullif(current_setting('app.pr147_expected_runtime_role',true),'') AS rolname
),
candidate_roles AS (
  SELECT r.rolname, r.oid, r.rolcanlogin,
         has_table_privilege(r.oid,'public.bank_sheet_configs','SELECT') AS sheet_select,
         has_table_privilege(r.oid,'public.company_bank_accounts','SELECT') AS bank_select,
         has_table_privilege(r.oid,'public.chart_of_accounts','SELECT') AS coa_select
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
  SELECT c.oid, c.relname, c.relrowsecurity,
         COUNT(p.oid)::integer AS rls_policy_count
  FROM pg_class c
  JOIN pg_namespace ns ON ns.oid=c.relnamespace
  LEFT JOIN pg_policy p ON p.polrelid=c.oid
  WHERE ns.nspname='public'
    AND c.relname IN ('bank_sheet_configs','company_bank_accounts','chart_of_accounts')
  GROUP BY c.oid,c.relname,c.relrowsecurity
),
verified_reader AS (
  SELECT r.*,
    EXISTS (
      SELECT 1 FROM pg_policy p
      JOIN table_state t ON t.oid=p.polrelid
      WHERE t.relname='bank_sheet_configs'
        AND p.polcmd='r'
        AND r.oid = ANY(p.polroles)
    ) AS has_targeted_sheet_select_policy
  FROM candidate_roles r
  JOIN expected_runtime e ON e.rolname=r.rolname
)
SELECT
  (SELECT rolname FROM expected_runtime) AS expected_runtime_role,
  (SELECT COALESCE(relrowsecurity,false) FROM table_state WHERE relname='bank_sheet_configs') AS sheet_rls_enabled,
  (SELECT COALESCE(rls_policy_count,0) FROM table_state WHERE relname='bank_sheet_configs') AS sheet_rls_policy_count,
  (SELECT COUNT(*) FROM candidate_roles WHERE rolcanlogin) AS candidate_login_roles,
  (SELECT COUNT(*) FROM candidate_roles WHERE sheet_select AND bank_select AND coa_select) AS complete_reader_roles,
  (SELECT COUNT(*) FROM verified_reader
   WHERE rolcanlogin AND sheet_select AND bank_select AND coa_select
   AND has_targeted_sheet_select_policy) AS verified_runtime_reader_roles,
  CASE
    WHEN (SELECT rolname FROM expected_runtime) IS NULL
      THEN 'BLOCKED_RUNTIME_PRINCIPAL_UNVERIFIED'
    WHEN NOT EXISTS (SELECT 1 FROM verified_reader
      WHERE rolcanlogin AND sheet_select AND bank_select AND coa_select
        AND has_targeted_sheet_select_policy)
      THEN 'BLOCKED_RUNTIME_PRINCIPAL_NOT_SCOPED_READER'
    ELSE 'REVIEW_SIGNED_E2E'
  END AS cutover_rls_gate;
