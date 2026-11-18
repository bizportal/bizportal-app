-- DEV-only disposable PostgreSQL QA for PR214 approval locks, under the
-- two direct company-scoped writer roles from BizPortal PR150.
DO $guard$ BEGIN
  IF current_database() <> 'invoice_synthetic' THEN
    RAISE EXCEPTION 'DISPOSABLE_ONLY';
  END IF;
END $guard$;
ALTER TABLE public.portal_company_members
 ADD COLUMN updated_at timestamptz DEFAULT now();
CREATE TABLE public.portal_company_requests(
 id serial PRIMARY KEY,portal_customer_id integer NOT NULL,
 matched_company_id integer,status text NOT NULL,
 reviewed_by integer, reviewed_at timestamptz,updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.portal_company_requests ENABLE ROW LEVEL SECURITY;
INSERT INTO public.portal_customers(id,name,email,role,account_status)
VALUES (21,'QA Independent Reviewer','qa.review@example.invalid','admin','active');
INSERT INTO public.portal_company_members(portal_customer_id,company_id,is_active)
VALUES (20,1,true),(20,3,true);
INSERT INTO public.portal_company_requests
 (portal_customer_id,matched_company_id,status,reviewed_by,reviewed_at)
VALUES (20,1,'approved',21,now()),(20,3,'approved',21,now());

-- Column grants only: SELECT FOR SHARE needs a narrow UPDATE column grant.
-- RLS permits the lock but forbids actual UPDATE via WITH CHECK(false).
GRANT SELECT(id,portal_customer_id,matched_company_id,status,reviewed_by,reviewed_at)
 ON public.portal_company_requests TO
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;
GRANT UPDATE(updated_at) ON public.portal_company_requests,
 public.portal_company_members TO
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;
GRANT UPDATE(status_changed_at) ON public.portal_customers TO
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;
DO $policies$
DECLARE role_name name; tenant int; pred text;
BEGIN
 FOR role_name,tenant IN SELECT * FROM (VALUES
  ('bizportal_customer_invoice_cst_writer_dev'::name,1),
  ('bizportal_customer_invoice_diva_writer_dev'::name,3)) x(role_name,tenant) LOOP
  pred:=format('(CURRENT_USER=SESSION_USER AND matched_company_id=%s'
      || ' AND portal_customer_id=20 AND status=''approved'' AND reviewed_by=21'
      || ' AND reviewed_at IS NOT NULL)',tenant);
  EXECUTE format('CREATE POLICY qa_invoice_scope_approval_%s_select ON public.portal_company_requests FOR SELECT TO %I USING (%s)',tenant,role_name,pred);
  EXECUTE format('CREATE POLICY qa_invoice_scope_approval_%s_lock ON public.portal_company_requests FOR UPDATE TO %I USING (%s) WITH CHECK(false)',tenant,role_name,pred);
  pred:=format('(CURRENT_USER=SESSION_USER AND company_id=%s'
    || ' AND portal_customer_id=20 AND is_active IS TRUE)',tenant);
  EXECUTE format('CREATE POLICY qa_invoice_scope_member_%s_lock ON public.portal_company_members FOR UPDATE TO %I USING (%s) WITH CHECK(false)',tenant,role_name,pred);
  pred:='(CURRENT_USER=SESSION_USER AND id IN(20,21) AND role=''admin'' AND account_status=''active'')';
  EXECUTE format('CREATE POLICY qa_invoice_scope_admin_%s_lock ON public.portal_customers FOR UPDATE TO %I USING (%s) WITH CHECK(false)',tenant,role_name,pred);
 END LOOP;
END $policies$;
