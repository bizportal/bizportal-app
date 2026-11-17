-- CST-DEV phase 0 only. One existing Supabase database, two dormant Finance identities.
-- No password, no login, no Finance grants, no RLS/policy modification.
-- DO NOT execute against PROD. Reviewed PR107/108 review-only guards are untouched.
-- This is a separate minimal reversible migration, NOT a copy of PR107/108.
BEGIN;
SET LOCAL lock_timeout = '1000ms';
SET LOCAL statement_timeout = '15000ms';
DO $preflight$
DECLARE fp text; policy_count integer;
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres'
  THEN RAISE EXCEPTION 'DEV_FINANCE_WRONG_DATABASE_OR_ADMIN'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolcreaterole)
  THEN RAISE EXCEPTION 'DEV_FINANCE_ADMIN_CREATE_ROLE_MISSING'; END IF;
  IF to_regrole('bizportal_finance_cst_login_dev') IS NOT NULL OR
     to_regrole('bizportal_finance_diva_login_dev') IS NOT NULL OR
     to_regrole('bizportal_finance_parent_lock_owner_dev') IS NOT NULL
  THEN RAISE EXCEPTION 'DEV_FINANCE_DORMANT_ROLES_ALREADY_EXIST'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND
             policyname='pr107_company_role_restrictive_all') OR
     to_regnamespace('finance_ops_private') IS NOT NULL
  THEN RAISE EXCEPTION 'DEV_FINANCE_SECURITY_MIGRATION_ALREADY_STAGED'; END IF;
  SELECT count(*), md5(string_agg(
     tablename||'|'||policyname||'|'||cmd||'|'||permissive||'|'||roles::text||'|'||
     coalesce(qual,'')||'|'||coalesce(with_check,''),
     E'\n' ORDER BY tablename,policyname,cmd))
    INTO policy_count,fp FROM pg_policies WHERE schemaname='public'
      AND policyname LIKE 'pr50_finance_dev_%';
  IF policy_count <> 18 OR fp IS DISTINCT FROM 'f69295cc7f66f8bc4645a6fc02e2f36e'
  THEN RAISE EXCEPTION 'DEV_FINANCE_ORIGINAL_POLICY_FINGERPRINT_CHANGED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE
       rolname='bizportal_marketplace_finance_login_dev'
       AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolinherit)
  THEN RAISE EXCEPTION 'DEV_FINANCE_ORIGINAL_ROLE_CHANGED'; END IF;
END
$preflight$;

CREATE ROLE bizportal_finance_cst_login_dev
  NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 0;
CREATE ROLE bizportal_finance_diva_login_dev
  NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 0;

DO $postflight$
DECLARE ready integer; fp text; policy_count integer;
BEGIN
  SELECT count(*) INTO ready FROM pg_roles
    WHERE rolname IN ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev')
      AND NOT rolcanlogin AND NOT rolinherit AND NOT rolbypassrls AND NOT rolsuper
      AND NOT rolcreaterole AND NOT rolcreatedb AND rolconnlimit=0;
  IF ready <> 2 THEN RAISE EXCEPTION 'DEV_FINANCE_DORMANT_ROLE_ATTRIBUTES_INVALID'; END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
     WHERE r.rolname IN ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev'))
  THEN RAISE EXCEPTION 'DEV_FINANCE_DORMANT_ROLE_MEMBERSHIP_INVALID'; END IF;
  SELECT count(*), md5(string_agg(tablename||'|'||policyname||'|'||cmd||'|'||permissive||'|'||
       roles::text||'|'||coalesce(qual,'')||'|'||coalesce(with_check,''),
       E'\n' ORDER BY tablename,policyname,cmd))
    INTO policy_count,fp FROM pg_policies
    WHERE schemaname='public' AND policyname LIKE 'pr50_finance_dev_%';
  IF policy_count <> 18 OR fp IS DISTINCT FROM 'f69295cc7f66f8bc4645a6fc02e2f36e'
  THEN RAISE EXCEPTION 'DEV_FINANCE_ORIGINAL_POLICIES_CHANGED'; END IF;
END
$postflight$;
COMMIT;
