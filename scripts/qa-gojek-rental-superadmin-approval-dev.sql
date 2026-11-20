-- CST-DEV ONLY. This is NOT a PROD migration.
-- Gives the existing dedicated Finance LOGIN only the approval columns, and
-- a restrictive company3 + exact-code guard. The application additionally
-- requires live signed-OTP Super Admin session and same-origin POST.
BEGIN;
DO $guard$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname='bizportal_fleet_finance_login_dev'
       AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolinherit
  ) THEN RAISE EXCEPTION 'Expected dedicated Finance DEV role unavailable'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.chart_of_accounts'::regclass AND relrowsecurity)
  THEN RAISE EXCEPTION 'Chart of accounts RLS not enabled'; END IF;
END $guard$;

GRANT UPDATE (approved_by, approved_at, updated_at)
ON public.chart_of_accounts TO bizportal_fleet_finance_login_dev;

DO $policy$ BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='chart_of_accounts'
   AND policyname='fleet_gojek_rental_approval_dev_restrictive'
 ) THEN
   CREATE POLICY fleet_gojek_rental_approval_dev_restrictive
   ON public.chart_of_accounts AS RESTRICTIVE
   FOR UPDATE TO bizportal_fleet_finance_login_dev
   USING (
      company_id=3
      AND code IN ('1-1025-DV','1-1035-DV','4-1026-DV','4-1027-DV')
      AND current_user=session_user
      AND current_setting('app.fleet_source_company_id',true)='1'
      AND current_setting('app.fleet_finance_company_id',true)='3'
      AND nullif(current_setting('app.fleet_approval_actor',true),'') IS NOT NULL
   )
   WITH CHECK (
      company_id=3
      AND code IN ('1-1025-DV','1-1035-DV','4-1026-DV','4-1027-DV')
      AND current_user=session_user
      AND current_setting('app.fleet_source_company_id',true)='1'
      AND current_setting('app.fleet_finance_company_id',true)='3'
      AND approved_by=current_setting('app.fleet_approval_actor',true)
      AND approved_at IS NOT NULL
   );
 END IF;
END $policy$;

DO $verify$ BEGIN
 IF NOT has_column_privilege('bizportal_fleet_finance_login_dev','public.chart_of_accounts','approved_by','UPDATE')
 OR NOT has_column_privilege('bizportal_fleet_finance_login_dev','public.chart_of_accounts','approved_at','UPDATE')
 OR has_table_privilege('bizportal_fleet_finance_login_dev','public.chart_of_accounts','DELETE')
 THEN RAISE EXCEPTION 'Approval grant validation failed'; END IF;
END $verify$;
COMMIT;
