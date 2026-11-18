-- CST-DEV Phase B3 rollback: remove only no-op auth row-lock policies.
-- Use before LOGIN, before finance writer grants, and with AR actors disabled.
DO $pre$
DECLARE n int;
BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres' THEN
  RAISE EXCEPTION 'INVOICE_B3_ROLLBACK_WRONG_DATABASE_OR_ACTOR';
 END IF;
 SELECT count(*) INTO n FROM pg_roles WHERE rolname IN (
 'bizportal_customer_invoice_cst_writer_dev',
 'bizportal_customer_invoice_diva_writer_dev')
 AND rolcanlogin=false AND rolinherit=false AND rolbypassrls=false
 AND rolsuper=false;
 IF n<>2 THEN RAISE EXCEPTION 'INVOICE_B3_ROLLBACK_REQUIRES_DORMANT_ROLES'; END IF;
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public'
  AND policyname LIKE 'cst_invoice_b1_%')<>68
 OR (SELECT count(*) FROM pg_policies WHERE schemaname='public'
  AND policyname LIKE 'cst_invoice_b2_%')<>16
 OR (SELECT count(*) FROM pg_policies WHERE schemaname='public'
  AND policyname LIKE 'cst_invoice_b3_%')<>8 THEN
  RAISE EXCEPTION 'INVOICE_B3_ROLLBACK_POLICY_BASELINE_CHANGED';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public'
  AND policyname LIKE 'cst_invoice_b4_%') THEN
  RAISE EXCEPTION 'INVOICE_B3_ROLLBACK_B4_ALREADY_STARTED';
 END IF;
 IF (SELECT count(*) FROM public.bizportal_customer_ar_source_actors_dev
  WHERE (role_name::text,company_id) IN(
   ('bizportal_customer_invoice_cst_writer_dev',1),
   ('bizportal_customer_invoice_diva_writer_dev',3))
  AND enabled=false AND verified_source LIKE 'CST-DEV Invoice scoped writer Phase A2:%')<>2 THEN
  RAISE EXCEPTION 'INVOICE_B3_ROLLBACK_ACTORS_CHANGED';
 END IF;
 IF has_table_privilege('bizportal_customer_invoice_cst_writer_dev',
  'public.accounting_entries','INSERT')
 OR has_table_privilege('bizportal_customer_invoice_diva_writer_dev',
  'public.financial_outbox_events','INSERT') THEN
  RAISE EXCEPTION 'INVOICE_B3_ROLLBACK_FINANCIAL_WRITES_ALREADY_ENABLED';
 END IF;
END $pre$;

DO $drop$
DECLARE s text;t text;
BEGIN
 FOREACH t IN ARRAY ARRAY[
  'users','portal_customers','portal_company_members',
  'portal_company_requests'] LOOP
  FOREACH s IN ARRAY ARRAY['cst','diva'] LOOP
   EXECUTE format('DROP POLICY cst_invoice_b3_ownerlock_%s ON public.%I',s,t);
  END LOOP;
 END LOOP;
END $drop$;
REVOKE UPDATE(updated_at) ON public.users,
 public.portal_company_members,public.portal_company_requests FROM
 bizportal_customer_invoice_cst_writer_dev,
 bizportal_customer_invoice_diva_writer_dev;
REVOKE UPDATE(status_changed_at) ON public.portal_customers FROM
 bizportal_customer_invoice_cst_writer_dev,
 bizportal_customer_invoice_diva_writer_dev;

DO $post$
BEGIN
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public'
  AND policyname LIKE 'cst_invoice_b3_%')<>0 THEN
  RAISE EXCEPTION 'INVOICE_B3_ROLLBACK_POLICIES_REMAIN';
 END IF;
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public'
  AND policyname LIKE 'cst_invoice_b1_%')<>68 OR
    (SELECT count(*) FROM pg_policies WHERE schemaname='public'
  AND policyname LIKE 'cst_invoice_b2_%')<>16 THEN
  RAISE EXCEPTION 'INVOICE_B3_ROLLBACK_REMOVED_READ_POLICIES';
 END IF;
 IF has_column_privilege('bizportal_customer_invoice_cst_writer_dev',
  'public.users','updated_at','UPDATE') OR
 has_column_privilege('bizportal_customer_invoice_diva_writer_dev',
  'public.portal_company_members','updated_at','UPDATE') THEN
  RAISE EXCEPTION 'INVOICE_B3_ROLLBACK_UPDATE_GRANT_REMAINS';
 END IF;
END $post$;
