-- Disposable PostgreSQL16 only. Minimal shapes matching CST-DEV B1 policy columns.
DO $guard$ BEGIN
 IF current_database()<>'postgres' THEN RAISE EXCEPTION 'B1_DISPOSABLE_DB_ONLY'; END IF;
END $guard$;
CREATE ROLE bizportal_customer_invoice_cst_writer_dev
 NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE bizportal_customer_invoice_diva_writer_dev
 NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE TABLE public.companies (id int primary key,is_active bool NOT NULL);
CREATE TABLE public.sales_documents(id int primary key,company_id int NOT NULL,invoice_status text);
CREATE TABLE public.sales_document_lines(id int primary key,document_id int NOT NULL);
CREATE TABLE public.accounting_entries(id int primary key,company_id int NOT NULL,source text NOT NULL);
CREATE TABLE public.accounting_entry_lines(id int primary key,entry_id int NOT NULL,company_id int);
CREATE TABLE public.ar_subledger(id int primary key,company_id int NOT NULL,invoice_id int,notes text);
CREATE TABLE public.accounting_settings(id int primary key,company_id int NOT NULL);
CREATE TABLE public.accounting_journals(id int primary key,company_id int NOT NULL);
CREATE TABLE public.chart_of_accounts(id int primary key,company_id int NOT NULL);
CREATE TABLE public.accounting_taxes(id int primary key,company_id int NOT NULL);
CREATE TABLE public.transaction_taxes(id int primary key,company_id int NOT NULL,transaction_type text);
CREATE TABLE public.ledger_events(id int primary key,company_id int,entry_id int,event_type text);
CREATE TABLE public.financial_outbox_events(id int primary key,company_id int,entry_id int,event_type text,payload jsonb);
CREATE TABLE public.audit_accounting_events(id int primary key,company_id int,action text,correlation_id text);
CREATE TABLE public.journal_sequences(company_id int NOT NULL,journal_prefix text NOT NULL);
CREATE TABLE public.financial_periods(id int primary key,company_id int NOT NULL);
CREATE TABLE public.bizportal_customer_ar_source_actors_dev
(role_name name NOT NULL,company_id int NOT NULL,enabled bool NOT NULL,
 verified_source text NOT NULL,PRIMARY KEY(role_name,company_id));
CREATE VIEW public.bizportal_customer_ar_source_evidence_dev
 WITH (security_invoker=true,security_barrier=true) AS
 SELECT sd.id AS invoice_id,sd.company_id
 FROM public.sales_documents sd
 JOIN public.accounting_entries e
  ON e.company_id=sd.company_id AND e.id=(sd.id*10+1) AND e.source='sales_invoice';

INSERT INTO public.companies VALUES (1,true),(3,true);
INSERT INTO public.sales_documents VALUES (101,1,'invoiced'),(303,3,'invoiced');
INSERT INTO public.sales_document_lines VALUES (201,101),(203,303);
INSERT INTO public.accounting_entries VALUES
 (1011,1,'sales_invoice'),(1012,1,'payroll'),(3031,3,'sales_invoice');
INSERT INTO public.accounting_entry_lines VALUES
 (1,1011,1),(2,1011,3),(3,3031,3),(4,1012,1);
INSERT INTO public.ar_subledger VALUES
 (1,1,101,'bizportal:customer-ar-source:v1'),
 (3,3,303,'bizportal:customer-ar-source:v1'),
 (4,1,101,'other-source');
INSERT INTO public.accounting_settings VALUES(1,1),(3,3);
INSERT INTO public.accounting_journals VALUES(1,1),(3,3);
INSERT INTO public.chart_of_accounts VALUES(1,1),(3,3);
INSERT INTO public.accounting_taxes VALUES(1,1),(3,3);
INSERT INTO public.transaction_taxes VALUES(1,1,'sales_invoice'),(2,3,'sales_invoice'),(3,1,'vendor_invoice');
INSERT INTO public.ledger_events VALUES (1,1,1011,'POST'),(3,3,3031,'POST'),(4,1,1012,'POST');
INSERT INTO public.financial_outbox_events VALUES
 (1,1,1011,'JOURNAL_CREATED','{"sourceType":"sales_invoice"}'),
 (3,3,3031,'JOURNAL_CREATED','{"sourceType":"sales_invoice"}'),
 (4,1,1012,'JOURNAL_CREATED','{"sourceType":"payroll"}');
INSERT INTO public.audit_accounting_events VALUES
 (1,1,'SALES_INVOICE_ISSUED','sales_invoice:1:101:1011'),
 (3,3,'SALES_INVOICE_ISSUED','sales_invoice:3:303:3031'),
 (4,1,'OTHER_AUDIT','other:key');
INSERT INTO public.journal_sequences VALUES(1,'INV'),(3,'INV');
INSERT INTO public.financial_periods VALUES(1,1),(3,3);
INSERT INTO public.bizportal_customer_ar_source_actors_dev VALUES
 ('bizportal_customer_invoice_cst_writer_dev',1,false,'CST-DEV Invoice scoped writer Phase A2: dormant'),
 ('bizportal_customer_invoice_diva_writer_dev',3,false,'CST-DEV Invoice scoped writer Phase A2: dormant');
DO $rls$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['companies','sales_documents','sales_document_lines',
 'accounting_entries','accounting_entry_lines','ar_subledger','accounting_settings',
 'accounting_journals','chart_of_accounts','accounting_taxes','transaction_taxes',
 'ledger_events','financial_outbox_events','audit_accounting_events',
 'journal_sequences','financial_periods','bizportal_customer_ar_source_actors_dev'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
 END LOOP;
END $rls$;
