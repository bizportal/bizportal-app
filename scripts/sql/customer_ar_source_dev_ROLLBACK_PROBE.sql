-- Authorized QA for CST-DEV xssrfshdrtdfupgqwfdw on PostgreSQL 17 only.
-- Run as the verified existing postgres issuer. Every financial/configuration
-- write is rolled back. Generated sequence values may advance.
-- No period, immutability or RLS guard is disabled or overridden.
BEGIN;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';
SET LOCAL timezone = 'UTC';

DO $prepare$
DECLARE v_invoice_id integer; v_entry_id integer; ar_account integer;
  revenue_account integer; journal integer; reference text;
BEGIN
  IF current_user <> 'postgres' OR session_user <> 'postgres'
    OR current_database() <> 'postgres'
    OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
    OR current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CUSTOMER_AR_QA_EXPECTED_VERIFIED_DEV_PG17_ISSUER';
  END IF;
  IF (SELECT count(*) FROM public.bizportal_customer_ar_source_actors_dev) <> 4
    OR EXISTS (SELECT 1 FROM public.bizportal_customer_ar_source_actors_dev WHERE enabled) THEN
    RAISE EXCEPTION 'CUSTOMER_AR_QA_REQUIRES_DISABLED_ACTIVATION_BASELINE';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales_documents WHERE doc_number LIKE 'QA-CUSTAR-ROLLBACK-%')
    OR EXISTS (SELECT 1 FROM public.accounting_entries WHERE entry_number LIKE 'QA-CUSTAR-ROLLBACK-%')
    OR EXISTS (SELECT 1 FROM public.ar_subledger WHERE invoice_number LIKE 'QA-CUSTAR-ROLLBACK-%') THEN
    RAISE EXCEPTION 'CUSTOMER_AR_QA_MARKER_ALREADY_PRESENT';
  END IF;
  IF (SELECT count(*) FROM public.accounting_settings WHERE company_id = 1) <> 1 THEN
    RAISE EXCEPTION 'CUSTOMER_AR_QA_SETTINGS_AMBIGUOUS';
  END IF;
  SELECT ar_account_id, sales_income_account_id, sales_journal_id
    INTO ar_account, revenue_account, journal
    FROM public.accounting_settings WHERE company_id = 1;
  IF ar_account IS NULL OR revenue_account IS NULL OR journal IS NULL
    OR NOT EXISTS (SELECT 1 FROM public.chart_of_accounts
      WHERE id = revenue_account AND company_id = 1 AND is_active AND is_postable) THEN
    RAISE EXCEPTION 'CUSTOMER_AR_QA_SOURCE_MAPPING_UNAVAILABLE';
  END IF;
  -- Current source created_at defaults to transaction_timestamp(). The QA
  -- activation is in this same transaction, so use that exact cutoff here.
  UPDATE public.bizportal_customer_ar_source_actors_dev
    SET enabled = true, source_not_before = transaction_timestamp()
    WHERE role_name = 'postgres' AND company_id = 1;
  reference := 'QA-CUSTAR-ROLLBACK-' || gen_random_uuid()::text;
  INSERT INTO public.sales_documents
    (doc_number, kind, status, invoice_status, payment_status, amount_paid,
     customer_name, total_amount, tax_amount, grand_total, invoice_number,
     invoice_date, due_date, company_id, notes)
    VALUES (reference, 'order', 'confirmed', 'invoiced', 'unpaid', 0,
      'QA rollback only; not a real customer', 100, 0, 100, reference,
      current_date, current_date + 30, 1, 'Synthetic DEV rollback probe only')
    RETURNING id INTO v_invoice_id;
  INSERT INTO public.accounting_entries
    (company_id, entry_number, journal_id, date, ref, description,
     status, source, source_id, total_debit, total_credit, created_by_id)
    VALUES (1, reference, journal, current_date, reference,
      'Synthetic customer AR rollback probe only', 'draft', 'sales_invoice',
      v_invoice_id, 100, 100, 'qa-customer-ar-rollback')
    RETURNING id INTO v_entry_id;
  INSERT INTO public.accounting_entry_lines
    (entry_id, company_id, account_id, debit, credit, description)
    VALUES (v_entry_id, 1, ar_account, 100, 0, 'QA rollback AR'),
      (v_entry_id, 1, revenue_account, 0, 100, 'QA rollback revenue');
  UPDATE public.accounting_entries SET status = 'posted' WHERE id = v_entry_id;
  IF EXISTS (SELECT 1 FROM public.ar_subledger ar WHERE ar.invoice_id = v_invoice_id AND ar.company_id = 1) THEN
    RAISE EXCEPTION 'CUSTOMER_AR_QA_PROJECTION_WAS_NOT_DEFERRED';
  END IF;
  PERFORM set_config('qa.customer_ar_invoice_id', v_invoice_id::text, true);
  PERFORM set_config('qa.customer_ar_entry_id', v_entry_id::text, true);
END
$prepare$;

SET CONSTRAINTS ALL IMMEDIATE;

DO $assert_and_replay$
DECLARE v_invoice_id integer := current_setting('qa.customer_ar_invoice_id')::integer;
  v_entry_id integer := current_setting('qa.customer_ar_entry_id')::integer;
  v_ar_id integer;
BEGIN
  IF (SELECT count(*) FROM public.ar_subledger ar WHERE ar.company_id = 1 AND ar.invoice_id = v_invoice_id) <> 1 THEN
    RAISE EXCEPTION 'CUSTOMER_AR_QA_EXACTLY_ONE_PROJECTION_REQUIRED';
  END IF;
  SELECT id INTO v_ar_id FROM public.ar_subledger ar
    WHERE ar.company_id = 1 AND ar.invoice_id = v_invoice_id
      AND ar.gl_entry_id = v_entry_id AND ar.gross_amount = 100
      AND ar.outstanding_amount = 100 AND ar.paid_amount = 0 AND ar.status = 'OPEN'
      AND ar.notes = 'bizportal:customer-ar-source:v1';
  IF v_ar_id IS NULL THEN RAISE EXCEPTION 'CUSTOMER_AR_QA_SOURCE_PROOF_MISMATCH'; END IF;
  UPDATE public.sales_documents SET updated_at = clock_timestamp() WHERE id = v_invoice_id;
  UPDATE public.sales_documents SET updated_at = clock_timestamp() WHERE id = v_invoice_id;
  IF (SELECT count(*) FROM public.ar_subledger ar WHERE ar.company_id = 1 AND ar.invoice_id = v_invoice_id) <> 1
    OR NOT EXISTS (SELECT 1 FROM public.ar_subledger ar WHERE ar.id = v_ar_id
      AND ar.gl_entry_id = v_entry_id AND ar.paid_amount = 0 AND ar.outstanding_amount = 100) THEN
    RAISE EXCEPTION 'CUSTOMER_AR_QA_REPLAY_CHANGED_BALANCE_OR_IDENTITY';
  END IF;
  -- Project source paid state only; no payment/bank/allocation is created.
  UPDATE public.sales_documents SET amount_paid = 25, payment_status = 'partial' WHERE id = v_invoice_id;
  UPDATE public.sales_documents SET updated_at = clock_timestamp() WHERE id = v_invoice_id;
  UPDATE public.sales_documents SET updated_at = clock_timestamp() WHERE id = v_invoice_id;
  IF NOT EXISTS (SELECT 1 FROM public.ar_subledger ar WHERE ar.id = v_ar_id
      AND ar.gl_entry_id = v_entry_id AND ar.gross_amount = 100
      AND ar.paid_amount = 25 AND ar.outstanding_amount = 75 AND ar.status = 'PARTIAL')
    OR (SELECT count(*) FROM public.ar_subledger ar WHERE ar.company_id = 1 AND ar.invoice_id = v_invoice_id) <> 1 THEN
    RAISE EXCEPTION 'CUSTOMER_AR_QA_PARTIAL_REPLAY_NOT_ABSOLUTE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bizportal_customer_ar_source_evidence_dev e
    WHERE e.company_id = 1 AND e.invoice_id = v_invoice_id AND e.gl_entry_id = v_entry_id
      AND e.gross_amount = 100 AND e.paid_amount = 25 AND e.outstanding_amount = 75) THEN
    RAISE EXCEPTION 'CUSTOMER_AR_QA_SHARED_SOURCE_VIEW_DID_NOT_VERIFY';
  END IF;
  IF (SELECT count(*) FROM public.accounting_entries e
    WHERE e.company_id = 1 AND e.source::text = 'sales_invoice' AND e.source_id = v_invoice_id) <> 1
    OR (SELECT count(*) FROM public.accounting_entry_lines l WHERE l.entry_id = v_entry_id) <> 2 THEN
    RAISE EXCEPTION 'CUSTOMER_AR_QA_SOURCE_JOURNAL_CHANGED';
  END IF;
END
$assert_and_replay$;

ROLLBACK;

-- Reaching this SELECT means all above assertions passed and rollback ran.
-- These counts independently verify no QA financial row or activation remains.
SELECT jsonb_build_object(
  'result', 'CUSTOMER_AR_ACTUAL_DEV_PG17_ROLLBACK_PASS',
  'server_version', current_setting('server_version'),
  'issuer', current_user,
  'qa_sales_remaining', (SELECT count(*) FROM public.sales_documents WHERE doc_number LIKE 'QA-CUSTAR-ROLLBACK-%'),
  'qa_entries_remaining', (SELECT count(*) FROM public.accounting_entries WHERE entry_number LIKE 'QA-CUSTAR-ROLLBACK-%'),
  'qa_ar_remaining', (SELECT count(*) FROM public.ar_subledger WHERE invoice_number LIKE 'QA-CUSTAR-ROLLBACK-%'),
  'enabled_actors_after_rollback', (SELECT count(*) FROM public.bizportal_customer_ar_source_actors_dev WHERE enabled),
  'ar_rows_after_rollback', (SELECT count(*) FROM public.ar_subledger)
) AS result;
