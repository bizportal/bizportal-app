-- CST-DEV phase-0 rollback for two dormant roles ONLY.
-- Refuses rollback after any Finance privileges, policies or LOGIN are installed.
-- Only for project xssrfshdrtdfupgqwfdw, not PROD. Review before use.
BEGIN;
SET LOCAL lock_timeout = '1000ms';
SET LOCAL statement_timeout = '15000ms';
DO $safe_rollback$
DECLARE x integer;
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres'
  THEN RAISE EXCEPTION 'DEV_FINANCE_ROLLBACK_WRONG_ADMIN'; END IF;
  SELECT count(*) INTO x FROM pg_roles
    WHERE rolname IN ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev')
      AND NOT rolcanlogin AND NOT rolinherit AND NOT rolbypassrls AND NOT rolsuper
      AND rolconnlimit=0;
  IF x <> 2 THEN RAISE EXCEPTION 'DEV_FINANCE_ROLLBACK_ROLES_CHANGED'; END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
      WHERE r.rolname IN ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev'))
    OR EXISTS (SELECT 1 FROM pg_policies
      WHERE schemaname='public' AND policyname='pr107_company_role_restrictive_all')
    OR to_regnamespace('finance_ops_private') IS NOT NULL
  THEN RAISE EXCEPTION 'DEV_FINANCE_ROLLBACK_STAGE_ADVANCED'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles r
      JOIN pg_shdepend dep ON dep.refobjid=r.oid
      WHERE r.rolname IN ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev')
        AND dep.deptype <> 'o')
  THEN RAISE EXCEPTION 'DEV_FINANCE_ROLLBACK_ROLE_HAS_DEPENDENCIES'; END IF;
END
$safe_rollback$;
DROP ROLE bizportal_finance_cst_login_dev;
DROP ROLE bizportal_finance_diva_login_dev;
DO $verify$
BEGIN
 IF to_regrole('bizportal_finance_cst_login_dev') IS NOT NULL OR
    to_regrole('bizportal_finance_diva_login_dev') IS NOT NULL
 THEN RAISE EXCEPTION 'DEV_FINANCE_ROLLBACK_INCOMPLETE'; END IF;
END $verify$;
COMMIT;
