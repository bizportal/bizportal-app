-- QA only: minimal missing Portal auth tables for full original
-- BizPortal ORM/PPN/AR disposable database. Never hosted CST-DEV.
DO $guard$ BEGIN
 IF current_database()<>'invoice_synthetic' THEN
  RAISE EXCEPTION 'INVOICE_B4_DISPOSABLE_ONLY';
 END IF;
END $guard$;
CREATE ROLE bizportal_customer_invoice_cst_writer_dev
 NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS NOREPLICATION;
CREATE ROLE bizportal_customer_invoice_diva_writer_dev
 NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS NOREPLICATION;
CREATE TABLE public.users(
 id text PRIMARY KEY,email text,role text,system_role text,status text,
 is_active boolean,company_id int,password_hash text,updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.portal_company_members(
 id serial PRIMARY KEY,portal_customer_id int,company_id int,
 is_active boolean NOT NULL,updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.portal_company_requests(
 id serial PRIMARY KEY,portal_customer_id int,matched_company_id int,
 status text,reviewed_by int,reviewed_at timestamptz,
 updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.activity_logs(
 id serial PRIMARY KEY,actor_type text,actor_id text,actor_name text,
 action text,old_value jsonb,new_value jsonb,description text,
 deduplication_key text
);
CREATE UNIQUE INDEX qa_activity_log_dedupe ON public.activity_logs(deduplication_key)
 WHERE deduplication_key IS NOT NULL;
CREATE TABLE public.portal_customer_notifications(
 id serial PRIMARY KEY,portal_customer_id int,event_key text,type text,
 title text,message text,payload jsonb
);
CREATE UNIQUE INDEX qa_portal_notification_dedupe
 ON public.portal_customer_notifications(portal_customer_id,event_key);
INSERT INTO public.users(id,email,role,system_role,status,is_active,company_id,password_hash)
VALUES
 ('qa-global-admin','qa.invoice.owner@example.invalid','super_admin','super_admin','active',true,NULL,'INACCESSIBLE'),
 ('qa-cst-owner','qa.cst.owner@example.invalid','super_admin','super_admin','active',true,1,'INACCESSIBLE'),
 ('qa-diva-owner','qa.diva.owner@example.invalid','super_admin','super_admin','active',true,3,'INACCESSIBLE');
INSERT INTO public.portal_customers(id,name,email,role,account_status)
VALUES (20,'QA Portal Issuer','qa.portal.issuer@example.invalid','admin','active'),
       (21,'QA Portal Reviewer','qa.portal.reviewer@example.invalid','admin','active'),
       (11,'QA CST Customer','qa.cst.customer@example.invalid','customer','active'),
       (13,'QA DIVA Customer','qa.diva.customer@example.invalid','customer','active');
INSERT INTO public.portal_company_members(portal_customer_id,company_id,is_active)
VALUES (20,1,true),(20,3,true),(11,1,true),(13,3,true);
INSERT INTO public.portal_company_requests(portal_customer_id,matched_company_id,
 status,reviewed_by,reviewed_at)
VALUES (20,1,'approved',21,now()),(20,3,'approved',21,now());
-- Existing AR source registry already contains original postgres and Finance.
-- Reserve our two synthetic direct writers but leave them disabled initially.
INSERT INTO public.bizportal_customer_ar_source_actors_dev(
 role_name,company_id,enabled,verified_source)
VALUES
 ('bizportal_customer_invoice_cst_writer_dev',1,false,
  'CST-DEV Invoice scoped writer Phase A2: QA dormant'),
 ('bizportal_customer_invoice_diva_writer_dev',3,false,
  'CST-DEV Invoice scoped writer Phase A2: QA dormant');
-- Portal audit is not part of the reviewed Accounting Owner's baseline
-- 86-table synthetic fixture; mirror only its existing hosted column contract.
CREATE TABLE public.audit_accounting_events(
  id bigserial PRIMARY KEY,
  journal_id integer,
  action text,
  company_id integer,
  amount numeric,
  user_id text,
  actor_type text,
  correlation_id text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_company_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_company_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_customer_notifications ENABLE ROW LEVEL SECURITY;
-- The ORM fixture already has the RLS columns used by the original handler.
-- The original generated schema's tables are RLS-disabled by default.
-- Apply the same per-table RLS baseline as deployed on CST-DEV, but here only.
DO $qa$
DECLARE tab text;
BEGIN
 IF current_database()<>'invoice_synthetic' THEN
  RAISE EXCEPTION 'B4_DISPOSABLE_ONLY';
 END IF;
 FOREACH tab IN ARRAY ARRAY[
  'companies','sales_documents','sales_document_lines','accounting_entries',
  'accounting_entry_lines','ar_subledger','accounting_settings',
  'accounting_journals','chart_of_accounts','accounting_taxes',
  'transaction_taxes','ledger_events','financial_outbox_events',
  'audit_accounting_events','journal_sequences','financial_periods',
  'bizportal_customer_ar_source_actors_dev','portal_customers'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tab);
 END LOOP;
END $qa$;
