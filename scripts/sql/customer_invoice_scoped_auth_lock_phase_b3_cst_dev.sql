-- CST-DEV Phase B3: row-lock-only grants for existing Invoice auth SQL.
-- The role is NOLOGIN, and every UPDATE policy has WITH CHECK(false).
-- This enables future SELECT ... FOR SHARE; no change to a user/approval
-- record is authorized by these column grants.
DO $pre$
DECLARE n int;
BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres' THEN
  RAISE EXCEPTION 'INVOICE_B3_WRONG_DATABASE_OR_ACTOR';
 END IF;
 SELECT count(*) INTO n FROM pg_roles WHERE rolname IN (
  'bizportal_customer_invoice_cst_writer_dev',
  'bizportal_customer_invoice_diva_writer_dev')
 AND rolcanlogin=false AND rolinherit=false AND rolbypassrls=false
 AND rolsuper=false AND rolcreaterole=false;
 IF n<>2 THEN RAISE EXCEPTION 'INVOICE_B3_REQUIRES_DORMANT_ROLES'; END IF;
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public'
  AND policyname LIKE 'cst_invoice_b1_%')<>68
 OR (SELECT count(*) FROM pg_policies WHERE schemaname='public'
  AND policyname LIKE 'cst_invoice_b2_%')<>16 THEN
  RAISE EXCEPTION 'INVOICE_B3_B1_B2_BASELINE_MISSING';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
  AND policyname LIKE 'cst_invoice_b3_%') THEN
  RAISE EXCEPTION 'INVOICE_B3_ALREADY_APPLIED';
 END IF;
 IF (SELECT count(*) FROM public.bizportal_customer_ar_source_actors_dev
  WHERE (role_name::text,company_id) IN (
   ('bizportal_customer_invoice_cst_writer_dev',1),
   ('bizportal_customer_invoice_diva_writer_dev',3))
  AND enabled=false AND verified_source LIKE 'CST-DEV Invoice scoped writer Phase A2:%')<>2 THEN
  RAISE EXCEPTION 'INVOICE_B3_ACTORS_NOT_DISABLED';
 END IF;
END $pre$;

-- FOR SHARE needs an UPDATE *column* privilege in PostgreSQL.
-- RLS WITH CHECK(false) forbids actual row mutation.
GRANT UPDATE(updated_at) ON public.users,
 public.portal_company_members,public.portal_company_requests TO
 bizportal_customer_invoice_cst_writer_dev,
 bizportal_customer_invoice_diva_writer_dev;
GRANT UPDATE(status_changed_at) ON public.portal_customers TO
 bizportal_customer_invoice_cst_writer_dev,
 bizportal_customer_invoice_diva_writer_dev;

DO $policies$
DECLARE r name; t int; suffix text; predicate text;
BEGIN
 FOR r,t IN SELECT * FROM (VALUES
 ('bizportal_customer_invoice_cst_writer_dev'::name,1),
 ('bizportal_customer_invoice_diva_writer_dev'::name,3)) x(role_name,company)
 LOOP
  suffix:=CASE t WHEN 1 THEN 'cst' ELSE 'diva' END;
  predicate:=format(
   '(CURRENT_USER=SESSION_USER AND role=''super_admin'' '||
   'AND system_role=''super_admin'' AND status=''active'' '||
   'AND is_active IS TRUE AND (company_id IS NULL OR company_id=%s))',t);
  EXECUTE format(
   'CREATE POLICY cst_invoice_b3_ownerlock_%s ON public.users '||
   'FOR UPDATE TO %I USING (%s) WITH CHECK (false)',suffix,r,predicate);

  predicate:='(CURRENT_USER=SESSION_USER AND role=''admin'' '||
    'AND (account_status=''active'' OR account_status IS NULL))';
  EXECUTE format(
   'CREATE POLICY cst_invoice_b3_ownerlock_%s ON public.portal_customers '||
   'FOR UPDATE TO %I USING (%s) WITH CHECK (false)',suffix,r,predicate);

  predicate:=format(
   '(CURRENT_USER=SESSION_USER AND company_id=%s AND is_active IS TRUE)',t);
  EXECUTE format(
   'CREATE POLICY cst_invoice_b3_ownerlock_%s ON public.portal_company_members '||
   'FOR UPDATE TO %I USING (%s) WITH CHECK (false)',suffix,r,predicate);

  predicate:=format(
   '(CURRENT_USER=SESSION_USER AND matched_company_id=%s '||
   'AND status=''approved'' AND reviewed_by IS NOT NULL '||
   'AND reviewed_by<>portal_customer_id AND reviewed_at IS NOT NULL '||
   'AND EXISTS(SELECT 1 FROM public.portal_customers issuer '||
      'WHERE issuer.id=portal_company_requests.portal_customer_id '||
      'AND issuer.role=''admin'' '||
      'AND (issuer.account_status=''active'' OR issuer.account_status IS NULL)) '||
   'AND EXISTS(SELECT 1 FROM public.portal_customers reviewer '||
      'WHERE reviewer.id=portal_company_requests.reviewed_by '||
      'AND reviewer.role=''admin'' '||
      'AND (reviewer.account_status=''active'' OR reviewer.account_status IS NULL)))',t);
  EXECUTE format(
   'CREATE POLICY cst_invoice_b3_ownerlock_%s ON public.portal_company_requests '||
   'FOR UPDATE TO %I USING (%s) WITH CHECK (false)',suffix,r,predicate);
 END LOOP;
END $policies$;

DO $post$
BEGIN
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public'
  AND policyname LIKE 'cst_invoice_b3_%')<>8 THEN
  RAISE EXCEPTION 'INVOICE_B3_POLICY_COUNT_MISMATCH';
 END IF;
 IF NOT has_column_privilege('bizportal_customer_invoice_cst_writer_dev',
  'public.users','updated_at','UPDATE')
 OR NOT has_column_privilege('bizportal_customer_invoice_diva_writer_dev',
  'public.portal_company_requests','updated_at','UPDATE')
 OR has_column_privilege('bizportal_customer_invoice_cst_writer_dev',
  'public.users','role','UPDATE')
 OR has_column_privilege('bizportal_customer_invoice_diva_writer_dev',
  'public.portal_customers','password_hash','SELECT') THEN
  RAISE EXCEPTION 'INVOICE_B3_AUTH_PERMISSION_MISMATCH';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN (
  'bizportal_customer_invoice_cst_writer_dev',
  'bizportal_customer_invoice_diva_writer_dev') AND rolcanlogin=true) THEN
  RAISE EXCEPTION 'INVOICE_B3_ROLE_LOGIN_NOT_ALLOWED';
 END IF;
END $post$;
