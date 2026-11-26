-- QA-only PG16 fixture: no live invoice, secret, PROD or CST-DEV DB.
CREATE ROLE bizportal_customer_invoice_cst_writer_dev LOGIN NOBYPASSRLS NOSUPERUSER NOINHERIT;
CREATE ROLE bizportal_customer_invoice_diva_writer_dev LOGIN NOBYPASSRLS NOSUPERUSER NOINHERIT;
CREATE TABLE public.accounting_entries(id int PRIMARY KEY,company_id int NOT NULL,
 source text NOT NULL,status text NOT NULL,source_id int NOT NULL);
INSERT INTO public.accounting_entries VALUES
 (101,1,'sales_invoice','posted',701),
 (303,3,'sales_invoice','posted',703);
CREATE TABLE public.audit_accounting_events(
 id bigserial PRIMARY KEY,journal_id int,action text NOT NULL,
 company_id int,amount numeric,user_id text,actor_type text NOT NULL,
 correlation_id text,change_reason text,after_state jsonb,
 created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.accounting_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_accounting_events ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA public TO
 bizportal_customer_invoice_cst_writer_dev,bizportal_customer_invoice_diva_writer_dev;
GRANT SELECT ON public.accounting_entries,public.audit_accounting_events TO
 bizportal_customer_invoice_cst_writer_dev,bizportal_customer_invoice_diva_writer_dev;
GRANT USAGE ON SEQUENCE public.audit_accounting_events_id_seq TO
 bizportal_customer_invoice_cst_writer_dev,bizportal_customer_invoice_diva_writer_dev;
GRANT INSERT(journal_id,action,company_id,amount,user_id,actor_type,correlation_id)
 ON public.audit_accounting_events TO
 bizportal_customer_invoice_cst_writer_dev,bizportal_customer_invoice_diva_writer_dev;
GRANT UPDATE(created_at) ON public.audit_accounting_events TO
 bizportal_customer_invoice_cst_writer_dev,bizportal_customer_invoice_diva_writer_dev;
CREATE POLICY qa_entry_read_cst ON public.accounting_entries FOR SELECT
 TO bizportal_customer_invoice_cst_writer_dev
 USING(current_user=session_user AND company_id=1);
CREATE POLICY qa_entry_read_diva ON public.accounting_entries FOR SELECT
 TO bizportal_customer_invoice_diva_writer_dev
 USING(current_user=session_user AND company_id=3);
CREATE POLICY cst_invoice_b1_guard_cst ON public.audit_accounting_events
 AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_cst_writer_dev
 USING(current_user=session_user AND company_id=1 AND action='SALES_INVOICE_ISSUED'
 AND correlation_id LIKE 'sales_invoice:1:%')
 WITH CHECK(current_user=session_user AND company_id=1 AND action='SALES_INVOICE_ISSUED'
 AND correlation_id LIKE 'sales_invoice:1:%');
CREATE POLICY cst_invoice_b1_guard_diva ON public.audit_accounting_events
 AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_diva_writer_dev
 USING(current_user=session_user AND company_id=3 AND action='SALES_INVOICE_ISSUED'
 AND correlation_id LIKE 'sales_invoice:3:%')
 WITH CHECK(current_user=session_user AND company_id=3 AND action='SALES_INVOICE_ISSUED'
 AND correlation_id LIKE 'sales_invoice:3:%');
CREATE POLICY cst_invoice_b4_insert_cst ON public.audit_accounting_events
 FOR INSERT TO bizportal_customer_invoice_cst_writer_dev
 WITH CHECK(current_user=session_user AND company_id=1 AND action='SALES_INVOICE_ISSUED'
 AND EXISTS(SELECT 1 FROM public.accounting_entries e
 WHERE e.id=journal_id AND e.company_id=1 AND e.source='sales_invoice'
 AND e.status='posted' AND correlation_id=
 'sales_invoice:1:'||e.source_id::text||':'||e.id::text));
CREATE POLICY cst_invoice_b4_insert_diva ON public.audit_accounting_events
 FOR INSERT TO bizportal_customer_invoice_diva_writer_dev
 WITH CHECK(current_user=session_user AND company_id=3 AND action='SALES_INVOICE_ISSUED'
 AND EXISTS(SELECT 1 FROM public.accounting_entries e
 WHERE e.id=journal_id AND e.company_id=3 AND e.source='sales_invoice'
 AND e.status='posted' AND correlation_id=
 'sales_invoice:3:'||e.source_id::text||':'||e.id::text));
CREATE POLICY qa_audit_read_cst ON public.audit_accounting_events FOR SELECT
 TO bizportal_customer_invoice_cst_writer_dev
 USING(current_user=session_user AND company_id=1);
CREATE POLICY qa_audit_read_diva ON public.audit_accounting_events FOR SELECT
 TO bizportal_customer_invoice_diva_writer_dev
 USING(current_user=session_user AND company_id=3);
