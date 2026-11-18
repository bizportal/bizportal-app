-- CST-DEV Invoice Phase B2: minimal identity/independent approval READ ONLY.
-- NOLOGIN role, no SELECT to passwords, no FOR SHARE/UPDATE yet.
-- Requires Phase B1 read RLS and Phase A2 disabled actors; PROD excluded.
DO $pre$
DECLARE n int; t text; rls_on bool;
BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres' THEN
  RAISE EXCEPTION 'INVOICE_B2_WRONG_DATABASE_OR_ACTOR';
 END IF;
 SELECT count(*) INTO n FROM pg_roles WHERE rolname IN (
  'bizportal_customer_invoice_cst_writer_dev',
  'bizportal_customer_invoice_diva_writer_dev')
 AND rolcanlogin=false AND rolinherit=false AND rolbypassrls=false
 AND rolsuper=false AND rolcreaterole=false;
 IF n<>2 THEN RAISE EXCEPTION 'INVOICE_B2_DORMANT_ROLES_REQUIRED';END IF;
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public'
   AND policyname LIKE 'cst_invoice_b1_%')<>68 THEN
  RAISE EXCEPTION 'INVOICE_B2_PHASE_B1_READ_POLICIES_REQUIRED';
 END IF;
 IF (SELECT count(*) FROM public.bizportal_customer_ar_source_actors_dev
   WHERE (role_name::text,company_id) IN(
    ('bizportal_customer_invoice_cst_writer_dev',1),
    ('bizportal_customer_invoice_diva_writer_dev',3))
    AND enabled=false AND verified_source LIKE
      'CST-DEV Invoice scoped writer Phase A2:%')<>2 THEN
  RAISE EXCEPTION 'INVOICE_B2_ACTORS_MUST_STAY_DISABLED';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
   AND policyname LIKE 'cst_invoice_b2_%') THEN
  RAISE EXCEPTION 'INVOICE_B2_ALREADY_APPLIED_OR_CONFLICT';
 END IF;
 FOREACH t IN ARRAY ARRAY['users','portal_customers',
   'portal_company_members','portal_company_requests'] LOOP
  SELECT c.relrowsecurity INTO rls_on FROM pg_class c
   JOIN pg_namespace ns ON ns.oid=c.relnamespace
   WHERE ns.nspname='public' AND c.relname=t AND c.relkind='r';
  IF rls_on IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'INVOICE_B2_RLS_BASELINE_MISSING %',t;
  END IF;
 END LOOP;
END $pre$;

-- Column-level grants only. Do NOT grant SELECT on password hashes,
-- reset tokens, provider IDs, phone, KTP, or other profile attributes.
GRANT SELECT(id,email,role,system_role,status,is_active,company_id)
 ON public.users TO
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;
GRANT SELECT(id,role,account_status)
 ON public.portal_customers TO
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;
GRANT SELECT(id,portal_customer_id,company_id,is_active)
 ON public.portal_company_members TO
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;
GRANT SELECT(id,portal_customer_id,matched_company_id,status,reviewed_by,reviewed_at)
 ON public.portal_company_requests TO
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;

DO $scope$
DECLARE role_name name; tenant int; suffix text; predicate text;
BEGIN
 FOR role_name,tenant IN SELECT * FROM (VALUES
  ('bizportal_customer_invoice_cst_writer_dev'::name,1),
  ('bizportal_customer_invoice_diva_writer_dev'::name,3)) x(r,c)
 LOOP
  suffix:=CASE tenant WHEN 1 THEN 'cst' ELSE 'diva' END;
  predicate:=format(
   '(CURRENT_USER=SESSION_USER AND role=''super_admin'' AND '||
   'system_role=''super_admin'' AND status=''active'' AND '||
   'is_active IS TRUE AND (company_id IS NULL OR company_id=%s))',
   tenant);
  EXECUTE format(
   'CREATE POLICY cst_invoice_b2_read_%s ON public.users '||
   'FOR SELECT TO %I USING (%s)',suffix,role_name,predicate);
  EXECUTE format(
   'CREATE POLICY cst_invoice_b2_guard_%s ON public.users '||
   'AS RESTRICTIVE FOR ALL TO %I USING (%s) WITH CHECK (%s)',
    suffix,role_name,predicate,predicate);

  predicate:=format(
   '(CURRENT_USER=SESSION_USER AND '||
    '((role=''admin'' AND (account_status=''active'' OR account_status IS NULL)) '||
    'OR EXISTS(SELECT 1 FROM public.sales_documents sd '||
      'WHERE sd.company_id=%s AND sd.customer_id=portal_customers.id)))',
    tenant);
  EXECUTE format(
   'CREATE POLICY cst_invoice_b2_read_%s ON public.portal_customers '||
   'FOR SELECT TO %I USING (%s)',suffix,role_name,predicate);
  EXECUTE format(
   'CREATE POLICY cst_invoice_b2_guard_%s ON public.portal_customers '||
   'AS RESTRICTIVE FOR ALL TO %I USING (%s) WITH CHECK (%s)',
    suffix,role_name,predicate,predicate);

  predicate:=format(
   '(CURRENT_USER=SESSION_USER AND company_id=%s AND is_active IS TRUE)',tenant);
  EXECUTE format(
   'CREATE POLICY cst_invoice_b2_read_%s ON public.portal_company_members '||
   'FOR SELECT TO %I USING (%s)',suffix,role_name,predicate);
  EXECUTE format(
   'CREATE POLICY cst_invoice_b2_guard_%s ON public.portal_company_members '||
   'AS RESTRICTIVE FOR ALL TO %I USING (%s) WITH CHECK (%s)',
    suffix,role_name,predicate,predicate);

  predicate:=format(
   '(CURRENT_USER=SESSION_USER AND matched_company_id=%s AND '||
    'status=''approved'' AND reviewed_by IS NOT NULL AND '||
    'reviewed_by<>portal_customer_id AND reviewed_at IS NOT NULL)',tenant);
  EXECUTE format(
   'CREATE POLICY cst_invoice_b2_read_%s ON public.portal_company_requests '||
   'FOR SELECT TO %I USING (%s)',suffix,role_name,predicate);
  EXECUTE format(
   'CREATE POLICY cst_invoice_b2_guard_%s ON public.portal_company_requests '||
   'AS RESTRICTIVE FOR ALL TO %I USING (%s) WITH CHECK (%s)',
    suffix,role_name,predicate,predicate);
 END LOOP;
END $scope$;

DO $post$
BEGIN
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public'
   AND policyname LIKE 'cst_invoice_b2_%')<>16 THEN
  RAISE EXCEPTION 'INVOICE_B2_POLICY_COUNT_MISMATCH';
 END IF;
 IF has_column_privilege('bizportal_customer_invoice_cst_writer_dev',
    'public.users','password_hash','SELECT')
  OR has_column_privilege('bizportal_customer_invoice_diva_writer_dev',
    'public.portal_customers','password_hash','SELECT')
  OR has_table_privilege('bizportal_customer_invoice_cst_writer_dev',
    'public.users','UPDATE')
  OR has_table_privilege('bizportal_customer_invoice_diva_writer_dev',
    'public.portal_company_requests','UPDATE') THEN
  RAISE EXCEPTION 'INVOICE_B2_SECRET_OR_WRITE_PRIVILEGE';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN(
 'bizportal_customer_invoice_cst_writer_dev',
 'bizportal_customer_invoice_diva_writer_dev') AND rolcanlogin=true) THEN
  RAISE EXCEPTION 'INVOICE_B2_UNEXPECTED_LOGIN';
 END IF;
END $post$;
