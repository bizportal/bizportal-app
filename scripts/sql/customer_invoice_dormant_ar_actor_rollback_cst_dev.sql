-- CST-DEV Phase A2 rollback: remove only untouched, disabled staging actors.
DO $guard$
DECLARE n integer;
BEGIN
 IF current_database() <> 'postgres' OR current_user <> 'postgres' THEN
   RAISE EXCEPTION 'CUSTOMER_INVOICE_DEV_ACTOR_ROLLBACK_WRONG_DATABASE_ACTOR';
 END IF;
 IF EXISTS (
    SELECT 1 FROM public.bizportal_customer_ar_source_actors_dev
    WHERE role_name::text IN ('bizportal_customer_invoice_cst_writer_dev',
                             'bizportal_customer_invoice_diva_writer_dev')
      AND (enabled=true OR verified_source NOT LIKE
         'CST-DEV Invoice scoped writer Phase A2:%')
 ) THEN RAISE EXCEPTION 'CUSTOMER_INVOICE_DEV_ACTOR_CHANGED_STOP'; END IF;
 DELETE FROM public.bizportal_customer_ar_source_actors_dev
 WHERE role_name::text IN ('bizportal_customer_invoice_cst_writer_dev',
                          'bizportal_customer_invoice_diva_writer_dev')
   AND enabled=false
   AND verified_source LIKE 'CST-DEV Invoice scoped writer Phase A2:%';
END
$guard$;
