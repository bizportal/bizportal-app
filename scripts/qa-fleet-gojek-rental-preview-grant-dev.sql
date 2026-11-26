-- CST-DEV ONLY (Supabase xssrfshdrtdfupgqwfdw). DO NOT run in PROD.
-- Dedicated BizPortal Fleet Finance login; grants source evidence SELECT only.
-- App transactional tenant binding remains fixed to source=1, finance=3.
BEGIN;
DO $guard$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles
   WHERE rolname='bizportal_fleet_finance_login_dev' AND rolcanlogin
     AND NOT rolsuper AND NOT rolbypassrls AND NOT rolinherit)
 THEN RAISE EXCEPTION 'Expected locked-down Fleet Finance DEV role missing'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.fleet_transactions'::regclass AND relrowsecurity)
 THEN RAISE EXCEPTION 'Fleet source RLS is disabled'; END IF;
END $guard$;

GRANT SELECT (id,company_id,report_id,transaction_type,amount,transaction_date,gopay_reference_id)
ON public.fleet_transactions TO bizportal_fleet_finance_login_dev;

DO $policies$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='fleet_transactions' AND policyname='bizportal_fleet_gojek_source_preview_dev') THEN
  CREATE POLICY bizportal_fleet_gojek_source_preview_dev
  ON public.fleet_transactions AS PERMISSIVE FOR SELECT
  TO bizportal_fleet_finance_login_dev
  USING (company_id=1 AND current_setting('app.fleet_source_company_id',true)='1'
     AND current_setting('app.fleet_finance_company_id',true)='3');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='fleet_transactions' AND policyname='bizportal_fleet_gojek_source_limit_dev') THEN
  CREATE POLICY bizportal_fleet_gojek_source_limit_dev
  ON public.fleet_transactions AS RESTRICTIVE FOR SELECT
  TO bizportal_fleet_finance_login_dev
  USING (company_id=1 AND current_setting('app.fleet_source_company_id',true)='1'
     AND current_setting('app.fleet_finance_company_id',true)='3');
 END IF;
END $policies$;
DO $postflight$ BEGIN
 IF NOT has_column_privilege('bizportal_fleet_finance_login_dev','public.fleet_transactions','report_id','SELECT')
 OR NOT has_column_privilege('bizportal_fleet_finance_login_dev','public.fleet_transactions','gopay_reference_id','SELECT')
 OR has_table_privilege('bizportal_fleet_finance_login_dev','public.fleet_transactions','UPDATE')
 OR has_table_privilege('bizportal_fleet_finance_login_dev','public.fleet_transactions','INSERT')
 THEN RAISE EXCEPTION 'Fleet rental QA source grants exceed read-only bounds'; END IF;
END $postflight$;
COMMIT;
