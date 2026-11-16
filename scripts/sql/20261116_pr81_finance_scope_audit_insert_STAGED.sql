-- REVIEW/STAGING ONLY. Intended solely for Supabase CST-DEV xssrfshdrtdfupgqwfdw.
-- Run only via explicitly approved owner SQL migration. NEVER on PROD.
-- Add one narrowly constrained audit INSERT policy. No new table grants.
BEGIN;
SET LOCAL lock_timeout = '1500ms';
SET LOCAL statement_timeout = '15000ms';
DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname='bizportal_pr81_otp_login_dev'
       AND rolsuper=false AND rolbypassrls=false
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname='audit_logs'
       AND c.relkind='r' AND c.relrowsecurity=true
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policies p
     WHERE p.schemaname='public' AND p.tablename='audit_logs'
       AND p.policyname='pr81_auth_delivery_audit_insert'
       AND p.cmd='INSERT'
       AND 'bizportal_pr81_otp_login_dev'=ANY(p.roles)
  ) OR NOT has_table_privilege(
    'bizportal_pr81_otp_login_dev','public.audit_logs','INSERT'
  ) OR has_table_privilege(
    'bizportal_pr81_otp_login_dev','public.audit_logs','SELECT'
  ) OR EXISTS (
    SELECT 1 FROM pg_policies p
     WHERE p.schemaname='public' AND p.tablename='audit_logs'
       AND p.policyname='pr81_finance_company_selection_audit_insert'
  ) THEN
    RAISE EXCEPTION 'PR81_FINANCE_AUDIT_POLICY_PRECONDITION_FAILED';
  END IF;
END
$guard$;
CREATE POLICY pr81_finance_company_selection_audit_insert
ON public.audit_logs AS PERMISSIVE FOR INSERT
TO bizportal_pr81_otp_login_dev
WITH CHECK (
  lower(btrim(coalesce(user_email,''))) = 'admcst001@gmail.com'
  AND action = 'finance_company_scope_selected'
  AND entity_type = 'company'
  AND company_id IN ('1','3')
  AND entity_id = company_id
  AND module = 'marketplace_finance'
  AND jsonb_typeof(after_data) = 'object'
  AND (after_data ->> 'source') = 'signed_dev_superadmin'
  AND (after_data ->> 'selectedCompanyId') = company_id
);
DO $guard$
BEGIN
  IF (SELECT count(*) FROM pg_policies p
       WHERE p.schemaname='public' AND p.tablename='audit_logs'
         AND p.policyname='pr81_finance_company_selection_audit_insert'
         AND p.cmd='INSERT'
         AND 'bizportal_pr81_otp_login_dev'=ANY(p.roles)) <> 1
    OR has_table_privilege(
      'bizportal_pr81_otp_login_dev','public.audit_logs','SELECT'
    ) THEN
    RAISE EXCEPTION 'PR81_FINANCE_AUDIT_POLICY_POSTCHECK_FAILED';
  END IF;
END
$guard$;
COMMIT;
