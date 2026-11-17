-- DEV ONLY: CST-DEV project xssrfshdrtdfupgqwfdw.
-- Allow the existing dedicated Diva read identity to verify its own company.
-- This file is deliberately outside the application's production migrations.
-- No source-Fleet access or Finance write capability is added.
BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'bizportal_finance_diva_login_dev'
      AND rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Expected dedicated DEV Diva login with NOINHERIT/NOBYPASSRLS';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.companies
    WHERE id = 3 AND name = 'PT Diva Servis' AND is_active IS TRUE
  ) THEN
    RAISE EXCEPTION 'Expected active PT Diva Servis company 3';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.companies'::regclass AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'Company row-level security must remain enabled';
  END IF;
END
$preflight$;

GRANT SELECT (id, is_active) ON public.companies
  TO bizportal_finance_diva_login_dev;

CREATE POLICY fleet_diva_dev_company_metadata_allow
ON public.companies
AS PERMISSIVE
FOR SELECT
TO bizportal_finance_diva_login_dev
USING (
  id = 3 AND is_active IS TRUE
  AND current_user = session_user
  AND session_user = 'bizportal_finance_diva_login_dev'
);

-- Keep this identity within Diva even if another permissive policy is added.
CREATE POLICY fleet_diva_dev_company_metadata_boundary
ON public.companies
AS RESTRICTIVE
FOR SELECT
TO bizportal_finance_diva_login_dev
USING (
  id = 3 AND is_active IS TRUE
  AND current_user = session_user
  AND session_user = 'bizportal_finance_diva_login_dev'
);

COMMIT;
