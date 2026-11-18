-- This deliberately mirrors the missing PRIVILEGES of the original
-- Customer Portal handler, ONLY inside the disposable invoice_synthetic DB.
DO $guard$ BEGIN
 IF current_database() <> 'invoice_synthetic' THEN RAISE EXCEPTION 'DISPOSABLE_ONLY'; END IF;
END $guard$;
CREATE TABLE public.users (
 id text primary key, email text, role text, system_role text,status text,
 is_active bool,company_id int,updated_at timestamptz default now()
);
INSERT INTO public.users(id,email,role,system_role,status,is_active,company_id)
VALUES ('qa-admin-global','qa-superadmin@example.invalid','super_admin',
 'super_admin','active',true,null);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
GRANT SELECT(id,email,role,system_role,status,is_active,company_id)
 ON public.users TO bizportal_customer_invoice_cst_writer_dev,
 bizportal_customer_invoice_diva_writer_dev;
-- FOR SHARE requires an UPDATE privilege, but the RLS WITH CHECK false
-- forbids any actual mutation of a user row.
GRANT UPDATE(updated_at) ON public.users TO
 bizportal_customer_invoice_cst_writer_dev,
 bizportal_customer_invoice_diva_writer_dev;
DO $guard$
DECLARE role_name name; tenant int; pred text;
BEGIN
 FOR role_name,tenant IN SELECT * FROM (VALUES
 ('bizportal_customer_invoice_cst_writer_dev'::name,1),
 ('bizportal_customer_invoice_diva_writer_dev'::name,3)) x(role_name,tenant) LOOP
 pred:=format('(CURRENT_USER=SESSION_USER AND role=''super_admin'' AND system_role=''super_admin'' AND status=''active'' AND is_active IS TRUE AND (company_id IS NULL OR company_id=%s))',tenant);
 EXECUTE format('CREATE POLICY qa_owner_%s_select ON public.users FOR SELECT TO %I USING (%s)',tenant,role_name,pred);
 EXECUTE format('CREATE POLICY qa_owner_%s_update_lock ON public.users FOR UPDATE TO %I USING (%s) WITH CHECK (false)',tenant,role_name,pred);
 END LOOP;
END $guard$;
CREATE TABLE public.portal_company_members(
 id serial primary key,portal_customer_id int,company_id int,is_active bool not null default true
);
CREATE TABLE public.portal_customer_notifications(
 id serial primary key,portal_customer_id int not null,event_key text not null,
 type text not null,title text not null,message text not null,payload jsonb not null default '{}'::jsonb
);
CREATE UNIQUE INDEX qa_notification_event_unique
 ON public.portal_customer_notifications(portal_customer_id,event_key);
CREATE TABLE public.activity_logs (
 id serial primary key,actor_type text not null,actor_id text,actor_name text,
 action text not null,old_value jsonb,new_value jsonb,
 description text,deduplication_key text,created_at timestamptz default now()
);
CREATE UNIQUE INDEX qa_invoice_activity_dedupe ON public.activity_logs(deduplication_key)
 WHERE deduplication_key IS NOT NULL;
INSERT INTO public.portal_customers(id,name,email,role,account_status)
VALUES
 (11,'QA Customer CST','customer.cst@example.invalid','customer','active'),
 (13,'QA Customer DIVA','customer.diva@example.invalid','customer','active'),
 (20,'QA Portal Admin','qa.portal.admin@example.invalid','admin','active');
INSERT INTO public.portal_company_members(portal_customer_id,company_id,is_active)
VALUES (11,1,true),(13,3,true);
DO $guard$
DECLARE tbl text;
BEGIN
 FOREACH tbl IN ARRAY ARRAY[
 'portal_customers','portal_company_members',
 'portal_customer_notifications','activity_logs'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tbl);
 END LOOP;
END $guard$;
GRANT SELECT(id,role,account_status) ON public.portal_customers TO
 bizportal_customer_invoice_cst_writer_dev,bizportal_customer_invoice_diva_writer_dev;
GRANT SELECT(portal_customer_id,company_id,is_active) ON public.portal_company_members TO
 bizportal_customer_invoice_cst_writer_dev,bizportal_customer_invoice_diva_writer_dev;
GRANT INSERT(actor_type,actor_id,actor_name,action,old_value,new_value,description,deduplication_key)
 ON public.activity_logs TO bizportal_customer_invoice_cst_writer_dev,
 bizportal_customer_invoice_diva_writer_dev;
GRANT INSERT(portal_customer_id,event_key,type,title,message,payload)
 ON public.portal_customer_notifications TO bizportal_customer_invoice_cst_writer_dev,
 bizportal_customer_invoice_diva_writer_dev;
GRANT USAGE ON SEQUENCE public.activity_logs_id_seq,public.portal_customer_notifications_id_seq TO
 bizportal_customer_invoice_cst_writer_dev,bizportal_customer_invoice_diva_writer_dev;
DO $guard$
DECLARE role_name name; tenant int; scope text;
BEGIN
 FOR role_name,tenant IN SELECT * FROM (VALUES
 ('bizportal_customer_invoice_cst_writer_dev'::name,1),
 ('bizportal_customer_invoice_diva_writer_dev'::name,3)) x(role_name,tenant) LOOP
 scope:=format('(CURRENT_USER=SESSION_USER AND company_id=%s)',tenant);
 EXECUTE format('CREATE POLICY qa_member_%s_select ON public.portal_company_members FOR SELECT TO %I USING (%s)',tenant,role_name,scope);
 EXECUTE format($sql$
 CREATE POLICY qa_customer_%s_select ON public.portal_customers FOR SELECT TO %I
 USING (CURRENT_USER=SESSION_USER AND (
 role='admin' OR EXISTS (
 SELECT 1 FROM public.portal_company_members pcm WHERE pcm.portal_customer_id=portal_customers.id
 AND pcm.company_id=%s AND pcm.is_active IS TRUE)))
 $sql$,tenant,role_name,tenant);
 EXECUTE format($sql$
 CREATE POLICY qa_activity_%s_insert ON public.activity_logs FOR INSERT TO %I
 WITH CHECK (
  CURRENT_USER=SESSION_USER AND actor_type='admin'
  AND action='sales_invoice_issued'
  AND EXISTS (
   SELECT 1 FROM public.sales_documents s
   WHERE s.company_id=%s
   AND deduplication_key='sales-invoice-issued:'||s.id::text
   AND s.invoice_status::text='invoiced'
  )
 ) $sql$,tenant,role_name,tenant);
 EXECUTE format($sql$
 CREATE POLICY qa_notify_%s_insert ON public.portal_customer_notifications FOR INSERT TO %I
 WITH CHECK(
  CURRENT_USER=SESSION_USER AND type='sales_invoice_issued'
  AND EXISTS (
   SELECT 1 FROM public.sales_documents s
   WHERE s.company_id=%s
     AND event_key='sales-invoice:'||s.id::text||':invoiced'
     AND (payload->>'invoiceId')::int=s.id
  )
  AND EXISTS (
   SELECT 1 FROM public.portal_customers pc WHERE pc.id=portal_customer_id
    AND (pc.role='admin' OR EXISTS(
     SELECT 1 FROM public.portal_company_members pcm
     WHERE pcm.portal_customer_id=pc.id AND pcm.company_id=%s AND pcm.is_active IS TRUE
    ))
  )
 ) $sql$,tenant,role_name,tenant,tenant);
 END LOOP;
END $guard$;
-- ON CONFLICT partial index predicate needs scoped read of dedupe keys.
GRANT SELECT(deduplication_key) ON public.activity_logs TO
 bizportal_customer_invoice_cst_writer_dev,
 bizportal_customer_invoice_diva_writer_dev;
GRANT SELECT(portal_customer_id,event_key) ON public.portal_customer_notifications TO
 bizportal_customer_invoice_cst_writer_dev,
 bizportal_customer_invoice_diva_writer_dev;
DO $guard$
DECLARE role_name name;tenant int;pred text;
BEGIN
 FOR role_name,tenant IN SELECT * FROM (VALUES
 ('bizportal_customer_invoice_cst_writer_dev'::name,1),
 ('bizportal_customer_invoice_diva_writer_dev'::name,3)) x(r,c) LOOP
 pred:=format('(CURRENT_USER=SESSION_USER AND EXISTS(SELECT 1 FROM public.sales_documents s WHERE s.company_id=%s AND deduplication_key=''sales-invoice-issued:''||s.id::text))',tenant);
 EXECUTE format('CREATE POLICY qa_activity_%s_read ON public.activity_logs FOR SELECT TO %I USING(%s)',tenant,role_name,pred);
 pred:=format('(CURRENT_USER=SESSION_USER AND EXISTS(SELECT 1 FROM public.sales_documents s WHERE s.company_id=%s AND event_key=''sales-invoice:''||s.id::text||'':invoiced''))',tenant);
 EXECUTE format('CREATE POLICY qa_notify_%s_read ON public.portal_customer_notifications FOR SELECT TO %I USING(%s)',tenant,role_name,pred);
 END LOOP;
END $guard$;
