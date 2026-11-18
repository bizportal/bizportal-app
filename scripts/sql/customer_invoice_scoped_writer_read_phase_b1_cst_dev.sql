-- CST-DEV Customer Invoice Phase B1: company-scoped read-only source visibility.
-- No LOGIN/password, no INSERT/UPDATE/DELETE, no active AR actor.
-- This migration is safe only while Phase A/A2 roles are NOLOGIN and disabled.
DO $preflight$
DECLARE t text; rls_on bool; n int;
BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres' THEN
   RAISE EXCEPTION 'INVOICE_B1_WRONG_DATABASE_OR_ACTOR';
 END IF;
 SELECT count(*) INTO n FROM pg_roles
 WHERE rolname IN('bizportal_customer_invoice_cst_writer_dev',
                  'bizportal_customer_invoice_diva_writer_dev')
 AND rolcanlogin=false AND rolinherit=false AND rolbypassrls=false
 AND rolsuper=false AND rolcreaterole=false AND rolcreatedb=false;
 IF n<>2 THEN RAISE EXCEPTION 'INVOICE_B1_REQUIRES_TWO_DORMANT_ROLES'; END IF;
 SELECT count(*) INTO n FROM public.bizportal_customer_ar_source_actors_dev
 WHERE (role_name::text,company_id) IN (
   ('bizportal_customer_invoice_cst_writer_dev',1),
   ('bizportal_customer_invoice_diva_writer_dev',3))
 AND enabled=false AND verified_source LIKE 'CST-DEV Invoice scoped writer Phase A2:%';
 IF n<>2 THEN RAISE EXCEPTION 'INVOICE_B1_ACTORS_NOT_DISABLED'; END IF;
 IF EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public'
   AND policyname LIKE 'cst_invoice_b1_%') THEN
   RAISE EXCEPTION 'INVOICE_B1_ALREADY_APPLIED_OR_CONFLICT';
 END IF;
 FOREACH t IN ARRAY ARRAY[
  'sales_documents','sales_document_lines','accounting_entries',
  'accounting_entry_lines','ar_subledger','accounting_settings',
  'accounting_journals','chart_of_accounts','accounting_taxes',
  'transaction_taxes','ledger_events','financial_outbox_events',
  'audit_accounting_events','journal_sequences','financial_periods',
  'companies','bizportal_customer_ar_source_actors_dev'] LOOP
   SELECT c.relrowsecurity INTO rls_on FROM pg_class c
   JOIN pg_namespace ns ON ns.oid=c.relnamespace
   WHERE ns.nspname='public' AND c.relname=t AND c.relkind='r';
   IF rls_on IS DISTINCT FROM true THEN
     RAISE EXCEPTION 'INVOICE_B1_RLS_BASELINE_MISSING: %',t;
   END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace ns
   ON ns.oid=c.relnamespace WHERE ns.nspname='public'
   AND c.relname='bizportal_customer_ar_source_evidence_dev'
   AND c.relkind='v' AND 'security_invoker=true'=ANY(c.reloptions)
   AND 'security_barrier=true'=ANY(c.reloptions)) THEN
   RAISE EXCEPTION 'INVOICE_B1_REVIEWED_INVOCER_VIEW_MISSING';
 END IF;
END $preflight$;

GRANT USAGE ON SCHEMA public
 TO bizportal_customer_invoice_cst_writer_dev,
    bizportal_customer_invoice_diva_writer_dev;
-- Specific SELECT tables, no blanket schema privileges and no write GRANT.
GRANT SELECT ON
 public.sales_documents,public.sales_document_lines,
 public.accounting_entries,public.accounting_entry_lines,
 public.ar_subledger,public.accounting_settings,public.accounting_journals,
 public.chart_of_accounts,public.accounting_taxes,public.transaction_taxes,
 public.ledger_events,public.financial_outbox_events,
 public.audit_accounting_events,public.journal_sequences,
 public.financial_periods,public.companies,
 public.bizportal_customer_ar_source_actors_dev,
 public.bizportal_customer_ar_source_evidence_dev
 TO bizportal_customer_invoice_cst_writer_dev,
    bizportal_customer_invoice_diva_writer_dev;

DO $policies$
DECLARE
 role_name name;
 tenant int;
 tbl text;
 scope text;
 id_suffix text;
BEGIN
 FOR role_name,tenant IN SELECT * FROM (VALUES
  ('bizportal_customer_invoice_cst_writer_dev'::name,1),
  ('bizportal_customer_invoice_diva_writer_dev'::name,3)) x(role_name,tenant)
 LOOP
  id_suffix:=CASE WHEN tenant=1 THEN 'cst' ELSE 'diva' END;
  FOREACH tbl IN ARRAY ARRAY[
   'sales_documents','accounting_entries','ar_subledger',
   'accounting_settings','accounting_journals','chart_of_accounts',
   'accounting_taxes','transaction_taxes','ledger_events',
   'financial_outbox_events','audit_accounting_events',
   'journal_sequences','financial_periods'] LOOP
    scope:=format('(CURRENT_USER=SESSION_USER AND company_id=%s)',tenant);
    IF tbl='accounting_entries' THEN
      scope:=scope||' AND source::text=''sales_invoice''';
    ELSIF tbl='ar_subledger' THEN
      scope:=scope||' AND notes=''bizportal:customer-ar-source:v1''';
    ELSIF tbl='transaction_taxes' THEN
      scope:=scope||' AND transaction_type=''sales_invoice''';
    ELSIF tbl='ledger_events' THEN
      scope:=scope||' AND event_type=''POST'' AND EXISTS ('||
        'SELECT 1 FROM public.accounting_entries parent '||
        'WHERE parent.id=entry_id AND parent.company_id='||tenant||
        ' AND parent.source::text=''sales_invoice'')';
    ELSIF tbl='financial_outbox_events' THEN
      scope:=scope||' AND event_type=''JOURNAL_CREATED'' '||
        'AND payload->>''sourceType''=''sales_invoice'' AND EXISTS ('||
        'SELECT 1 FROM public.accounting_entries parent '||
        'WHERE parent.id=entry_id AND parent.company_id='||tenant||
        ' AND parent.source::text=''sales_invoice'')';
    ELSIF tbl='audit_accounting_events' THEN
      scope:=scope||' AND action=''SALES_INVOICE_ISSUED'' '||
        'AND correlation_id LIKE ''sales_invoice:'||tenant||':%''';
    END IF;
    EXECUTE format(
      'CREATE POLICY cst_invoice_b1_read_%s ON public.%I '||
      'AS PERMISSIVE FOR SELECT TO %I USING (%s)',
      id_suffix,tbl,role_name,scope
    );
    -- Restrictive ALL keeps future role grants or permissive policies from
    -- bypassing the fixed-company condition if this role later becomes LOGIN.
    EXECUTE format(
      'CREATE POLICY cst_invoice_b1_guard_%s ON public.%I '||
      'AS RESTRICTIVE FOR ALL TO %I USING (%s) WITH CHECK (%s)',
      id_suffix,tbl,role_name,scope,scope
    );
  END LOOP;
  scope:=format('(CURRENT_USER=SESSION_USER AND id=%s AND is_active IS TRUE)',tenant);
  EXECUTE format(
    'CREATE POLICY cst_invoice_b1_read_%s ON public.companies '||
    'FOR SELECT TO %I USING (%s)',id_suffix,role_name,scope
  );
  EXECUTE format(
    'CREATE POLICY cst_invoice_b1_guard_%s ON public.companies '||
    'AS RESTRICTIVE FOR ALL TO %I USING (%s) WITH CHECK (%s)',
    id_suffix,role_name,scope,scope
  );
  -- Read every line of an owned sales journal even if its explicit
  -- company_id is corrupt; the original invoker AR proof rejects it.
  scope:=format(
    '(CURRENT_USER=SESSION_USER AND EXISTS (SELECT 1 '||
    'FROM public.accounting_entries parent WHERE parent.id=entry_id '||
    'AND parent.company_id=%s AND parent.source::text=''sales_invoice''))',tenant);
  EXECUTE format(
    'CREATE POLICY cst_invoice_b1_read_%s ON public.accounting_entry_lines '||
    'FOR SELECT TO %I USING (%s)',id_suffix,role_name,scope
  );
  EXECUTE format(
    'CREATE POLICY cst_invoice_b1_guard_%s ON public.accounting_entry_lines '||
    'AS RESTRICTIVE FOR ALL TO %I USING (%s) WITH CHECK (%s)',
    id_suffix,role_name,scope,scope
  );
  scope:=format(
    '(CURRENT_USER=SESSION_USER AND EXISTS (SELECT 1 '||
    'FROM public.sales_documents source WHERE source.id=document_id '||
    'AND source.company_id=%s))',tenant);
  EXECUTE format(
    'CREATE POLICY cst_invoice_b1_read_%s ON public.sales_document_lines '||
    'FOR SELECT TO %I USING (%s)',id_suffix,role_name,scope
  );
  EXECUTE format(
    'CREATE POLICY cst_invoice_b1_guard_%s ON public.sales_document_lines '||
    'AS RESTRICTIVE FOR ALL TO %I USING (%s) WITH CHECK (%s)',
    id_suffix,role_name,scope,scope
  );
  scope:=format(
    '(CURRENT_USER=SESSION_USER AND role_name=SESSION_USER AND company_id=%s)',tenant);
  EXECUTE format(
    'CREATE POLICY cst_invoice_b1_read_%s '||
    'ON public.bizportal_customer_ar_source_actors_dev '||
    'FOR SELECT TO %I USING (%s)',id_suffix,role_name,scope
  );
  EXECUTE format(
    'CREATE POLICY cst_invoice_b1_guard_%s '||
    'ON public.bizportal_customer_ar_source_actors_dev '||
    'AS RESTRICTIVE FOR ALL TO %I USING (%s) WITH CHECK (%s)',
    id_suffix,role_name,scope,scope
  );
 END LOOP;
END $policies$;

-- Postcondition only: registration remains dormant, none of these roles can
-- write financial data; no existing actor or original policy was modified.
DO $postcondition$
DECLARE n int;
BEGIN
 SELECT count(*) INTO n FROM pg_roles
 WHERE rolname IN('bizportal_customer_invoice_cst_writer_dev',
                  'bizportal_customer_invoice_diva_writer_dev')
 AND rolcanlogin=false AND rolbypassrls=false AND rolinherit=false;
 IF n<>2 THEN RAISE EXCEPTION 'INVOICE_B1_ROLE_BECAME_ACTIVE'; END IF;
 SELECT count(*) INTO n FROM pg_policies
 WHERE schemaname='public' AND policyname LIKE 'cst_invoice_b1_%';
 IF n<>68 THEN
   RAISE EXCEPTION 'INVOICE_B1_UNEXPECTED_POLICY_COUNT %',n;
 END IF;
 IF has_table_privilege('bizportal_customer_invoice_cst_writer_dev',
                       'public.accounting_entries','INSERT')
  OR has_table_privilege('bizportal_customer_invoice_diva_writer_dev',
                       'public.accounting_entries','INSERT')
  OR has_table_privilege('bizportal_customer_invoice_cst_writer_dev',
                       'public.sales_documents','UPDATE')
  OR has_table_privilege('bizportal_customer_invoice_diva_writer_dev',
                       'public.transaction_taxes','INSERT') THEN
   RAISE EXCEPTION 'INVOICE_B1_UNEXPECTED_FINANCIAL_WRITE_GRANT';
 END IF;
END $postcondition$;
