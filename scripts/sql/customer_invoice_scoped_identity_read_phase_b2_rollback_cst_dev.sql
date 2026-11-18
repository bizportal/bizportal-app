-- CST-DEV Phase B2 rollback: remove only column-scoped identity READ grants.
-- Phase B1 financial read policies and both dormant roles must remain.
DO $pre$
DECLARE n int;
BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres' THEN
  RAISE EXCEPTION 'INVOICE_B2_ROLLBACK_WRONG_DATABASE_OR_ACTOR';
 END IF;
 SELECT count(*) INTO n FROM pg_roles
 WHERE rolname IN('bizportal_customer_invoice_cst_writer_dev',
                  'bizportal_customer_invoice_diva_writer_dev')
 AND rolcanlogin=false AND rolinherit=false AND rolbypassrls=false
 AND rolsuper=false;
 IF n<>2 THEN RAISE EXCEPTION 'INVOICE_B2_ROLLBACK_DORMANT_ROLES_REQUIRED';END IF;
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public'
  AND policyname LIKE 'cst_invoice_b1_%')<>68 THEN
  RAISE EXCEPTION 'INVOICE_B2_ROLLBACK_B1_BASELINE_CHANGED';
 END IF;
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public'
  AND policyname LIKE 'cst_invoice_b2_%')<>16 THEN
  RAISE EXCEPTION 'INVOICE_B2_ROLLBACK_POLICY_SET_CHANGED';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
  AND policyname LIKE 'cst_invoice_b3_%') THEN
  RAISE EXCEPTION 'INVOICE_B2_ROLLBACK_B3_ALREADY_STARTED';
 END IF;
 IF (SELECT count(*) FROM public.bizportal_customer_ar_source_actors_dev
 WHERE (role_name::text,company_id) IN (
  ('bizportal_customer_invoice_cst_writer_dev',1),
  ('bizportal_customer_invoice_diva_writer_dev',3))
 AND enabled=false AND verified_source LIKE
  'CST-DEV Invoice scoped writer Phase A2:%')<>2 THEN
  RAISE EXCEPTION 'INVOICE_B2_ROLLBACK_ACTOR_ACTIVE_OR_CHANGED';
 END IF;
 IF has_table_privilege('bizportal_customer_invoice_cst_writer_dev',
  'public.users','UPDATE')
 OR has_table_privilege('bizportal_customer_invoice_diva_writer_dev',
  'public.portal_company_requests','UPDATE') THEN
  RAISE EXCEPTION 'INVOICE_B2_ROLLBACK_UNEXPECTED_AUTH_UPDATE';
 END IF;
END $pre$;

DO $drop$
DECLARE t text;suffix text;
BEGIN
 FOREACH t IN ARRAY ARRAY[
  'users','portal_customers','portal_company_members',
  'portal_company_requests'] LOOP
  FOREACH suffix IN ARRAY ARRAY['cst','diva'] LOOP
   EXECUTE format('DROP POLICY cst_invoice_b2_read_%s ON public.%I',suffix,t);
   EXECUTE format('DROP POLICY cst_invoice_b2_guard_%s ON public.%I',suffix,t);
  END LOOP;
 END LOOP;
END $drop$;

REVOKE SELECT(id,email,role,system_role,status,is_active,company_id)
 ON public.users FROM
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;
REVOKE SELECT(id,role,account_status)
 ON public.portal_customers FROM
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;
REVOKE SELECT(id,portal_customer_id,company_id,is_active)
 ON public.portal_company_members FROM
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;
REVOKE SELECT(id,portal_customer_id,matched_company_id,status,reviewed_by,reviewed_at)
 ON public.portal_company_requests FROM
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;

DO $post$
BEGIN
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public'
 AND policyname LIKE 'cst_invoice_b2_%')<>0 THEN
  RAISE EXCEPTION 'INVOICE_B2_ROLLBACK_POLICIES_REMAIN';
 END IF;
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public'
 AND policyname LIKE 'cst_invoice_b1_%')<>68 THEN
  RAISE EXCEPTION 'INVOICE_B2_ROLLBACK_REMOVED_B1_POLICIES';
 END IF;
 IF has_column_privilege('bizportal_customer_invoice_cst_writer_dev',
    'public.users','id','SELECT')
 OR has_column_privilege('bizportal_customer_invoice_diva_writer_dev',
    'public.portal_company_requests','reviewed_by','SELECT') THEN
  RAISE EXCEPTION 'INVOICE_B2_ROLLBACK_AUTH_READ_REMAINS';
 END IF;
END $post$;
