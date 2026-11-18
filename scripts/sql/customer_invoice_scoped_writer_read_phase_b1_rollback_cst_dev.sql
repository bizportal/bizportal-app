-- CST-DEV Customer Invoice Phase B1 rollback: read-only grants and RLS only.
-- Never use after enabling LOGIN, granting writes or starting Phase B2/C.
DO $preflight$
DECLARE n int;t text;
BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres' THEN
  RAISE EXCEPTION 'INVOICE_B1_ROLLBACK_WRONG_DATABASE_OR_ACTOR';
 END IF;
 SELECT count(*) INTO n FROM pg_roles
 WHERE rolname IN('bizportal_customer_invoice_cst_writer_dev',
                  'bizportal_customer_invoice_diva_writer_dev')
 AND rolcanlogin=false AND rolinherit=false AND rolbypassrls=false
 AND rolsuper=false AND rolcreaterole=false;
 IF n<>2 THEN RAISE EXCEPTION 'INVOICE_B1_ROLLBACK_REQUIRES_DORMANT_ROLES'; END IF;
 IF (SELECT count(*) FROM public.bizportal_customer_ar_source_actors_dev
   WHERE (role_name::text,company_id) IN (
    ('bizportal_customer_invoice_cst_writer_dev',1),
    ('bizportal_customer_invoice_diva_writer_dev',3))
   AND enabled=false
   AND verified_source LIKE 'CST-DEV Invoice scoped writer Phase A2:%')<>2 THEN
   RAISE EXCEPTION 'INVOICE_B1_ROLLBACK_ACTOR_NOT_DORMANT';
 END IF;
 SELECT count(*) INTO n FROM pg_policies
 WHERE schemaname='public' AND policyname LIKE 'cst_invoice_b1_%';
 IF n<>68 THEN
   RAISE EXCEPTION 'INVOICE_B1_ROLLBACK_INCOMPLETE_POLICIES %',n;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
   AND policyname LIKE 'cst_invoice_b2_%') THEN
   RAISE EXCEPTION 'INVOICE_B1_ROLLBACK_B2_ALREADY_STARTED';
 END IF;
 IF EXISTS (
   SELECT 1 FROM (VALUES
    ('sales_documents'),('accounting_entries'),('ar_subledger'),
    ('transaction_taxes'),('financial_outbox_events'),('audit_accounting_events')
   ) t(tbl)
   WHERE has_table_privilege('bizportal_customer_invoice_cst_writer_dev',
                            'public.'||t.tbl,'INSERT')
      OR has_table_privilege('bizportal_customer_invoice_diva_writer_dev',
                            'public.'||t.tbl,'INSERT')
      OR has_table_privilege('bizportal_customer_invoice_cst_writer_dev',
                            'public.'||t.tbl,'UPDATE')
      OR has_table_privilege('bizportal_customer_invoice_diva_writer_dev',
                            'public.'||t.tbl,'UPDATE')
 ) THEN
   RAISE EXCEPTION 'INVOICE_B1_ROLLBACK_FINANCIAL_WRITE_ACCESS_DETECTED';
 END IF;
END $preflight$;

DO $remove_policies$
DECLARE tab text; suffix text;
BEGIN
 FOREACH tab IN ARRAY ARRAY[
  'sales_documents','sales_document_lines','accounting_entries',
  'accounting_entry_lines','ar_subledger','accounting_settings',
  'accounting_journals','chart_of_accounts','accounting_taxes',
  'transaction_taxes','ledger_events','financial_outbox_events',
  'audit_accounting_events','journal_sequences','financial_periods',
  'companies','bizportal_customer_ar_source_actors_dev'] LOOP
  FOREACH suffix IN ARRAY ARRAY['cst','diva'] LOOP
   EXECUTE format('DROP POLICY cst_invoice_b1_read_%s ON public.%I',suffix,tab);
   EXECUTE format('DROP POLICY cst_invoice_b1_guard_%s ON public.%I',suffix,tab);
  END LOOP;
 END LOOP;
END $remove_policies$;

REVOKE SELECT ON
 public.sales_documents,public.sales_document_lines,
 public.accounting_entries,public.accounting_entry_lines,
 public.ar_subledger,public.accounting_settings,public.accounting_journals,
 public.chart_of_accounts,public.accounting_taxes,public.transaction_taxes,
 public.ledger_events,public.financial_outbox_events,
 public.audit_accounting_events,public.journal_sequences,
 public.financial_periods,public.companies,
 public.bizportal_customer_ar_source_actors_dev,
 public.bizportal_customer_ar_source_evidence_dev
 FROM bizportal_customer_invoice_cst_writer_dev,
      bizportal_customer_invoice_diva_writer_dev;
REVOKE USAGE ON SCHEMA public
 FROM bizportal_customer_invoice_cst_writer_dev,
      bizportal_customer_invoice_diva_writer_dev;

DO $postcondition$
DECLARE n int;
BEGIN
 SELECT count(*) INTO n FROM pg_policies WHERE schemaname='public'
 AND policyname LIKE 'cst_invoice_b1_%';
 IF n<>0 THEN RAISE EXCEPTION 'INVOICE_B1_ROLLBACK_POLICIES_REMAIN %',n; END IF;
 IF has_table_privilege('bizportal_customer_invoice_cst_writer_dev',
                        'public.accounting_entries','SELECT')
 OR has_table_privilege('bizportal_customer_invoice_diva_writer_dev',
                        'public.sales_documents','SELECT') THEN
  RAISE EXCEPTION 'INVOICE_B1_ROLLBACK_SELECT_GRANT_REMAINS';
 END IF;
END $postcondition$;
