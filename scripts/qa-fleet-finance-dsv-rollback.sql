-- CST-DEV ONLY: xssrfshdrtdfupgqwfdw. The caller must pin that project.
-- Validates installed database guards and mapping data; not a live HTTP/auth test.
-- All source, journal, line, ledger and settings changes ROLLBACK.
-- PostgreSQL sequences used by installed ledger triggers can advance on rollback;
-- no sequence is reset and no trigger, RLS, or immutability protection is disabled.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
DO $qa$
DECLARE
  checks text[] := ARRAY[]::text[];
  original_row jsonb;
  collision boolean;
  actual_constraint text;
  cash_id integer;
  ar_id integer;
  journal_id integer;
  payment_id constant integer := 990117301;
  original_id constant integer := 990117311;
  reversal_id constant integer := 990117312;
  amount constant numeric := 12500.25;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id=3 AND is_active=true AND lower(company_name)='pt diva servis') THEN
    RAISE EXCEPTION 'QA_TARGET_COMPANY_NOT_VERIFIED';
  END IF;
  SELECT fleet_cash_account_id,fleet_driver_receivable_account_id,cash_journal_id
    INTO cash_id,ar_id,journal_id FROM public.accounting_settings WHERE company_id=3;
  IF cash_id IS DISTINCT FROM 49187 OR ar_id IS DISTINCT FROM 49191 OR journal_id IS DISTINCT FROM 20 THEN
    RAISE EXCEPTION 'QA_EXPECTED_DIVA_CONFIGURATION_NOT_READY';
  END IF;
  IF (SELECT count(*) FROM public.chart_of_accounts WHERE id IN(cash_id,ar_id) AND company_id=3 AND is_active=true AND is_postable=true AND is_header=false AND status='ACTIVE' AND type::text='asset')<>2 THEN
    RAISE EXCEPTION 'QA_TARGET_COA_NOT_VERIFIED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.accounting_journals WHERE id=journal_id AND company_id=3 AND is_active=true) THEN
    RAISE EXCEPTION 'QA_TARGET_JOURNAL_NOT_VERIFIED';
  END IF;
  checks := array_append(checks,'Diva company3 and configured company-owned postable accounts/journal verified');

  SELECT EXISTS(SELECT 1 FROM public.fleet_cash_payments WHERE id=payment_id)
      OR EXISTS(SELECT 1 FROM public.accounting_entries WHERE id IN(original_id,reversal_id,990117313) OR ref LIKE 'QA-FLEET-DSV-ROLLBACK%')
      OR EXISTS(SELECT 1 FROM public.accounting_entry_lines WHERE id BETWEEN 990117321 AND 990117324)
      OR EXISTS(SELECT 1 FROM public.fleet_ledger_entries WHERE source_ref LIKE 'QA-FLEET-DSV-ROLLBACK%')
      INTO collision;
  IF collision THEN RAISE EXCEPTION 'QA_FIXTURE_ID_COLLISION'; END IF;
  checks := array_append(checks,'Reserved synthetic fixture identifiers were unused');

  INSERT INTO public.fleet_cash_payments
    (id,company_id,driver_name,payment_date,amount,payment_method,reference_no,recorded_by,status)
  VALUES(payment_id,1,'QA FLEET DSV ROLLBACK','2026-11-17',amount,'cash','QA-FLEET-DSV-ROLLBACK','fleet-finance-qa','confirmed');
  IF NOT EXISTS(SELECT 1 FROM public.fleet_cash_payments p WHERE p.id=payment_id AND p.company_id=1 AND p.status='confirmed' AND p.amount=12500.25) THEN
    RAISE EXCEPTION 'QA_SOURCE_PAYMENT_MISMATCH';
  END IF;
  checks := array_append(checks,'Source payment remains company1');

  INSERT INTO public.accounting_entries
    (id,entry_number,journal_id,date,ref,description,status,source,source_id,total_debit,total_credit,
     created_by_id,company_id,source_module,source_schema,source_table,entry_status,source_event_id)
  VALUES(original_id,'QA-FLEET-DSV-ROLLBACK-PAY',journal_id,'2026-11-17','QA-FLEET-DSV-ROLLBACK',
    'Pembayaran driver fleet - QA FLEET DSV ROLLBACK','draft','fleet_cash_payment',payment_id,amount,amount,
    'fleet-finance-qa',3,'fleet_intelligence','public','fleet_cash_payments','DRAFT','fleet-cash-payment:1:990117301');
  INSERT INTO public.accounting_entry_lines
    (id,entry_id,account_id,description,debit,credit,company_id,source_module,source_table,source_id)
  VALUES
    (990117321,original_id,cash_id,'QA cash',amount,0,3,'fleet_intelligence','fleet_cash_payments',payment_id),
    (990117322,original_id,ar_id,'QA receivable',0,amount,3,'fleet_intelligence','fleet_cash_payments',payment_id);
  UPDATE public.accounting_entries SET status='posted',entry_status='POSTED',posted_at=NOW() WHERE id=original_id AND status='draft';
  SET CONSTRAINTS ALL IMMEDIATE;
  IF NOT EXISTS(SELECT 1 FROM public.accounting_entries WHERE id=original_id AND company_id=3 AND status='posted' AND total_debit=amount AND total_credit=amount) THEN
    RAISE EXCEPTION 'QA_POSTING_MISMATCH';
  END IF;
  IF (SELECT count(*) FROM public.accounting_entry_lines WHERE entry_id=original_id AND company_id=3)<>2 THEN
    RAISE EXCEPTION 'QA_POSTING_LINES_MISMATCH';
  END IF;
  checks := array_append(checks,'Draft -> two balanced Diva lines -> posted succeeds with installed triggers');

  IF (SELECT count(*) FROM public.fleet_ledger_entries WHERE source_ref='QA-FLEET-DSV-ROLLBACK-PAY' AND company_id=3)<>2 THEN
    RAISE EXCEPTION 'QA_DERIVED_LEDGER_MISSING_OR_WRONG_COMPANY';
  END IF;
  checks := array_append(checks,'Installed ledger trigger generates two company3 lines');

  BEGIN
    INSERT INTO public.accounting_entries
      (id,entry_number,journal_id,date,ref,status,source,source_id,total_debit,total_credit,created_by_id,company_id,entry_status)
    VALUES(990117313,'QA-FLEET-DSV-ROLLBACK-DUP',journal_id,'2026-11-17','QA-FLEET-DSV-ROLLBACK-DUP',
      'draft','fleet_cash_payment',payment_id,amount,amount,'fleet-finance-qa',3,'DRAFT');
    RAISE EXCEPTION 'QA_DUPLICATE_SOURCE_WAS_ACCEPTED';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS actual_constraint = CONSTRAINT_NAME;
    IF actual_constraint<>'accounting_entries_company_source_source_id_uniq' THEN RAISE; END IF;
  END;
  checks := array_append(checks,'Installed source uniqueness blocks a second journal');

  BEGIN
    INSERT INTO public.accounting_entries
      (id,entry_number,journal_id,date,status,source,source_id,created_by_id,company_id,entry_status)
    VALUES(990117313,'QA-FLEET-DSV-ROLLBACK-WRONG-JOURNAL',6,'2026-11-17','draft','fleet_cash_payment',990117399,'fleet-finance-qa',3,'DRAFT');
    RAISE EXCEPTION 'QA_WRONG_COMPANY_JOURNAL_WAS_ACCEPTED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%tidak cocok%' THEN RAISE; END IF;
  END;
  checks := array_append(checks,'Installed journal ownership guard rejects company1 journal under Diva');

  BEGIN
    UPDATE public.accounting_entries SET total_debit=1 WHERE id=original_id;
    RAISE EXCEPTION 'QA_POSTED_MUTATION_WAS_ACCEPTED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT ILIKE '%immutab%' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM public.accounting_entries WHERE id=original_id;
    RAISE EXCEPTION 'QA_POSTED_DELETE_WAS_ACCEPTED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT ILIKE '%immutab%' THEN RAISE; END IF;
  END;
  checks := array_append(checks,'Posted journal update and delete protections stay active');

  SELECT to_jsonb(e) INTO original_row FROM public.accounting_entries e WHERE id=original_id;
  INSERT INTO public.accounting_entries
    (id,entry_number,journal_id,date,ref,description,status,source,source_id,total_debit,total_credit,
     created_by_id,company_id,source_module,source_schema,source_table,entry_status,source_event_id,previous_entry_id)
  VALUES(reversal_id,'QA-FLEET-DSV-ROLLBACK-REV',journal_id,'2026-11-17','QA-FLEET-DSV-ROLLBACK-REV',
    'Pembatalan pembayaran driver fleet - QA FLEET DSV ROLLBACK','draft','reversal',original_id,amount,amount,
    'fleet-finance-qa',3,'fleet_intelligence','public','fleet_cash_payments','DRAFT',
    'fleet-cash-payment-reversal:1:990117301:990117311',original_id);
  INSERT INTO public.accounting_entry_lines
    (id,entry_id,account_id,description,debit,credit,company_id,source_module,source_table,source_id)
  SELECT (990117322+row_number() OVER(ORDER BY id))::integer,reversal_id,account_id,
    'Reversal '||COALESCE(description,''),credit,debit,3,'fleet_intelligence','fleet_cash_payments',payment_id
  FROM public.accounting_entry_lines WHERE entry_id=original_id AND company_id=3;
  UPDATE public.accounting_entries SET status='posted',entry_status='POSTED',posted_at=NOW() WHERE id=reversal_id AND status='draft';
  SET CONSTRAINTS ALL IMMEDIATE;
  IF (SELECT to_jsonb(e) FROM public.accounting_entries e WHERE id=original_id) IS DISTINCT FROM original_row THEN
    RAISE EXCEPTION 'QA_REVERSAL_MUTATED_ORIGINAL';
  END IF;
  IF EXISTS(SELECT account_id FROM public.accounting_entry_lines WHERE entry_id IN(original_id,reversal_id) GROUP BY account_id HAVING SUM(debit-credit)<>0) THEN
    RAISE EXCEPTION 'QA_REVERSAL_NET_NOT_ZERO';
  END IF;
  checks := array_append(checks,'Reversal uses original accounts and leaves original journal unchanged');

  IF (SELECT count(*) FROM public.fleet_ledger_entries WHERE source_ref IN('QA-FLEET-DSV-ROLLBACK-PAY','QA-FLEET-DSV-ROLLBACK-REV') AND company_id=3)<>4
    OR EXISTS(SELECT 1 FROM public.fleet_ledger_entries WHERE source_ref IN('QA-FLEET-DSV-ROLLBACK-PAY','QA-FLEET-DSV-ROLLBACK-REV') AND company_id<>3) THEN
    RAISE EXCEPTION 'QA_LEDGER_SCOPE_MISMATCH';
  END IF;
  IF EXISTS(SELECT 1 FROM public.accounting_entries WHERE id IN(original_id,reversal_id) AND company_id<>3)
    OR EXISTS(SELECT 1 FROM public.accounting_entry_lines WHERE entry_id IN(original_id,reversal_id) AND company_id<>3) THEN
    RAISE EXCEPTION 'QA_CROSS_COMPANY_POSTING';
  END IF;
  checks := array_append(checks,'Both journals, four journal lines, and four derived ledger lines belong only to Diva');

  PERFORM set_config('fleet_qa.rollback_result',
    jsonb_build_object('ok',true,'testsPassed',cardinality(checks),'checks',checks,
      'sourceCompanyId',1,'financeCompanyId',3,'cashAccountId',cash_id,'receivableAccountId',ar_id,
      'journalId',journal_id,'journalRowsBeforeRollback',2,'journalLinesBeforeRollback',4,
      'ledgerLinesBeforeRollback',4,'scope','actual CST-DEV database guards only; rollback required')::text,true);
END
$qa$;
SELECT current_setting('fleet_qa.rollback_result',true)::jsonb AS result;
ROLLBACK;
