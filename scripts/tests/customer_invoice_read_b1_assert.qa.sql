-- Run only as either synthetic direct-login writer after B1 migration.
DO $assert$
DECLARE tenant int;expected_lines int;n int;w text;
BEGIN
 w:=session_user;
 tenant:=CASE w
  WHEN 'bizportal_customer_invoice_cst_writer_dev' THEN 1
  WHEN 'bizportal_customer_invoice_diva_writer_dev' THEN 3
  ELSE NULL END;
 IF tenant IS NULL OR current_user<>session_user THEN
  RAISE EXCEPTION 'QA_DIRECT_LOGIN_ROLE_MISMATCH';
 END IF;
 IF (SELECT rolbypassrls FROM pg_roles WHERE rolname=w) THEN
  RAISE EXCEPTION 'QA_BYPASSRLS_ENABLED';
 END IF;
 IF NOT row_security_active('public.sales_documents'::regclass)
    OR NOT row_security_active('public.accounting_entries'::regclass)
    OR NOT row_security_active('public.accounting_entry_lines'::regclass)
    OR NOT row_security_active('public.ar_subledger'::regclass)
    OR NOT row_security_active('public.transaction_taxes'::regclass)
    OR NOT row_security_active('public.financial_outbox_events'::regclass) THEN
  RAISE EXCEPTION 'QA_EFFECTIVE_RLS_NOT_ACTIVE';
 END IF;
 IF (SELECT count(*) FROM public.companies)<>1
    OR (SELECT count(*) FROM public.sales_documents)<>1
    OR (SELECT count(*) FROM public.sales_document_lines)<>1
    OR (SELECT count(*) FROM public.accounting_entries)<>1
    OR (SELECT count(*) FROM public.ar_subledger)<>1
    OR (SELECT count(*) FROM public.transaction_taxes)<>1
    OR (SELECT count(*) FROM public.ledger_events)<>1
    OR (SELECT count(*) FROM public.financial_outbox_events)<>1
    OR (SELECT count(*) FROM public.audit_accounting_events)<>1
    OR (SELECT count(*) FROM public.bizportal_customer_ar_source_actors_dev)<>1
    OR (SELECT count(*) FROM public.bizportal_customer_ar_source_evidence_dev)<>1 THEN
  RAISE EXCEPTION 'QA_COMPANY_SCOPED_ROW_COUNTS_INCORRECT: %',tenant;
 END IF;
 expected_lines:=CASE WHEN tenant=1 THEN 2 ELSE 1 END;
 IF (SELECT count(*) FROM public.accounting_entry_lines)<>expected_lines THEN
  RAISE EXCEPTION 'QA_INVOICE_JOURNAL_LINE_VISIBILITY_INCORRECT';
 END IF;
 IF tenant=1 AND NOT EXISTS (SELECT 1 FROM public.accounting_entry_lines
                            WHERE entry_id=1011 AND company_id=3) THEN
  RAISE EXCEPTION 'QA_MALFORMED_LINE_MUST_BE_VISIBLE_FOR_AR_REJECTION';
 END IF;
 IF (SELECT count(*) FROM public.sales_documents WHERE company_id<>tenant)<>0
    OR (SELECT count(*) FROM public.accounting_entries WHERE company_id<>tenant)<>0
    OR (SELECT count(*) FROM public.ar_subledger WHERE company_id<>tenant)<>0
    OR (SELECT count(*) FROM public.transaction_taxes WHERE company_id<>tenant)<>0 THEN
  RAISE EXCEPTION 'QA_FOREIGN_COMPANY_DATA_VISIBLE';
 END IF;
 IF has_table_privilege(w,'public.accounting_entries','INSERT')
    OR has_table_privilege(w,'public.sales_documents','UPDATE')
    OR has_table_privilege(w,'public.transaction_taxes','INSERT')
    OR has_table_privilege(w,'public.financial_outbox_events','UPDATE')
    OR has_table_privilege(w,'public.audit_accounting_events','INSERT') THEN
  RAISE EXCEPTION 'QA_UNEXPECTED_WRITE_GRANT';
 END IF;
 RAISE NOTICE 'CST_INVOICE_B1_DIRECT_RLS_READ_ONLY_PASS role=% tenant=%',w,tenant;
END $assert$;
