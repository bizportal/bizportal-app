-- Existing CST-DEV function definitions, inspected read-only 2026-11-17.
-- Snapshot only; runner applies this to its disposable database, never live.
CREATE OR REPLACE FUNCTION public.payroll_financial_period_insert_audit()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
 IF current_user='bizportal_payroll_dev' THEN
  INSERT INTO public.payroll_financial_setup_events(company_id,run_id,action,period_id,request_id,actor_id,actor_email,note)
  VALUES(NEW.company_id,NULLIF(current_setting('app.payroll_setup_run_id',true),'')::integer,'period_registered',NEW.id,
    NULLIF(current_setting('app.payroll_setup_request_id',true),'')::uuid,current_setting('app.payroll_setup_actor_id',true),current_setting('app.payroll_setup_actor_email',true),current_setting('app.payroll_setup_note',true));
 END IF;
 RETURN NEW;
END $function$
;
CREATE OR REPLACE FUNCTION public.payroll_financial_setup_event_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE run_row public.payroll_runs%ROWTYPE; period_row public.financial_periods%ROWTYPE; valid_bank boolean; current_version text;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYROLL_FINANCIAL_SETUP_AUDIT_IMMUTABLE'; END IF;
 IF NEW.company_id IS DISTINCT FROM NULLIF(current_setting('app.payroll_company_id',true),'')::integer
 OR NEW.run_id IS DISTINCT FROM NULLIF(current_setting('app.payroll_setup_run_id',true),'')::integer
 OR NEW.actor_id IS DISTINCT FROM current_setting('app.payroll_setup_actor_id',true)
 OR NEW.actor_email IS DISTINCT FROM current_setting('app.payroll_setup_actor_email',true)
 OR NEW.request_id IS DISTINCT FROM NULLIF(current_setting('app.payroll_setup_request_id',true),'')::uuid
 OR NEW.note IS DISTINCT FROM current_setting('app.payroll_setup_note',true)
 THEN RAISE EXCEPTION 'PAYROLL_FINANCIAL_SETUP_CONTEXT_MISMATCH'; END IF;
 SELECT * INTO run_row FROM public.payroll_runs WHERE id=NEW.run_id AND company_id=NEW.company_id;
 IF NOT FOUND OR run_row.status IS NULL OR run_row.status NOT IN ('draft','reviewed') OR run_row.posting_status IS DISTINCT FROM 'pending' OR run_row.accounting_entry_id IS NOT NULL OR run_row.payment_entry_id IS NOT NULL
 THEN RAISE EXCEPTION 'PAYROLL_FINANCIAL_SETUP_RUN_NOT_ELIGIBLE'; END IF;
 SELECT * INTO period_row FROM public.financial_periods WHERE id=NEW.period_id AND company_id=NEW.company_id AND month=run_row.month AND year=run_row.year;
 IF NOT FOUND OR period_row.is_closed OR EXISTS(SELECT 1 FROM public.accounting_period_locks WHERE company_id=NEW.company_id AND month=run_row.month AND year=run_row.year AND status IS DISTINCT FROM 'unlocked')
 THEN RAISE EXCEPTION 'PAYROLL_FINANCIAL_SETUP_PERIOD_NOT_OPEN'; END IF;
 IF NEW.action='period_registered' AND pg_trigger_depth()<>2 THEN RAISE EXCEPTION 'PERIOD_AUDIT_REQUIRES_INSERT_TRIGGER'; END IF;
 IF NEW.action='funding_approved' THEN
  IF current_setting('app.payroll_setup_ownership_confirmed',true) IS DISTINCT FROM 'true' OR current_setting('app.payroll_setup_authority_confirmed',true) IS DISTINCT FROM 'true'
  THEN RAISE EXCEPTION 'FUNDING_ATTESTATION_REQUIRED'; END IF;
  -- Never approve funding from a bank/COA shared by another active bank account
  -- in the same company; it would make bank-specific ledger balance ambiguous.
  IF EXISTS (
    SELECT 1 FROM public.company_bank_accounts selected
    JOIN public.company_bank_accounts peer
      ON peer.company_id=selected.company_id AND peer.coa_id=selected.coa_id
     AND peer.id<>selected.id AND peer.account_type='bank' AND peer.is_active IS TRUE
    WHERE selected.id=NEW.bank_account_id AND selected.company_id=NEW.company_id
      AND selected.coa_id IS NOT NULL
  ) THEN RAISE EXCEPTION 'PAYROLL_FUNDING_DUPLICATE_ACTIVE_BANK_COA'; END IF;
  SELECT (b.account_type='bank' AND b.is_active IS TRUE AND COALESCE(NULLIF(b.currency_code,''),b.currency)='IDR'
      AND NULLIF(btrim(b.account_number),'') IS NOT NULL AND NULLIF(btrim(b.account_holder),'') IS NOT NULL AND NULLIF(btrim(b.bank_name),'') IS NOT NULL
      AND a.id IS NOT NULL AND (a.company_id=NEW.company_id OR a.company_id IS NULL)
      AND COALESCE(a.account_type::text,a.type::text)='asset' AND a.is_active IS TRUE AND a.is_header IS FALSE AND a.is_postable IS TRUE) IS TRUE,
    encode(sha256(convert_to(to_jsonb(b)::text || COALESCE(to_jsonb(a)::text,''),'UTF8')),'hex')
   INTO valid_bank,current_version FROM public.company_bank_accounts b LEFT JOIN public.chart_of_accounts a ON a.id=b.coa_id
   WHERE b.id=NEW.bank_account_id AND b.company_id=NEW.company_id;
  IF NOT FOUND OR valid_bank IS DISTINCT FROM true OR current_version IS DISTINCT FROM NEW.source_version
  THEN RAISE EXCEPTION 'FUNDING_SOURCE_INVALID_OR_CHANGED'; END IF;
 END IF;
 RETURN NEW;
END $function$
;
