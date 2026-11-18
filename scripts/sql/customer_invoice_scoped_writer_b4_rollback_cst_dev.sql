-- CST-DEV B4 rollback: drop only Customer Invoice write grants/policies.
-- Must run before enabling either writer LOGIN or either AR actor.
-- No financial data, original role, policy, or source trigger is touched.
DO $pre$
DECLARE n integer;
BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres' THEN
  RAISE EXCEPTION 'INVOICE_B4_ROLLBACK_WRONG_DATABASE_OR_ACTOR';
 END IF;
 SELECT count(*) INTO n FROM pg_roles
 WHERE rolname IN('bizportal_customer_invoice_cst_writer_dev',
                  'bizportal_customer_invoice_diva_writer_dev')
 AND rolcanlogin=false AND rolinherit=false AND rolbypassrls=false
 AND rolsuper=false AND rolcreaterole=false;
 IF n<>2 THEN RAISE EXCEPTION 'INVOICE_B4_ROLLBACK_REQUIRES_DORMANT_ROLES'; END IF;
 IF (SELECT count(*) FROM public.bizportal_customer_ar_source_actors_dev
  WHERE (role_name::text,company_id) IN (
   ('bizportal_customer_invoice_cst_writer_dev',1),
   ('bizportal_customer_invoice_diva_writer_dev',3))
  AND enabled=false
  AND verified_source LIKE 'CST-DEV Invoice scoped writer Phase A2:%')<>2 THEN
  RAISE EXCEPTION 'INVOICE_B4_ROLLBACK_ACTORS_CHANGED_OR_ACTIVE';
 END IF;
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public'
  AND policyname LIKE 'cst_invoice_b1_%')<>68
 OR (SELECT count(*) FROM pg_policies WHERE schemaname='public'
  AND policyname LIKE 'cst_invoice_b2_%')<>16
 OR (SELECT count(*) FROM pg_policies WHERE schemaname='public'
  AND policyname LIKE 'cst_invoice_b3_%')<>8
 OR (SELECT count(*) FROM pg_policies WHERE schemaname='public'
  AND policyname LIKE 'cst_invoice_b4_%')<>40 THEN
  RAISE EXCEPTION 'INVOICE_B4_ROLLBACK_POLICY_BASELINE_CHANGED';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
  AND policyname LIKE 'cst_invoice_b5_%') THEN
  RAISE EXCEPTION 'INVOICE_B4_ROLLBACK_B5_ALREADY_STARTED';
 END IF;
END $pre$;

DO $drop$
DECLARE suffix text; tab text; pname text;
BEGIN
 FOREACH suffix IN ARRAY ARRAY['cst','diva'] LOOP
  FOR tab,pname IN SELECT * FROM (VALUES
   ('sales_documents','update'),
   ('accounting_entries','insert'),
   ('accounting_entries','update'),
   ('accounting_entry_lines','insert'),
   ('journal_sequences','insert'),
   ('journal_sequences','update'),
   ('ar_subledger','insert'),
   ('ar_subledger','update'),
   ('transaction_taxes','insert'),
   ('ledger_events','insert'),
   ('financial_outbox_events','insert'),
   ('financial_outbox_events','rowlock'),
   ('audit_accounting_events','insert'),
   ('audit_accounting_events','rowlock'),
   ('activity_logs','read'),
   ('activity_logs','insert'),
   ('activity_logs','guard'),
   ('portal_customer_notifications','read'),
   ('portal_customer_notifications','insert'),
   ('portal_customer_notifications','guard')
  ) policy(target,operation) LOOP
   EXECUTE format('DROP POLICY cst_invoice_b4_%s_%s ON public.%I',
                  pname,suffix,tab);
  END LOOP;
 END LOOP;
END $drop$;

-- Column grants: REVOKE table-level privilege alone would not remove these.
REVOKE UPDATE(invoice_status,invoice_number,invoice_date,due_date,updated_at)
 ON public.sales_documents FROM
 bizportal_customer_invoice_cst_writer_dev,
 bizportal_customer_invoice_diva_writer_dev;
REVOKE INSERT ON public.accounting_entries,
 public.accounting_entry_lines FROM
 bizportal_customer_invoice_cst_writer_dev,
 bizportal_customer_invoice_diva_writer_dev;
REVOKE UPDATE(status,cancel_reason,cancelled_at)
 ON public.accounting_entries FROM
 bizportal_customer_invoice_cst_writer_dev,
 bizportal_customer_invoice_diva_writer_dev;
REVOKE INSERT(journal_prefix,company_id,year,next_seq)
 ON public.journal_sequences FROM
 bizportal_customer_invoice_cst_writer_dev,
 bizportal_customer_invoice_diva_writer_dev;
REVOKE UPDATE(next_seq) ON public.journal_sequences FROM
 bizportal_customer_invoice_cst_writer_dev,
 bizportal_customer_invoice_diva_writer_dev;
REVOKE INSERT(company_id,invoice_id,customer_id,invoice_number,invoice_date,
 due_date,currency,gross_amount,outstanding_amount,paid_amount,status,
 gl_entry_id,period,notes) ON public.ar_subledger FROM
 bizportal_customer_invoice_cst_writer_dev,
 bizportal_customer_invoice_diva_writer_dev;
REVOKE UPDATE(customer_id,invoice_number,invoice_date,due_date,gross_amount,
 outstanding_amount,paid_amount,status,period,updated_at)
 ON public.ar_subledger FROM
 bizportal_customer_invoice_cst_writer_dev,
 bizportal_customer_invoice_diva_writer_dev;
REVOKE INSERT(company_id,transaction_type,transaction_id,transaction_ref,
 tax_id,tax_name,tax_rate,cut_type,base_amount,tax_amount,account_id,
 period,status,direction,posted_at) ON public.transaction_taxes FROM
 bizportal_customer_invoice_cst_writer_dev,
 bizportal_customer_invoice_diva_writer_dev;
REVOKE INSERT(company_id,event_type,period,entry_id,actor,payload)
 ON public.ledger_events FROM
 bizportal_customer_invoice_cst_writer_dev,
 bizportal_customer_invoice_diva_writer_dev;
REVOKE INSERT(event_type,payload,status,entry_id,company_id)
 ON public.financial_outbox_events FROM
 bizportal_customer_invoice_cst_writer_dev,
 bizportal_customer_invoice_diva_writer_dev;
REVOKE UPDATE(processed_at) ON public.financial_outbox_events FROM
 bizportal_customer_invoice_cst_writer_dev,
 bizportal_customer_invoice_diva_writer_dev;
REVOKE INSERT(journal_id,action,company_id,amount,user_id,actor_type,
 correlation_id) ON public.audit_accounting_events FROM
 bizportal_customer_invoice_cst_writer_dev,
 bizportal_customer_invoice_diva_writer_dev;
REVOKE UPDATE(created_at) ON public.audit_accounting_events FROM
 bizportal_customer_invoice_cst_writer_dev,
 bizportal_customer_invoice_diva_writer_dev;

REVOKE INSERT(actor_type,actor_id,actor_name,action,old_value,new_value,
 description,deduplication_key) ON public.activity_logs FROM
 bizportal_customer_invoice_cst_writer_dev,
 bizportal_customer_invoice_diva_writer_dev;
REVOKE SELECT(deduplication_key) ON public.activity_logs FROM
 bizportal_customer_invoice_cst_writer_dev,
 bizportal_customer_invoice_diva_writer_dev;
REVOKE INSERT(portal_customer_id,event_key,type,title,message,payload)
 ON public.portal_customer_notifications FROM
 bizportal_customer_invoice_cst_writer_dev,
 bizportal_customer_invoice_diva_writer_dev;
REVOKE SELECT(portal_customer_id,event_key)
 ON public.portal_customer_notifications FROM
 bizportal_customer_invoice_cst_writer_dev,
 bizportal_customer_invoice_diva_writer_dev;

DO $sequences$
DECLARE seq_name text; tab text;
BEGIN
 FOREACH tab IN ARRAY ARRAY[
  'accounting_entries','accounting_entry_lines','ar_subledger',
  'transaction_taxes','ledger_events','financial_outbox_events',
  'audit_accounting_events','activity_logs',
  'portal_customer_notifications'] LOOP
  seq_name:=pg_get_serial_sequence('public.'||tab,'id');
  IF seq_name IS NULL THEN
    RAISE EXCEPTION 'INVOICE_B4_ROLLBACK_SEQUENCE_MISSING %',tab;
  END IF;
  EXECUTE format('REVOKE USAGE ON SEQUENCE %s FROM %I,%I',
    seq_name,'bizportal_customer_invoice_cst_writer_dev',
             'bizportal_customer_invoice_diva_writer_dev');
 END LOOP;
END $sequences$;

DO $post$
DECLARE n integer;
BEGIN
 SELECT count(*) INTO n FROM pg_policies WHERE schemaname='public'
  AND policyname LIKE 'cst_invoice_b4_%';
 IF n<>0 THEN RAISE EXCEPTION 'INVOICE_B4_ROLLBACK_POLICIES_REMAIN'; END IF;
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public'
  AND policyname LIKE 'cst_invoice_b1_%')<>68
 OR (SELECT count(*) FROM pg_policies WHERE schemaname='public'
  AND policyname LIKE 'cst_invoice_b2_%')<>16
 OR (SELECT count(*) FROM pg_policies WHERE schemaname='public'
  AND policyname LIKE 'cst_invoice_b3_%')<>8 THEN
  RAISE EXCEPTION 'INVOICE_B4_ROLLBACK_REMOVED_READ_OR_LOCK_STAGE';
 END IF;
 IF has_table_privilege('bizportal_customer_invoice_cst_writer_dev',
  'public.accounting_entries','INSERT')
 OR has_table_privilege('bizportal_customer_invoice_diva_writer_dev',
  'public.accounting_entry_lines','INSERT')
 OR has_column_privilege('bizportal_customer_invoice_cst_writer_dev',
  'public.sales_documents','invoice_status','UPDATE')
 OR has_column_privilege('bizportal_customer_invoice_diva_writer_dev',
  'public.ar_subledger','invoice_id','INSERT')
 OR has_column_privilege('bizportal_customer_invoice_cst_writer_dev',
  'public.transaction_taxes','tax_amount','INSERT')
 OR has_column_privilege('bizportal_customer_invoice_diva_writer_dev',
  'public.financial_outbox_events','processed_at','UPDATE') THEN
  RAISE EXCEPTION 'INVOICE_B4_ROLLBACK_FINANCIAL_GRANT_REMAINS';
 END IF;
 IF (SELECT count(*) FROM pg_roles WHERE rolname IN (
  'bizportal_customer_invoice_cst_writer_dev',
  'bizportal_customer_invoice_diva_writer_dev')
  AND rolcanlogin=false AND rolbypassrls=false)<>2 THEN
  RAISE EXCEPTION 'INVOICE_B4_ROLLBACK_DORMANT_ROLE_CHANGED';
 END IF;
END $post$;
