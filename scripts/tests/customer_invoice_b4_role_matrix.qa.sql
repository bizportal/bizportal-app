-- Disposable-only PG16 test: the postgres fixture uses SET SESSION
-- AUTHORIZATION to adopt a NOLOGIN role. No role gets a real credential.
-- The caller must SET SESSION AUTHORIZATION before BEGIN.
BEGIN;
DO $qa$
DECLARE tenant int; other_tenant int; doc_id int; other_doc int;
 invoice_number text; jseq text; new_entry int; changes int;
 w text := session_user; rejected boolean;
BEGIN
 tenant:=CASE w
 WHEN 'bizportal_customer_invoice_cst_writer_dev' THEN 1
 WHEN 'bizportal_customer_invoice_diva_writer_dev' THEN 3
 ELSE NULL END;
 IF tenant IS NULL OR current_user<>session_user THEN
  RAISE EXCEPTION 'B4_NON_DIRECT_WRITER_IDENTITY';
 END IF;
 IF (SELECT rolcanlogin FROM pg_roles WHERE rolname=w) OR
    (SELECT rolbypassrls FROM pg_roles WHERE rolname=w) THEN
  RAISE EXCEPTION 'B4_ROLE_MUST_REMAIN_DORMANT';
 END IF;
 other_tenant:=CASE tenant WHEN 1 THEN 3 ELSE 1 END;
 doc_id:=CASE tenant WHEN 1 THEN 101 ELSE 303 END;
 other_doc:=CASE tenant WHEN 1 THEN 303 ELSE 101 END;
 invoice_number:=CASE tenant WHEN 1 THEN 'INV-CST-101' ELSE 'INV-DIVA-303' END;
 IF NOT row_security_active('public.accounting_entries'::regclass) OR
    NOT row_security_active('public.accounting_entry_lines'::regclass) OR
    NOT row_security_active('public.transaction_taxes'::regclass) OR
    NOT row_security_active('public.ar_subledger'::regclass) OR
    NOT row_security_active('public.financial_outbox_events'::regclass) THEN
  RAISE EXCEPTION 'B4_RLS_MUST_BE_EFFECTIVE';
 END IF;
 IF NOT has_column_privilege(w,'public.accounting_entries','status','UPDATE')
 OR NOT has_column_privilege(w,'public.sales_documents','invoice_status','UPDATE')
 OR NOT has_column_privilege(w,'public.transaction_taxes','tax_amount','INSERT')
 OR NOT has_column_privilege(w,'public.ar_subledger','invoice_id','INSERT') THEN
  RAISE EXCEPTION 'B4_ISSUANCE_COLUMN_GRANTS_INCOMPLETE';
 END IF;
 IF has_column_privilege(w,'public.sales_documents','grand_total','UPDATE')
 OR has_column_privilege(w,'public.accounting_entries','company_id','UPDATE')
 OR has_column_privilege(w,'public.accounting_entry_lines','debit','UPDATE')
 OR has_column_privilege(w,'public.transaction_taxes','tax_amount','UPDATE')
 OR has_column_privilege(w,'public.users','password_hash','SELECT')
 OR has_table_privilege(w,'public.users','INSERT') THEN
  RAISE EXCEPTION 'B4_UNEXPECTED_FINANCIAL_OR_USER_PERMISSION';
 END IF;
 -- First a genuine draft journal source header under restricted RLS.
 INSERT INTO public.accounting_entries
 (company_id,source,source_id,ref,status,journal_id,date,total_debit,total_credit)
 VALUES(tenant,'sales_invoice',doc_id,invoice_number,'draft',
  tenant,'2026-11-18',111,111)
 RETURNING id INTO new_entry;
 IF new_entry IS NULL THEN RAISE EXCEPTION 'B4_GL_DRAFT_INSERT_FAILED'; END IF;
 -- Three original-source lines, required account/money signature.
 INSERT INTO public.accounting_entry_lines
 (entry_id,account_id,debit,credit)
 VALUES
 (new_entry,CASE tenant WHEN 1 THEN 101 ELSE 301 END,111,0),
 (new_entry,CASE tenant WHEN 1 THEN 102 ELSE 302 END,0,100),
 (new_entry,tenant,0,11);
 UPDATE public.accounting_entries SET status='posted'
 WHERE id=new_entry;
 GET DIAGNOSTICS changes=ROW_COUNT;
 IF changes<>1 THEN RAISE EXCEPTION 'B4_DRAFT_TO_POSTED_TRANSITION_FAILED'; END IF;
 -- Posted entries cannot be changed again with the restricted update policy.
 BEGIN
  UPDATE public.accounting_entries SET status='rejected' WHERE id=new_entry;
  GET DIAGNOSTICS changes=ROW_COUNT;
  IF changes<>0 THEN RAISE EXCEPTION 'B4_POSTED_GL_CAN_BE_MUTATED'; END IF;
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 RAISE NOTICE 'B4_DRAFT_POSTED_GL_RESTRICTED_PASS %',tenant;
 -- Exact output PPN attached to a source company tax and invoice.
 INSERT INTO public.transaction_taxes
 (company_id,transaction_type,transaction_id,tax_id,tax_amount,account_id,
 status,direction)
 VALUES(tenant,'sales_invoice',doc_id,tenant,11,tenant,'posted','output');
 INSERT INTO public.ledger_events
 (company_id,event_type,entry_id,payload)
 VALUES(tenant,'POST',new_entry,'{"source":"sales_invoice"}'::jsonb);
 INSERT INTO public.financial_outbox_events
 (company_id,event_type,entry_id,payload,status)
 VALUES(tenant,'JOURNAL_CREATED',new_entry,
 '{"sourceType":"sales_invoice"}'::jsonb,'pending');
 INSERT INTO public.audit_accounting_events
 (journal_id,action,company_id,correlation_id,amount,user_id,actor_type)
 VALUES(new_entry,'SALES_INVOICE_ISSUED',tenant,
  'sales_invoice:'||tenant::text||':'||doc_id::text||':'||new_entry::text,
  111,'synthetic-original-owner','admin');
 INSERT INTO public.activity_logs
 (actor_type,actor_id,action,deduplication_key)
 VALUES('admin','20','sales_invoice_issued',
  'sales-invoice-issued:'||doc_id::text)
 ON CONFLICT(deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;
 INSERT INTO public.portal_customer_notifications
 (portal_customer_id,event_key,type,title,message,payload)
 VALUES(10,'sales-invoice:'||doc_id::text||':invoiced',
  'sales_invoice_issued','Synthetic audit','QA only',
  jsonb_build_object('invoiceId',doc_id))
 ON CONFLICT(portal_customer_id,event_key) DO NOTHING;
 -- Original per-journal counter with a unique company/year key.
 INSERT INTO public.journal_sequences
 (journal_prefix,company_id,year,next_seq)
 VALUES('SCST',tenant,2026,2)
 ON CONFLICT(journal_prefix,company_id,year)
 DO UPDATE SET next_seq=public.journal_sequences.next_seq+1;
 RAISE NOTICE 'B4_PPN_GL_LEDGER_OUTBOX_AUDIT_NOTIFICATION_PASS %',tenant;
 -- The original AR actor is disabled by Phase A2. It must NOT be possible
 -- to create a synthetic AR row even if a source Invoice exists.
 rejected:=false;
 BEGIN
  INSERT INTO public.ar_subledger
   (company_id,invoice_id,notes,currency,invoice_number,gross_amount,
    outstanding_amount,paid_amount,gl_entry_id)
  VALUES(tenant,doc_id,'bizportal:customer-ar-source:v1','IDR',
   invoice_number,111,111,0,new_entry);
 EXCEPTION WHEN insufficient_privilege THEN
  rejected:=true;
 END;
 IF NOT rejected THEN
  RAISE EXCEPTION 'B4_AR_INSERT_MUST_BE_DENIED_WITH_DISABLED_ACTOR';
 END IF;
 RAISE NOTICE 'B4_DISABLED_AR_ACTOR_FAIL_CLOSED_PASS %',tenant;
 -- Bad company/source writes must fail RLS before any commit.
 rejected:=false;
 BEGIN
  INSERT INTO public.accounting_entries(company_id,source,source_id,ref,status)
  VALUES(other_tenant,'sales_invoice',other_doc,
   CASE other_tenant WHEN 1 THEN 'INV-CST-101' ELSE 'INV-DIVA-303' END,
   'draft');
 EXCEPTION WHEN insufficient_privilege THEN rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'B4_CROSS_COMPANY_GL_INSERT_ALLOWED'; END IF;

 rejected:=false;
 BEGIN
  INSERT INTO public.accounting_entries(company_id,source,source_id,ref,status)
  VALUES(tenant,'payroll',doc_id,invoice_number,'draft');
 EXCEPTION WHEN insufficient_privilege THEN rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'B4_FOREIGN_ACCOUNTING_SOURCE_ALLOWED'; END IF;

 rejected:=false;
 BEGIN
  INSERT INTO public.transaction_taxes
   (company_id,transaction_type,transaction_id,tax_id,tax_amount,account_id,status,direction)
  VALUES(other_tenant,'sales_invoice',other_doc,other_tenant,11,other_tenant,'posted','output');
 EXCEPTION WHEN insufficient_privilege THEN rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'B4_CROSS_COMPANY_OUTPUT_TAX_ALLOWED'; END IF;

 rejected:=false;
 BEGIN
  INSERT INTO public.portal_customer_notifications
   (portal_customer_id,event_key,type,payload)
  VALUES(10,'sales-invoice:'||other_doc::text||':invoiced',
   'sales_invoice_issued',jsonb_build_object('invoiceId',other_doc));
 EXCEPTION WHEN insufficient_privilege THEN rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'B4_FOREIGN_INVOICE_NOTIFICATION_ALLOWED'; END IF;

 SELECT count(*) INTO changes FROM (
  SELECT id FROM public.financial_outbox_events
  WHERE entry_id=new_entry AND company_id=tenant FOR UPDATE
 ) locked_outbox;
 IF changes<>1 THEN RAISE EXCEPTION 'B4_OUTBOX_FOR_UPDATE_LOCK_FAILED'; END IF;
 SELECT count(*) INTO changes FROM (
  SELECT id FROM public.audit_accounting_events
  WHERE journal_id=new_entry AND company_id=tenant FOR UPDATE
 ) locked_audit;
 IF changes<>1 THEN RAISE EXCEPTION 'B4_AUDIT_FOR_UPDATE_LOCK_FAILED'; END IF;
 rejected:=false;
 BEGIN
  UPDATE public.financial_outbox_events SET processed_at=now()
  WHERE entry_id=new_entry AND company_id=tenant;
  GET DIAGNOSTICS changes=ROW_COUNT;
  IF changes<>0 THEN RAISE EXCEPTION 'B4_OUTBOX_STATE_CHANGE_ALLOWED'; END IF;
 EXCEPTION WHEN insufficient_privilege THEN rejected:=true;
 END;
 rejected:=false;
 BEGIN
  UPDATE public.audit_accounting_events SET created_at=now()
  WHERE journal_id=new_entry AND company_id=tenant;
  GET DIAGNOSTICS changes=ROW_COUNT;
  IF changes<>0 THEN RAISE EXCEPTION 'B4_AUDIT_STATE_CHANGE_ALLOWED'; END IF;
 EXCEPTION WHEN insufficient_privilege THEN rejected:=true;
 END;
 RAISE NOTICE 'B4_CROSS_COMPANY_AND_AUDIT_IMMUTABILITY_PASS %',tenant;
END $qa$;
ROLLBACK;
