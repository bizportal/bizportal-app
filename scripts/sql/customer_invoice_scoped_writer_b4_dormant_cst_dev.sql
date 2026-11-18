-- CST-DEV Customer Invoice B4: restricted financial WRITE capability staged
-- only for existing NOLOGIN, NOBYPASSRLS company1/CST and company3/Diva roles.
-- This does NOT activate login, AR source actors or any Portal flags.
DO $pre$
DECLARE n integer; tab text;
BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres' THEN
  RAISE EXCEPTION 'INVOICE_B4_WRONG_DATABASE_OR_ACTOR';
 END IF;
 SELECT count(*) INTO n FROM pg_roles WHERE rolname IN(
  'bizportal_customer_invoice_cst_writer_dev',
  'bizportal_customer_invoice_diva_writer_dev')
  AND rolcanlogin=false AND rolinherit=false AND rolbypassrls=false
  AND rolsuper=false AND rolcreaterole=false AND rolcreatedb=false;
 IF n<>2 THEN RAISE EXCEPTION 'INVOICE_B4_DORMANT_ROLE_REQUIRED'; END IF;
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public'
   AND policyname LIKE 'cst_invoice_b1_%')<>68
 OR (SELECT count(*) FROM pg_policies WHERE schemaname='public'
   AND policyname LIKE 'cst_invoice_b2_%')<>16
 OR (SELECT count(*) FROM pg_policies WHERE schemaname='public'
   AND policyname LIKE 'cst_invoice_b3_%')<>8 THEN
  RAISE EXCEPTION 'INVOICE_B4_PRIOR_RLS_NOT_AT_BASELINE';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public'
  AND policyname LIKE 'cst_invoice_b4_%') THEN
  RAISE EXCEPTION 'INVOICE_B4_ALREADY_STAGED';
 END IF;
 IF (SELECT count(*) FROM public.bizportal_customer_ar_source_actors_dev
  WHERE (role_name::text,company_id) IN (
   ('bizportal_customer_invoice_cst_writer_dev',1),
   ('bizportal_customer_invoice_diva_writer_dev',3))
   AND enabled=false AND verified_source LIKE
     'CST-DEV Invoice scoped writer Phase A2:%')<>2 THEN
  RAISE EXCEPTION 'INVOICE_B4_AR_ACTOR_MUST_REMAIN_DISABLED';
 END IF;
 FOR tab IN SELECT unnest(ARRAY[
   'accounting_entries','accounting_entry_lines','ar_subledger',
   'transaction_taxes','ledger_events','financial_outbox_events',
   'audit_accounting_events','activity_logs','portal_customer_notifications'])
 LOOP
  IF tab<>'activity_logs' AND tab<>'portal_customer_notifications' AND
    NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename=tab AND policyname='cst_invoice_b1_guard_cst') THEN
   RAISE EXCEPTION 'INVOICE_B4_MISSING_COMPANY_RESTRICTIVE_GUARD %',tab;
  END IF;
 END LOOP;
END $pre$;

-- Exact source Invoice status columns, no total/payment/company writes.
GRANT UPDATE(invoice_status,invoice_number,invoice_date,due_date,updated_at)
 ON public.sales_documents TO
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;
-- Original CanonicalPostingEngine: draft INSERT then status promotion
-- and conditional rejection of an old duplicate draft.
-- Exception required by Drizzle: its compiled INSERT explicitly names all
-- ORM columns (including DEFAULT values). Column-only GRANT would fail
-- with SQLSTATE 42501; the strict source-bound RLS below remains mandatory.
GRANT INSERT ON public.accounting_entries TO
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;
GRANT UPDATE(status,cancel_reason,cancelled_at)
 ON public.accounting_entries TO
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;
-- Same Drizzle explicit-DEFAULT behavior for original line insertion.
GRANT INSERT ON public.accounting_entry_lines TO
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;
-- Existing global per-company/year journal counter, no independent engine.
GRANT INSERT(journal_prefix,company_id,year,next_seq)
 ON public.journal_sequences TO
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;
GRANT UPDATE(next_seq) ON public.journal_sequences TO
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;
-- Original AR projection, only the exact column set used by its trigger.
GRANT INSERT(company_id,invoice_id,customer_id,invoice_number,invoice_date,
 due_date,currency,gross_amount,outstanding_amount,paid_amount,status,
 gl_entry_id,period,notes) ON public.ar_subledger TO
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;
GRANT UPDATE(customer_id,invoice_number,invoice_date,due_date,gross_amount,
 outstanding_amount,paid_amount,status,period,updated_at)
 ON public.ar_subledger TO
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;
-- Exclusive output PPN: no UPDATE/DELETE to recorded tax history.
GRANT INSERT(company_id,transaction_type,transaction_id,transaction_ref,
 tax_id,tax_name,tax_rate,cut_type,base_amount,tax_amount,account_id,
 period,status,direction,posted_at) ON public.transaction_taxes TO
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;
GRANT INSERT(company_id,event_type,period,entry_id,actor,payload)
 ON public.ledger_events TO
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;
GRANT INSERT(event_type,payload,status,entry_id,company_id)
 ON public.financial_outbox_events TO
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;
GRANT INSERT(journal_id,action,company_id,amount,user_id,actor_type,
 correlation_id) ON public.audit_accounting_events TO
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;
-- SELECT FOR UPDATE on existing outbox/audit only: a timestamp column grant
-- with RLS UPDATE WITH CHECK(false). No actual mutation can succeed.
GRANT UPDATE(processed_at) ON public.financial_outbox_events TO
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;
GRANT UPDATE(created_at) ON public.audit_accounting_events TO
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;
-- Existing Portal activity/notification writes, no WA/email dispatch.
GRANT INSERT(actor_type,actor_id,actor_name,action,old_value,new_value,
 description,deduplication_key) ON public.activity_logs TO
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;
GRANT SELECT(deduplication_key) ON public.activity_logs TO
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;
GRANT INSERT(portal_customer_id,event_key,type,title,message,payload)
 ON public.portal_customer_notifications TO
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;
GRANT SELECT(portal_customer_id,event_key) ON public.portal_customer_notifications TO
  bizportal_customer_invoice_cst_writer_dev,
  bizportal_customer_invoice_diva_writer_dev;
-- Only existing serial sequence generators for the exact inserted tables.
DO $sequences$
DECLARE seq_name text; tab text;
BEGIN
 FOREACH tab IN ARRAY ARRAY['accounting_entries','accounting_entry_lines',
  'ar_subledger','transaction_taxes','ledger_events','financial_outbox_events',
  'audit_accounting_events','activity_logs','portal_customer_notifications'] LOOP
  seq_name:=pg_get_serial_sequence('public.'||tab,'id');
  IF seq_name IS NULL THEN
    RAISE EXCEPTION 'INVOICE_B4_SERIAL_SEQUENCE_MISSING: %',tab;
  END IF;
  EXECUTE format('GRANT USAGE ON SEQUENCE %s TO %I,%I',seq_name,
    'bizportal_customer_invoice_cst_writer_dev',
    'bizportal_customer_invoice_diva_writer_dev');
 END LOOP;
END $sequences$;

-- Source-bound write policies. All only to the two dedicated Invoice roles;
-- pre-existing Finance, Fleet, Payroll and Data API policies are untouched.
DO $policies$
DECLARE
  role_name name; tenant integer; suffix text;
  source_guard text; table_name text;
BEGIN
 FOR role_name,tenant IN SELECT * FROM (VALUES
   ('bizportal_customer_invoice_cst_writer_dev'::name,1),
   ('bizportal_customer_invoice_diva_writer_dev'::name,3)) x(role_name,company)
 LOOP
  suffix:=CASE WHEN tenant=1 THEN 'cst' ELSE 'diva' END;
  -- Original source Invoice: requires order status and same company.
  source_guard:=format(
    '(CURRENT_USER=SESSION_USER AND company_id=%s AND '||
     'status::text IN (''confirmed'',''done'',''completed'') AND '||
     'invoice_status::text IN (''to_invoice'',''invoiced'') AND '||
     'cancelled_at IS NULL)',tenant);
  EXECUTE format(
    'CREATE POLICY cst_invoice_b4_update_%s ON public.sales_documents '||
    'FOR UPDATE TO %I USING (%s) WITH CHECK '||
    '(CURRENT_USER=SESSION_USER AND company_id=%s '||
    'AND invoice_status::text=''invoiced'' AND cancelled_at IS NULL)',
    suffix,role_name,source_guard,tenant);

  -- A verified source Invoice in the same company must exist before GL header.
  source_guard:=format(
    '(CURRENT_USER=SESSION_USER AND company_id=%s AND '||
     'source::text=''sales_invoice'' AND status::text=''draft'' AND '||
     'EXISTS(SELECT 1 FROM public.sales_documents sd '||
     'WHERE sd.id=accounting_entries.source_id '||
     'AND sd.company_id=%s AND sd.invoice_status::text=''invoiced'' '||
     'AND sd.status::text IN (''confirmed'',''done'',''completed'') '||
     'AND sd.invoice_number=accounting_entries.ref '||
     'AND accounting_entries.date=sd.invoice_date '||
     'AND accounting_entries.total_debit=sd.grand_total '||
     'AND accounting_entries.total_credit=sd.grand_total '||
     'AND EXISTS(SELECT 1 FROM public.accounting_settings cfg '||
      'WHERE cfg.company_id=%s AND '||
      'cfg.sales_journal_id=accounting_entries.journal_id) '||
     'AND sd.cancelled_at IS NULL))',tenant,tenant,tenant);
  EXECUTE format(
    'CREATE POLICY cst_invoice_b4_insert_%s ON public.accounting_entries '||
    'FOR INSERT TO %I WITH CHECK (%s)',suffix,role_name,source_guard);
  EXECUTE format(
    'CREATE POLICY cst_invoice_b4_update_%s ON public.accounting_entries '||
    'FOR UPDATE TO %I '||
    'USING (CURRENT_USER=SESSION_USER AND company_id=%s '||
    'AND source::text=''sales_invoice'' AND status::text=''draft'') '||
    'WITH CHECK (CURRENT_USER=SESSION_USER AND company_id=%s '||
    'AND source::text=''sales_invoice'' AND '||
    'status::text IN (''posted'',''rejected''))',
    suffix,role_name,tenant,tenant);
  -- Journal details belong to an original draft sales entry, with valid line
  -- polarity. An incorrect explicit line company remains visible via B1 RLS
  -- on future reads but cannot be inserted by this scoped writer.
  source_guard:=format(
    '(CURRENT_USER=SESSION_USER AND '||
    '(company_id IS NULL OR company_id=%s) AND '||
    'debit>=0 AND credit>=0 AND '||
    '(debit=0 OR credit=0) AND '||
    'EXISTS (SELECT 1 FROM public.accounting_entries p '||
     'JOIN public.sales_documents sd ON sd.id=p.source_id '||
       'AND sd.company_id=p.company_id '||
     'JOIN public.accounting_settings cfg ON cfg.company_id=p.company_id '||
    'WHERE p.id=accounting_entry_lines.entry_id AND p.company_id=%s '||
    'AND p.source::text=''sales_invoice'' AND p.status::text=''draft'' '||
    'AND ((accounting_entry_lines.account_id=cfg.ar_account_id '||
           'AND accounting_entry_lines.debit=sd.grand_total '||
           'AND accounting_entry_lines.credit=0) '||
       'OR (accounting_entry_lines.account_id=cfg.sales_income_account_id '||
           'AND accounting_entry_lines.credit=sd.total_amount '||
           'AND accounting_entry_lines.debit=0) '||
       'OR (sd.tax_amount>0 AND '||
           'accounting_entry_lines.account_id=cfg.ppn_output_account_id '||
           'AND accounting_entry_lines.credit=sd.tax_amount '||
           'AND accounting_entry_lines.debit=0))))',tenant,tenant);
  EXECUTE format(
    'CREATE POLICY cst_invoice_b4_insert_%s ON public.accounting_entry_lines '||
    'FOR INSERT TO %I WITH CHECK (%s)',suffix,role_name,source_guard);
  -- Original journal_sequences UPSERT by the configured sales journal code.
  source_guard:=format(
    '(CURRENT_USER=SESSION_USER AND company_id=%s AND '||
    'EXISTS (SELECT 1 FROM public.accounting_settings s '||
     'JOIN public.accounting_journals j ON j.id=s.sales_journal_id '||
     'WHERE s.company_id=%s AND j.company_id=%s '||
       'AND j.code=journal_sequences.journal_prefix))',tenant,tenant,tenant);
  EXECUTE format(
    'CREATE POLICY cst_invoice_b4_insert_%s ON public.journal_sequences '||
    'FOR INSERT TO %I WITH CHECK (%s)',suffix,role_name,source_guard);
  EXECUTE format(
    'CREATE POLICY cst_invoice_b4_update_%s ON public.journal_sequences '||
    'FOR UPDATE TO %I USING (%s) WITH CHECK (%s)',
    suffix,role_name,source_guard,source_guard);
  -- Original reviewed AR trigger emits an INSERT/ON CONFLICT UPDATE, but never
  -- creates a receivable without a matched posted, balanced sales Invoice.
  source_guard:=format(
    '(CURRENT_USER=SESSION_USER AND company_id=%s AND '||
    'notes=''bizportal:customer-ar-source:v1'' AND currency=''IDR'' '||
    'AND EXISTS (SELECT 1 FROM public.bizportal_customer_ar_source_actors_dev actor '||
     'WHERE actor.role_name=SESSION_USER AND actor.company_id=%s '||
     'AND actor.enabled) '||
    'AND EXISTS (SELECT 1 FROM public.bizportal_customer_ar_source_evidence_dev e '||
      'WHERE e.company_id=ar_subledger.company_id '||
      'AND e.invoice_id=ar_subledger.invoice_id '||
      'AND e.gl_entry_id=ar_subledger.gl_entry_id '||
      'AND e.invoice_number=ar_subledger.invoice_number '||
      'AND e.gross_amount=ar_subledger.gross_amount '||
      'AND e.paid_amount=ar_subledger.paid_amount '||
      'AND e.outstanding_amount=ar_subledger.outstanding_amount))',
     tenant,tenant);
  EXECUTE format(
    'CREATE POLICY cst_invoice_b4_insert_%s ON public.ar_subledger '||
    'FOR INSERT TO %I WITH CHECK (%s)',suffix,role_name,source_guard);
  EXECUTE format(
    'CREATE POLICY cst_invoice_b4_update_%s ON public.ar_subledger '||
    'FOR UPDATE TO %I USING (CURRENT_USER=SESSION_USER AND '||
    'company_id=%s AND notes=''bizportal:customer-ar-source:v1'' AND '||
    'EXISTS(SELECT 1 FROM public.bizportal_customer_ar_source_actors_dev actor '||
    'WHERE actor.role_name=SESSION_USER AND actor.company_id=%s AND actor.enabled)) '||
    'WITH CHECK (CURRENT_USER=SESSION_USER AND company_id=%s '||
    'AND notes=''bizportal:customer-ar-source:v1'' AND '||
    '(status=''STALE'' OR EXISTS(SELECT 1 FROM public.bizportal_customer_ar_source_evidence_dev e '||
    'WHERE e.company_id=ar_subledger.company_id AND e.invoice_id=ar_subledger.invoice_id '||
    'AND e.gl_entry_id=ar_subledger.gl_entry_id)))',
    suffix,role_name,tenant,tenant,tenant);
 END LOOP;
END $policies$;

DO $other_writers$
DECLARE
 role_name name; tenant integer; suffix text; scope text;
BEGIN
 FOR role_name,tenant IN SELECT * FROM (VALUES
  ('bizportal_customer_invoice_cst_writer_dev'::name,1),
  ('bizportal_customer_invoice_diva_writer_dev'::name,3)) x(role_name,company)
 LOOP
  suffix:=CASE WHEN tenant=1 THEN 'cst' ELSE 'diva' END;
  -- No tax rows for vendor bills or another company's Invoice.
  scope:=format(
    '(CURRENT_USER=SESSION_USER AND company_id=%s AND '||
    'transaction_type=''sales_invoice'' AND status=''posted'' '||
    'AND direction=''output'' AND tax_amount>0 AND '||
    'EXISTS(SELECT 1 FROM public.sales_documents sd '||
     'JOIN public.accounting_settings cfg ON cfg.company_id=sd.company_id '||
     'WHERE sd.id=transaction_taxes.transaction_id AND sd.company_id=%s '||
     'AND sd.invoice_status::text=''invoiced'' '||
     'AND sd.tax_rate_id=transaction_taxes.tax_id '||
     'AND sd.tax_amount=transaction_taxes.tax_amount '||
     'AND cfg.default_sales_tax_id=transaction_taxes.tax_id '||
     'AND cfg.ppn_output_account_id=transaction_taxes.account_id))',
     tenant,tenant);
  EXECUTE format(
   'CREATE POLICY cst_invoice_b4_insert_%s ON public.transaction_taxes '||
   'FOR INSERT TO %I WITH CHECK (%s)',suffix,role_name,scope);
  -- Ledger/outbox must identify an original sales_invoice posted GL.
  scope:=format(
    '(CURRENT_USER=SESSION_USER AND company_id=%s AND event_type=''POST'' '||
    'AND payload->>''source''=''sales_invoice'' AND '||
    'EXISTS(SELECT 1 FROM public.accounting_entries e '||
    'WHERE e.id=ledger_events.entry_id AND e.company_id=%s '||
    'AND e.source::text=''sales_invoice'' AND e.status::text=''posted''))',tenant,tenant);
  EXECUTE format(
   'CREATE POLICY cst_invoice_b4_insert_%s ON public.ledger_events '||
   'FOR INSERT TO %I WITH CHECK (%s)',suffix,role_name,scope);
  scope:=format(
    '(CURRENT_USER=SESSION_USER AND company_id=%s AND '||
    'event_type=''JOURNAL_CREATED'' AND '||
    'payload->>''sourceType''=''sales_invoice'' AND '||
    'EXISTS(SELECT 1 FROM public.accounting_entries e '||
     'WHERE e.id=financial_outbox_events.entry_id '||
     'AND e.company_id=%s AND e.source::text=''sales_invoice'' '||
     'AND e.status::text=''posted''))',tenant,tenant);
  EXECUTE format(
   'CREATE POLICY cst_invoice_b4_insert_%s ON public.financial_outbox_events '||
   'FOR INSERT TO %I WITH CHECK (%s)',suffix,role_name,scope);
  -- SELECT FOR UPDATE on an existing event must work, but updating it
  -- after SELECT FOR UPDATE must still be RLS-denied (WITH CHECK false).
  EXECUTE format(
   'CREATE POLICY cst_invoice_b4_rowlock_%s ON public.financial_outbox_events '||
   'FOR UPDATE TO %I USING (%s) WITH CHECK(false)',
   suffix,role_name,scope);
  scope:=format(
    '(CURRENT_USER=SESSION_USER AND company_id=%s AND '||
    'action=''SALES_INVOICE_ISSUED'' AND EXISTS('||
     'SELECT 1 FROM public.accounting_entries e '||
     'WHERE e.id=audit_accounting_events.journal_id AND e.company_id=%s '||
     'AND e.source::text=''sales_invoice'' AND e.status::text=''posted'' '||
     'AND audit_accounting_events.correlation_id=('||
     '''sales_invoice:''||%s::text||'':''||e.source_id::text||'':''||e.id::text)))',
     tenant,tenant,tenant);
  EXECUTE format(
    'CREATE POLICY cst_invoice_b4_insert_%s ON public.audit_accounting_events '||
    'FOR INSERT TO %I WITH CHECK (%s)',suffix,role_name,scope);
  EXECUTE format(
    'CREATE POLICY cst_invoice_b4_rowlock_%s ON public.audit_accounting_events '||
    'FOR UPDATE TO %I USING (%s) WITH CHECK(false)',
    suffix,role_name,scope);
 END LOOP;
END $other_writers$;

-- Portal's original deduplicated activity log does not have company_id.
-- Derive the tenant from the referenced canonical sales document instead.
DO $portal_writers$
DECLARE
 role_name name; tenant integer; suffix text; activity text; notice text;
BEGIN
 FOR role_name,tenant IN SELECT * FROM (VALUES
  ('bizportal_customer_invoice_cst_writer_dev'::name,1),
  ('bizportal_customer_invoice_diva_writer_dev'::name,3)) x(role_name,company)
 LOOP
  suffix:=CASE WHEN tenant=1 THEN 'cst' ELSE 'diva' END;
  activity:=format(
   '(CURRENT_USER=SESSION_USER AND actor_type=''admin'' AND '||
   'action=''sales_invoice_issued'' AND EXISTS('||
    'SELECT 1 FROM public.sales_documents sd '||
    'WHERE sd.company_id=%s AND sd.invoice_status::text=''invoiced'' '||
    'AND activity_logs.deduplication_key=('||
     '''sales-invoice-issued:''||sd.id::text)))',tenant);
  EXECUTE format(
   'CREATE POLICY cst_invoice_b4_read_%s ON public.activity_logs '||
   'FOR SELECT TO %I USING (%s)',suffix,role_name,activity);
  EXECUTE format(
   'CREATE POLICY cst_invoice_b4_insert_%s ON public.activity_logs '||
   'FOR INSERT TO %I WITH CHECK (%s)',suffix,role_name,activity);
  EXECUTE format(
   'CREATE POLICY cst_invoice_b4_guard_%s ON public.activity_logs '||
   'AS RESTRICTIVE FOR ALL TO %I USING (%s) WITH CHECK (%s)',
   suffix,role_name,activity,activity);

  notice:=format(
   '(CURRENT_USER=SESSION_USER AND type=''sales_invoice_issued'' AND '||
   'EXISTS (SELECT 1 FROM public.sales_documents sd WHERE sd.company_id=%s '||
    'AND sd.invoice_status::text=''invoiced'' '||
    'AND portal_customer_notifications.event_key=('||
     '''sales-invoice:''||sd.id::text||'':invoiced'') '||
    'AND (portal_customer_notifications.payload->>''invoiceId'')=sd.id::text) '||
   'AND EXISTS (SELECT 1 FROM public.portal_customers pc '||
     'WHERE pc.id=portal_customer_notifications.portal_customer_id AND '||
      '((pc.role=''admin'' AND (pc.account_status=''active'' OR pc.account_status IS NULL)) '||
       'OR EXISTS(SELECT 1 FROM public.portal_company_members pcm '||
        'WHERE pcm.portal_customer_id=pc.id AND pcm.company_id=%s '||
          'AND pcm.is_active IS TRUE))))',tenant,tenant);
  EXECUTE format(
   'CREATE POLICY cst_invoice_b4_read_%s ON public.portal_customer_notifications '||
   'FOR SELECT TO %I USING (%s)',suffix,role_name,notice);
  EXECUTE format(
   'CREATE POLICY cst_invoice_b4_insert_%s ON public.portal_customer_notifications '||
   'FOR INSERT TO %I WITH CHECK (%s)',suffix,role_name,notice);
  EXECUTE format(
   'CREATE POLICY cst_invoice_b4_guard_%s ON public.portal_customer_notifications '||
   'AS RESTRICTIVE FOR ALL TO %I USING (%s) WITH CHECK (%s)',
   suffix,role_name,notice,notice);
 END LOOP;
END $portal_writers$;

DO $postcondition$
DECLARE n integer;
BEGIN
 SELECT count(*) INTO n FROM pg_policies WHERE schemaname='public'
  AND policyname LIKE 'cst_invoice_b4_%';
 IF n<>40 THEN
  RAISE EXCEPTION 'INVOICE_B4_UNEXPECTED_POLICY_COUNT: %',n;
 END IF;
 IF (SELECT count(*) FROM pg_roles WHERE rolname IN(
  'bizportal_customer_invoice_cst_writer_dev',
  'bizportal_customer_invoice_diva_writer_dev')
  AND rolcanlogin=false AND rolinherit=false AND rolbypassrls=false)<>2 THEN
  RAISE EXCEPTION 'INVOICE_B4_ROLE_BECAME_ACTIVE';
 END IF;
 IF (SELECT count(*) FROM public.bizportal_customer_ar_source_actors_dev
   WHERE (role_name::text,company_id) IN(
     ('bizportal_customer_invoice_cst_writer_dev',1),
     ('bizportal_customer_invoice_diva_writer_dev',3))
   AND enabled=false)<>2 THEN
  RAISE EXCEPTION 'INVOICE_B4_AR_ACTOR_BECAME_ACTIVE';
 END IF;
END $postcondition$;
