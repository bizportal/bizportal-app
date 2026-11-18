-- CST-DEV Customer Invoice Phase A2: dormant AR source actor reservations.
-- Only after the two dedicated writers have been created as NOLOGIN.
DO $guard$
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'CUSTOMER_INVOICE_DEV_ACTOR_WRONG_DATABASE_ACTOR';
  END IF;
  IF (SELECT count(*) FROM pg_roles
       WHERE rolname IN ('bizportal_customer_invoice_cst_writer_dev',
                         'bizportal_customer_invoice_diva_writer_dev')
         AND rolcanlogin=false AND rolbypassrls=false
         AND rolsuper=false AND rolinherit=false) <> 2 THEN
    RAISE EXCEPTION 'CUSTOMER_INVOICE_DEV_ACTORS_REQUIRE_DORMANT_ROLES';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.bizportal_customer_ar_source_actors_dev
    WHERE role_name::text IN ('bizportal_customer_invoice_cst_writer_dev',
                             'bizportal_customer_invoice_diva_writer_dev')
  ) THEN
    RAISE EXCEPTION 'CUSTOMER_INVOICE_DEV_ACTORS_ALREADY_EXIST';
  END IF;
END
$guard$;
INSERT INTO public.bizportal_customer_ar_source_actors_dev
  (role_name,company_id,enabled,verified_source)
VALUES
  ('bizportal_customer_invoice_cst_writer_dev',1,false,
   'CST-DEV Invoice scoped writer Phase A2: no login, no grants, no posting'),
  ('bizportal_customer_invoice_diva_writer_dev',3,false,
   'CST-DEV Invoice scoped writer Phase A2: no login, no grants, no posting');
