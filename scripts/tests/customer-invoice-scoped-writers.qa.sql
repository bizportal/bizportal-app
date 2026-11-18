-- Disposable QA ONLY. No hosted Supabase/PROD execution.
DO $qa$ BEGIN
 IF current_database() <> 'invoice_synthetic' THEN RAISE EXCEPTION 'DISPOSABLE_ONLY'; END IF;
END $qa$;
-- The canonical disposable fixture does not include the Portal-specific audit table.
CREATE TABLE public.audit_accounting_events (
 id bigserial primary key,company_id integer not null,entry_id integer,source text
);
CREATE ROLE bizportal_customer_invoice_cst_writer_dev
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD 'local-qa-cst-only';
CREATE ROLE bizportal_customer_invoice_diva_writer_dev
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD 'local-qa-diva-only';
GRANT CONNECT ON DATABASE invoice_synthetic TO
  bizportal_customer_invoice_cst_writer_dev,bizportal_customer_invoice_diva_writer_dev;
GRANT USAGE ON SCHEMA public TO
  bizportal_customer_invoice_cst_writer_dev,bizportal_customer_invoice_diva_writer_dev;
-- No schema-wide table grant and no membership in postgres/Finance roles.
DO $qa$
DECLARE tbl text; role_name name; tenant integer; scope text;
BEGIN
 FOREACH tbl IN ARRAY ARRAY[
  'sales_documents','accounting_entries','ar_subledger',
  'accounting_settings','accounting_journals','chart_of_accounts',
  'accounting_taxes','transaction_taxes','ledger_events',
  'financial_outbox_events','audit_accounting_events',
  'journal_sequences','financial_periods'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tbl);
  FOR role_name,tenant IN
   SELECT * FROM (VALUES
    ('bizportal_customer_invoice_cst_writer_dev'::name,1),
    ('bizportal_customer_invoice_diva_writer_dev'::name,3)) as x(r,c) LOOP
   scope := format('(CURRENT_USER = SESSION_USER AND company_id = %s)',tenant);
   EXECUTE format('CREATE POLICY qa_invoice_%s_scope ON public.%I FOR SELECT TO %I USING (%s)',
     tenant,tbl,role_name,scope);
  END LOOP;
 END LOOP;
END $qa$;

-- Explicit table grants, not default privileges. Direct sessions are independent.
GRANT SELECT ON public.sales_documents,public.sales_document_lines,
 public.companies,public.accounting_entries,public.accounting_entry_lines,
 public.accounting_settings,public.accounting_journals,public.chart_of_accounts,
 public.accounting_taxes,public.ar_subledger,public.transaction_taxes,
 public.ledger_events,public.financial_outbox_events,
 public.audit_accounting_events,public.journal_sequences,public.financial_periods,
 public.bizportal_customer_ar_source_actors_dev,
 public.bizportal_customer_ar_source_evidence_dev
 TO bizportal_customer_invoice_cst_writer_dev,bizportal_customer_invoice_diva_writer_dev;
GRANT UPDATE (updated_at,invoice_status,invoice_number,invoice_date,due_date)
 ON public.sales_documents TO
 bizportal_customer_invoice_cst_writer_dev,bizportal_customer_invoice_diva_writer_dev;
GRANT INSERT,UPDATE ON public.accounting_entries TO
 bizportal_customer_invoice_cst_writer_dev,bizportal_customer_invoice_diva_writer_dev;
GRANT INSERT,UPDATE ON public.accounting_entry_lines TO
 bizportal_customer_invoice_cst_writer_dev,bizportal_customer_invoice_diva_writer_dev;
GRANT INSERT,UPDATE ON public.ar_subledger TO
 bizportal_customer_invoice_cst_writer_dev,bizportal_customer_invoice_diva_writer_dev;
GRANT INSERT ON public.transaction_taxes,public.ledger_events,
 public.financial_outbox_events,public.audit_accounting_events TO
 bizportal_customer_invoice_cst_writer_dev,bizportal_customer_invoice_diva_writer_dev;
GRANT INSERT,UPDATE ON public.journal_sequences TO
 bizportal_customer_invoice_cst_writer_dev,bizportal_customer_invoice_diva_writer_dev;
-- Grant only serial/identity sequences associated with the named write set.
DO $qa$
DECLARE tbl text; colname text; seq text;
BEGIN
 FOREACH tbl IN ARRAY ARRAY[
  'accounting_entries','accounting_entry_lines','ar_subledger',
  'transaction_taxes','ledger_events','financial_outbox_events',
  'audit_accounting_events','journal_sequences'] LOOP
  FOR colname IN SELECT column_name FROM information_schema.columns
   WHERE table_schema='public' AND table_name=tbl LOOP
   seq:=pg_get_serial_sequence(format('public.%I',tbl),colname);
   IF seq IS NOT NULL THEN
    EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE %s TO %I,%I',
      seq,'bizportal_customer_invoice_cst_writer_dev',
      'bizportal_customer_invoice_diva_writer_dev');
   END IF;
  END LOOP;
 END LOOP;
END $qa$;

-- Write policies are narrower than SELECT visibility (journal source-specific).
DO $qa$
DECLARE tbl text; role_name name; tenant integer; scope text; predicate text; insert_predicate text;
BEGIN
 FOR role_name,tenant IN SELECT * FROM (VALUES
  ('bizportal_customer_invoice_cst_writer_dev'::name,1),
  ('bizportal_customer_invoice_diva_writer_dev'::name,3)) x(r,c) LOOP
  scope := format('(CURRENT_USER=SESSION_USER AND company_id=%s)',tenant);
  FOREACH tbl IN ARRAY ARRAY[
    'sales_documents','accounting_entries','ar_subledger',
    'transaction_taxes','ledger_events','financial_outbox_events',
    'audit_accounting_events','journal_sequences'] LOOP
   predicate:=scope;
   IF tbl='accounting_entries' THEN
    predicate:=scope || ' AND source::text=''sales_invoice''';
   ELSIF tbl='transaction_taxes' THEN
    predicate:=scope || ' AND transaction_type=''sales_invoice''';
   ELSIF tbl='ledger_events' THEN
    predicate:=scope || ' AND event_type=''POST''';
   ELSIF tbl='financial_outbox_events' THEN
    predicate:=scope || ' AND event_type=''JOURNAL_CREATED''';
   ELSIF tbl='ar_subledger' THEN
    predicate:=scope || ' AND notes=''bizportal:customer-ar-source:v1''';
   END IF;
   insert_predicate:=predicate;
   IF tbl='ar_subledger' THEN
    -- Only the existing posted-journal security-invoker view may authorize AR.
    insert_predicate:=predicate ||
      ' AND EXISTS (SELECT 1 FROM public.bizportal_customer_ar_source_evidence_dev e' ||
      ' WHERE e.company_id=ar_subledger.company_id' ||
      ' AND e.invoice_id=ar_subledger.invoice_id' ||
      ' AND e.gl_entry_id=ar_subledger.gl_entry_id' ||
      ' AND e.gross_amount=ar_subledger.gross_amount' ||
      ' AND e.outstanding_amount=ar_subledger.outstanding_amount' ||
      ' AND e.invoice_number=ar_subledger.invoice_number)';
   END IF;
   IF tbl<>'sales_documents' THEN
    EXECUTE format('CREATE POLICY qa_invoice_%s_insert ON public.%I FOR INSERT TO %I WITH CHECK (%s)',
      tenant,tbl,role_name,insert_predicate);
   END IF;
   IF tbl NOT IN ('transaction_taxes','ledger_events','financial_outbox_events','audit_accounting_events') THEN
    EXECUTE format('CREATE POLICY qa_invoice_%s_update ON public.%I FOR UPDATE TO %I USING (%s) WITH CHECK (%s)',
      tenant,tbl,role_name,predicate,predicate);
   END IF;
  END LOOP;
 END LOOP;
END $qa$;

-- Lines carry source ownership from the parent transaction, not caller GUC.
ALTER TABLE public.accounting_entry_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_document_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
DO $qa$
DECLARE role_name name; tenant integer; scope text; line_scope text; order_scope text;
BEGIN
 FOR role_name,tenant IN SELECT * FROM (VALUES
  ('bizportal_customer_invoice_cst_writer_dev'::name,1),
  ('bizportal_customer_invoice_diva_writer_dev'::name,3)) x(r,c) LOOP
  scope:=format('(CURRENT_USER=SESSION_USER AND id=%s)',tenant);
  EXECUTE format('CREATE POLICY qa_invoice_%s_company_read ON public.companies FOR SELECT TO %I USING (%s)',tenant,role_name,scope);
  line_scope:=format('(CURRENT_USER=SESSION_USER AND (company_id IS NULL OR company_id=%s) AND EXISTS (SELECT 1 FROM public.accounting_entries e WHERE e.id=entry_id AND e.company_id=%s AND e.source::text=''sales_invoice''))',tenant,tenant);
  EXECUTE format('CREATE POLICY qa_invoice_%s_lines_select ON public.accounting_entry_lines FOR SELECT TO %I USING (%s)',tenant,role_name,line_scope);
  EXECUTE format('CREATE POLICY qa_invoice_%s_lines_insert ON public.accounting_entry_lines FOR INSERT TO %I WITH CHECK (%s)',tenant,role_name,line_scope);
  EXECUTE format('CREATE POLICY qa_invoice_%s_lines_update ON public.accounting_entry_lines FOR UPDATE TO %I USING (%s) WITH CHECK (%s)',tenant,role_name,line_scope,line_scope);
  order_scope:=format('(CURRENT_USER=SESSION_USER AND EXISTS (SELECT 1 FROM public.sales_documents sd WHERE sd.id=document_id AND sd.company_id=%s))',tenant);
  EXECUTE format('CREATE POLICY qa_invoice_%s_order_lines_read ON public.sales_document_lines FOR SELECT TO %I USING (%s)',tenant,role_name,order_scope);
  EXECUTE format('CREATE POLICY qa_invoice_%s_actor_read ON public.bizportal_customer_ar_source_actors_dev FOR SELECT TO %I USING (CURRENT_USER=SESSION_USER AND role_name=SESSION_USER AND company_id=%s)',tenant,role_name,tenant);
 END LOOP;
END $qa$;
-- Existing source trigger remains unchanged. Its original actor allowlist is
-- extended ONLY inside this disposable DB, not on shared CST-DEV.
INSERT INTO public.bizportal_customer_ar_source_actors_dev
  (role_name,company_id,enabled,source_not_before,verified_source)
VALUES
 ('bizportal_customer_invoice_cst_writer_dev',1,true,
  clock_timestamp()-interval '1 day','Disposable QA actor CST'),
 ('bizportal_customer_invoice_diva_writer_dev',3,true,
  clock_timestamp()-interval '1 day','Disposable QA actor DIVA');
-- Source view security_invoker requires explicit per-role SELECT.

-- New sources; the reviewed canonical owner must post these through DIRECT
-- company logins after the original baseline completed.
INSERT INTO public.sales_documents
 (id,doc_number,kind,status,invoice_status,customer_name,total_amount,tax_amount,
  grand_total,company_id,invoice_number,invoice_date,due_date,tax_treatment,tax_rate_id)
VALUES
 (195,'QA-OWNER-SCOPED-195','order','confirmed','invoiced','Synthetic CST role',100,11,111,1,'QA-CST-195','2026-11-18','2026-12-18','exclusive',1),
 (197,'QA-OWNER-SCOPED-197','order','confirmed','invoiced','Synthetic DIVA role',100,11,111,3,'QA-DIVA-197','2026-11-18','2026-12-18','exclusive',3),
 (199,'QA-OWNER-SCOPED-199','order','confirmed','invoiced','Synthetic role rollback',100,11,111,1,'QA-CST-199','2026-11-18','2026-12-18','exclusive',1);
INSERT INTO public.sales_document_lines(document_id,name,quantity,unit_price,subtotal)
VALUES (195,'QA role CST service',1,100,100),
       (197,'QA role DIVA service',1,100,100),
       (199,'QA role rollback service',1,100,100);
