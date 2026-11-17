-- Reviewed DEV source-to-AR projection for Issue #69.
-- Target: CST-DEV xssrfshdrtdfupgqwfdw ONLY. Never run against PROD.
-- No source invoice, GL, bank mutation, payment or historical AR backfill.
-- Activation rows start disabled; a reviewed DEV release enables them only
-- after verifying the actual session role and project. No GUC grants authority.
-- The existing issuer was verified on 2026-11-17 as session_user=current_user
-- postgres in cst-bizportal-gmail-dev.service, CST-DEV database postgres.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
DECLARE actor name; relation_name text;
BEGIN
  IF current_database() NOT IN ('postgres', 'cst_customer_ar_ci') THEN
    RAISE EXCEPTION 'CUSTOMER_AR_UNEXPECTED_DATABASE';
  END IF;
  FOREACH actor IN ARRAY ARRAY['bizportal_finance_cst_login_dev', 'bizportal_finance_diva_login_dev']::name[] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = actor
      AND NOT rolsuper AND NOT rolbypassrls AND NOT rolinherit) THEN
      RAISE EXCEPTION 'CUSTOMER_AR_COMPANY_ROLE_MISSING_OR_PRIVILEGED %', actor;
    END IF;
    FOREACH relation_name IN ARRAY ARRAY['sales_documents', 'accounting_entries',
      'accounting_entry_lines', 'accounting_settings', 'chart_of_accounts',
      'accounting_journals', 'ar_subledger'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = relation_name AND c.relrowsecurity) THEN
        RAISE EXCEPTION 'CUSTOMER_AR_RLS_REQUIRED %', relation_name;
      END IF;
      -- Exact rollback: these are new grants; never revoke an older grant.
      IF has_any_column_privilege(actor, 'public.' || relation_name, 'SELECT') THEN
        RAISE EXCEPTION 'CUSTOMER_AR_READ_GRANT_BASELINE_CHANGED % %', actor, relation_name;
      END IF;
    END LOOP;
    IF (has_any_column_privilege(actor, 'public.ar_subledger', 'INSERT,UPDATE')
      OR has_table_privilege(actor, 'public.ar_subledger', 'DELETE')) THEN
      RAISE EXCEPTION 'CUSTOMER_AR_WRITE_GRANT_BASELINE_CHANGED %', actor;
    END IF;
    IF has_sequence_privilege(actor, 'public.ar_subledger_id_seq', 'USAGE') THEN
      RAISE EXCEPTION 'CUSTOMER_AR_SEQUENCE_GRANT_BASELINE_CHANGED %', actor;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_indexes WHERE schemaname = 'public'
    AND tablename = 'ar_subledger' AND indexname = 'idx_ar_sub_invoice'
    AND indexdef LIKE '%UNIQUE% (company_id, invoice_id) WHERE (invoice_id IS NOT NULL)') THEN
    RAISE EXCEPTION 'CUSTOMER_AR_PARTIAL_UNIQUE_INDEX_REQUIRED';
  END IF;
END
$preflight$;

-- Policy configuration only, never a second ledger. Runtime actors cannot
-- insert/update/delete activation or widen their company/role mapping.
CREATE TABLE public.bizportal_customer_ar_source_actors_dev (
  role_name name NOT NULL,
  company_id integer NOT NULL CHECK (company_id IN (1, 3)),
  enabled boolean NOT NULL DEFAULT false,
  source_not_before timestamptz NOT NULL DEFAULT clock_timestamp(),
  verified_source text NOT NULL,
  PRIMARY KEY (role_name, company_id)
);
ALTER TABLE public.bizportal_customer_ar_source_actors_dev ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bizportal_customer_ar_source_actors_dev FROM PUBLIC;
GRANT SELECT ON public.bizportal_customer_ar_source_actors_dev
  TO bizportal_finance_cst_login_dev, bizportal_finance_diva_login_dev;
CREATE POLICY customer_ar_actor_self_read ON public.bizportal_customer_ar_source_actors_dev
  FOR SELECT TO bizportal_finance_cst_login_dev, bizportal_finance_diva_login_dev
  USING (role_name = session_user AND current_user = session_user);
INSERT INTO public.bizportal_customer_ar_source_actors_dev(role_name, company_id, verified_source)
VALUES
 ('postgres', 1, 'Verified CST-DEV upstream issuer session, 2026-11-17'),
 ('postgres', 3, 'Verified CST-DEV upstream issuer session, 2026-11-17'),
 ('bizportal_finance_cst_login_dev', 1, 'Existing company-bound Finance role; source writes remain separately owned'),
 ('bizportal_finance_diva_login_dev', 3, 'Existing company-bound Finance role; source writes remain separately owned');

-- BEGIN SHARED SOURCE EVIDENCE
CREATE VIEW public.bizportal_customer_ar_source_evidence_dev
WITH (security_invoker = true, security_barrier = true) AS
select sd.id as invoice_id, sd.company_id, sd.customer_id,
       sd.invoice_number, sd.invoice_date, sd.due_date,
       sd.grand_total::numeric as gross_amount,
       sd.amount_paid::numeric as paid_amount,
       (sd.grand_total - sd.amount_paid)::numeric as outstanding_amount,
       case when sd.amount_paid = sd.grand_total then 'PAID'
            when sd.amount_paid > 0 then 'PARTIAL' else 'OPEN' end as ar_status,
       entry.id as gl_entry_id, (entry.created_at AT TIME ZONE 'UTC') as source_created_at
from public.sales_documents sd
join public.accounting_settings settings on settings.company_id = sd.company_id
join public.chart_of_accounts ar_account on ar_account.id = settings.ar_account_id
  and ar_account.company_id = sd.company_id
  and ar_account.type::text = 'asset' and ar_account.subtype::text = 'receivable'
  and ar_account.is_active is true and ar_account.is_postable is true
  and ar_account.is_header is false
join public.accounting_journals journal on journal.id = settings.sales_journal_id
  and journal.company_id = sd.company_id and journal.type::text = 'sales'
join public.accounting_entries entry on entry.company_id = sd.company_id
  and entry.source::text = 'sales_invoice' and entry.source_id = sd.id
  and entry.journal_id = journal.id and entry.status::text = 'posted'
  and entry.is_voided is false and entry.is_reversed is false
  and entry.void_entry_id is null
join lateral (
  select count(*) as line_count,
         bool_and(account.id is not null
           and account.company_id = sd.company_id
           and (line.company_id is null or line.company_id = sd.company_id)
           and line.debit >= 0 and line.credit >= 0
           and line.debit::text not in ('NaN', 'Infinity', '-Infinity')
           and line.credit::text not in ('NaN', 'Infinity', '-Infinity')
           and (line.debit = 0 or line.credit = 0)) as lines_valid,
         sum(line.debit)::numeric as total_debit,
         sum(line.credit)::numeric as total_credit,
         coalesce(sum(line.debit) filter (where line.account_id = ar_account.id), 0)::numeric as ar_debit,
         coalesce(sum(line.credit) filter (where line.account_id = ar_account.id), 0)::numeric as ar_credit
  from public.accounting_entry_lines line
  left join public.chart_of_accounts account on account.id = line.account_id
  where line.entry_id = entry.id
) proof on proof.line_count >= 2 and proof.lines_valid is true
  and proof.total_debit = sd.grand_total and proof.total_credit = sd.grand_total
  and proof.ar_debit = sd.grand_total and proof.ar_credit = 0
  and entry.total_debit = proof.total_debit and entry.total_credit = proof.total_credit
where sd.invoice_status::text = 'invoiced' and sd.status::text in ('confirmed', 'done')
  and sd.cancelled_at is null
  and nullif(btrim(sd.invoice_number), '') is not null
  and sd.invoice_date is not null and sd.due_date >= sd.invoice_date
  and sd.grand_total::text not in ('NaN', 'Infinity', '-Infinity')
  and sd.amount_paid::text not in ('NaN', 'Infinity', '-Infinity')
  and sd.grand_total > 0 and sd.amount_paid >= 0 and sd.amount_paid <= sd.grand_total
  and ((sd.amount_paid = 0 and sd.payment_status::text in ('unpaid', 'overdue'))
    or (sd.amount_paid > 0 and sd.amount_paid < sd.grand_total and sd.payment_status::text in ('partial', 'overdue'))
    or (sd.amount_paid = sd.grand_total and sd.payment_status::text = 'paid'))
  and (select count(*) from public.accounting_settings other_settings
       where other_settings.company_id = sd.company_id) = 1
  and (select count(*) from public.accounting_entries other_entry
       where other_entry.company_id = sd.company_id
         and other_entry.source::text = 'sales_invoice' and other_entry.source_id = sd.id) = 1
  and (select count(*) from public.sales_documents other_invoice
       where other_invoice.company_id = sd.company_id
         and upper(btrim(other_invoice.invoice_number)) = upper(btrim(sd.invoice_number))) = 1
  and not exists (
    select 1 from public.accounting_entries reversal
    where reversal.company_id = sd.company_id and reversal.source::text = 'reversal'
      and reversal.source_id in (sd.id, entry.id) and reversal.journal_id = entry.journal_id
      and reversal.status::text = 'posted' and reversal.is_voided is false
      and reversal.is_reversed is false
  );
-- END SHARED SOURCE EVIDENCE
REVOKE ALL ON public.bizportal_customer_ar_source_evidence_dev FROM PUBLIC;
GRANT SELECT ON public.bizportal_customer_ar_source_evidence_dev
  TO bizportal_finance_cst_login_dev, bizportal_finance_diva_login_dev;

GRANT SELECT ON public.sales_documents, public.accounting_entries,
  public.accounting_entry_lines, public.accounting_settings, public.chart_of_accounts,
  public.accounting_journals, public.ar_subledger
  TO bizportal_finance_cst_login_dev, bizportal_finance_diva_login_dev;
GRANT INSERT (company_id, invoice_id, customer_id, invoice_number, invoice_date,
  due_date, currency, gross_amount, outstanding_amount, paid_amount, status,
  gl_entry_id, period, notes) ON public.ar_subledger
  TO bizportal_finance_cst_login_dev, bizportal_finance_diva_login_dev;
GRANT UPDATE (customer_id, invoice_number, invoice_date, due_date, gross_amount,
  outstanding_amount, paid_amount, status, period, updated_at) ON public.ar_subledger
  TO bizportal_finance_cst_login_dev, bizportal_finance_diva_login_dev;
GRANT USAGE ON SEQUENCE public.ar_subledger_id_seq
  TO bizportal_finance_cst_login_dev, bizportal_finance_diva_login_dev;

-- Fixed session identity is the authority. Neither SET ROLE nor a writable
-- app.company_id/app.marketplace_company_id GUC can impersonate another tenant.
DO $policies$
DECLARE relation_name text; scope_sql text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY['sales_documents', 'accounting_entries',
    'accounting_settings', 'chart_of_accounts', 'accounting_journals', 'ar_subledger'] LOOP
    scope_sql := '(current_user = session_user AND company_id = CASE session_user WHEN ''bizportal_finance_cst_login_dev'' THEN 1 WHEN ''bizportal_finance_diva_login_dev'' THEN 3 ELSE NULL END)';
    EXECUTE format('CREATE POLICY customer_ar_company_read_dev ON public.%I FOR SELECT TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev USING (%s)', relation_name, scope_sql);
    EXECUTE format('CREATE POLICY customer_ar_company_guard_dev ON public.%I AS RESTRICTIVE FOR ALL TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev USING (%s) WITH CHECK (%s)', relation_name, scope_sql, scope_sql);
  END LOOP;
END
$policies$;
-- Lines inherit the header company. Read every line of an owned header,
-- including malformed explicit company IDs, so evidence cannot overlook a
-- corrupt line hidden by RLS. The evidence rejects every conflicting line.
CREATE POLICY customer_ar_company_read_dev ON public.accounting_entry_lines
  FOR SELECT TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev
  USING (current_user = session_user AND EXISTS (
    SELECT 1 FROM public.accounting_entries parent WHERE parent.id = entry_id
      AND parent.company_id = CASE session_user WHEN 'bizportal_finance_cst_login_dev' THEN 1 WHEN 'bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END));
CREATE POLICY customer_ar_company_guard_dev ON public.accounting_entry_lines
  AS RESTRICTIVE FOR ALL TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev
  USING (current_user = session_user AND EXISTS (
    SELECT 1 FROM public.accounting_entries parent WHERE parent.id = entry_id
      AND parent.company_id = CASE session_user WHEN 'bizportal_finance_cst_login_dev' THEN 1 WHEN 'bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END))
  WITH CHECK (current_user = session_user AND EXISTS (
    SELECT 1 FROM public.accounting_entries parent WHERE parent.id = entry_id
      AND parent.company_id = CASE session_user WHEN 'bizportal_finance_cst_login_dev' THEN 1 WHEN 'bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END));

CREATE POLICY customer_ar_insert_proven_source_dev ON public.ar_subledger
  FOR INSERT TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev
  WITH CHECK (notes = 'bizportal:customer-ar-source:v1' AND currency = 'IDR'
    AND EXISTS (SELECT 1 FROM public.bizportal_customer_ar_source_actors_dev actor
      WHERE actor.role_name = session_user AND actor.company_id = ar_subledger.company_id AND actor.enabled)
    AND EXISTS (SELECT 1 FROM public.bizportal_customer_ar_source_evidence_dev e
      WHERE e.company_id = ar_subledger.company_id AND e.invoice_id = ar_subledger.invoice_id
        AND e.gl_entry_id = ar_subledger.gl_entry_id
        AND e.customer_id IS NOT DISTINCT FROM ar_subledger.customer_id
        AND e.invoice_number = ar_subledger.invoice_number AND e.invoice_date = ar_subledger.invoice_date
        AND e.due_date = ar_subledger.due_date AND e.gross_amount = ar_subledger.gross_amount
        AND e.paid_amount = ar_subledger.paid_amount AND e.outstanding_amount = ar_subledger.outstanding_amount
        AND e.ar_status = ar_subledger.status AND ar_subledger.period = to_char(e.invoice_date, 'YYYY-MM')
        AND e.source_created_at >= (SELECT actor.source_not_before
          FROM public.bizportal_customer_ar_source_actors_dev actor WHERE actor.role_name = session_user
            AND actor.company_id = ar_subledger.company_id AND actor.enabled)));
CREATE POLICY customer_ar_update_owned_projection_dev ON public.ar_subledger
  FOR UPDATE TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev
  USING (notes = 'bizportal:customer-ar-source:v1' AND EXISTS (
    SELECT 1 FROM public.bizportal_customer_ar_source_actors_dev actor
    WHERE actor.role_name = session_user AND actor.company_id = ar_subledger.company_id AND actor.enabled))
  WITH CHECK (notes = 'bizportal:customer-ar-source:v1' AND currency = 'IDR'
    AND (status = 'STALE' OR EXISTS (
      SELECT 1 FROM public.bizportal_customer_ar_source_evidence_dev e
      WHERE e.company_id = ar_subledger.company_id AND e.invoice_id = ar_subledger.invoice_id
        AND e.gl_entry_id = ar_subledger.gl_entry_id
        AND e.customer_id IS NOT DISTINCT FROM ar_subledger.customer_id
        AND e.invoice_number = ar_subledger.invoice_number AND e.invoice_date = ar_subledger.invoice_date
        AND e.due_date = ar_subledger.due_date AND e.gross_amount = ar_subledger.gross_amount
        AND e.paid_amount = ar_subledger.paid_amount AND e.outstanding_amount = ar_subledger.outstanding_amount
        AND e.ar_status = ar_subledger.status AND ar_subledger.period = to_char(e.invoice_date, 'YYYY-MM'))));

-- RLS permits a STALE status when the source disappears. That exception must
-- not permit callers to overwrite financial/identity history while staling it.
CREATE FUNCTION public.bizportal_customer_ar_stale_guard_dev()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog
AS $guard$
BEGIN
  IF NEW.status = 'STALE' AND OLD.notes = 'bizportal:customer-ar-source:v1'
    AND (to_jsonb(NEW) - ARRAY['status', 'updated_at'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'updated_at']) THEN
    RAISE EXCEPTION 'CUSTOMER_AR_STALE_MUST_PRESERVE_SOURCE_VALUES' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;
REVOKE ALL ON FUNCTION public.bizportal_customer_ar_stale_guard_dev() FROM PUBLIC;
CREATE TRIGGER customer_ar_stale_row_guard_dev BEFORE UPDATE ON public.ar_subledger
FOR EACH ROW EXECUTE FUNCTION public.bizportal_customer_ar_stale_guard_dev();

CREATE FUNCTION public.bizportal_customer_ar_after_source_dev()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog SET timezone = 'UTC'
AS $link$
DECLARE
  candidates jsonb := '[]'::jsonb;
  candidate record;
  evidence record;
  activation timestamptz;
  relation_name text;
  new_row jsonb;
  old_row jsonb;
BEGIN
  -- Unknown/disabled actors leave existing posting behavior unchanged. The
  -- privileged legacy issuer is explicit in admin-owned config, not inferred
  -- from admin membership or supplied via GUC.
  IF current_user <> session_user OR NOT has_table_privilege(current_user,
    'public.bizportal_customer_ar_source_actors_dev', 'SELECT') THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bizportal_customer_ar_source_actors_dev
    WHERE role_name = session_user AND enabled) THEN RETURN NULL; END IF;
  FOREACH relation_name IN ARRAY ARRAY['sales_documents', 'accounting_entries',
    'accounting_entry_lines', 'accounting_settings', 'chart_of_accounts',
    'accounting_journals', 'ar_subledger', 'bizportal_customer_ar_source_evidence_dev'] LOOP
    IF NOT has_table_privilege(current_user, 'public.' || relation_name, 'SELECT') THEN
      RAISE WARNING 'CUSTOMER_AR_ACTOR_READ_PRIVILEGE_INCOMPLETE %', relation_name;
      RETURN NULL;
    END IF;
  END LOOP;
  IF TG_OP <> 'DELETE' THEN new_row := to_jsonb(NEW); END IF;
  IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD); END IF;
  IF TG_TABLE_NAME = 'sales_documents' THEN
    candidates := jsonb_build_array(
      jsonb_build_object('company_id', new_row->'company_id', 'invoice_id', new_row->'id'),
      jsonb_build_object('company_id', old_row->'company_id', 'invoice_id', old_row->'id'));
  ELSIF TG_TABLE_NAME = 'accounting_entries' THEN
    IF new_row->>'source' IN ('sales_invoice', 'reversal') THEN
      candidates := candidates || jsonb_build_array(jsonb_build_object('company_id', new_row->'company_id', 'invoice_id', new_row->'source_id', 'source', new_row->'source', 'journal_id', new_row->'journal_id'));
    END IF;
    IF old_row->>'source' IN ('sales_invoice', 'reversal') THEN
      candidates := candidates || jsonb_build_array(jsonb_build_object('company_id', old_row->'company_id', 'invoice_id', old_row->'source_id', 'source', old_row->'source', 'journal_id', old_row->'journal_id'));
    END IF;
  ELSIF TG_TABLE_NAME = 'accounting_entry_lines' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('company_id', company_id, 'invoice_id', source_id, 'source', source::text, 'journal_id', journal_id)), '[]'::jsonb)
      INTO candidates FROM public.accounting_entries
      WHERE id IN ((new_row->>'entry_id')::integer, (old_row->>'entry_id')::integer)
        AND source::text IN ('sales_invoice', 'reversal');
  ELSE RAISE EXCEPTION 'CUSTOMER_AR_UNEXPECTED_TRIGGER_RELATION'; END IF;
  -- Sales reversal uses invoice id; the generic canonical reverseJournal
  -- uses original entry id. Resolve both within the same company and journal.
  SELECT candidates || coalesce(jsonb_agg(jsonb_build_object(
    'company_id', original.company_id, 'invoice_id', original.source_id)), '[]'::jsonb)
    INTO candidates
  FROM jsonb_to_recordset(candidates) AS x(company_id integer, invoice_id integer, source text, journal_id integer)
  JOIN public.accounting_entries original ON original.id = x.invoice_id
    AND original.company_id = x.company_id AND original.source::text = 'sales_invoice'
    AND original.journal_id = x.journal_id
  WHERE x.source = 'reversal';
  -- Filter BEFORE isolation/locking: unapproved companies cannot change the
  -- posting behavior of an otherwise approved administrative issuer.
  SELECT coalesce(jsonb_agg(jsonb_build_object('company_id', x.company_id,
    'invoice_id', x.invoice_id)), '[]'::jsonb) INTO candidates
  FROM jsonb_to_recordset(candidates) AS x(company_id integer, invoice_id integer)
  JOIN public.bizportal_customer_ar_source_actors_dev actor
    ON actor.role_name = session_user AND actor.company_id = x.company_id AND actor.enabled
  WHERE x.company_id IS NOT NULL AND x.invoice_id IS NOT NULL;
  IF candidates = '[]'::jsonb THEN RETURN NULL; END IF;
  -- One DEV projection lock avoids opposite invoice lock ordering within
  -- batch transactions. Each following statement sees a fresh RC snapshot;
  -- journal-first and invoice-first concurrent commits therefore converge.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CUSTOMER_AR_SOURCE_REQUIRES_READ_COMMITTED_RETRY' USING ERRCODE = '40001';
  END IF;
  PERFORM pg_advisory_xact_lock(69069, 1);
  FOR candidate IN SELECT DISTINCT x.company_id, x.invoice_id
    FROM jsonb_to_recordset(candidates) AS x(company_id integer, invoice_id integer)
    WHERE x.company_id IS NOT NULL AND x.invoice_id IS NOT NULL
    ORDER BY x.company_id, x.invoice_id
  LOOP
    SELECT source_not_before INTO activation FROM public.bizportal_customer_ar_source_actors_dev
      WHERE role_name = session_user AND company_id = candidate.company_id AND enabled;
    IF NOT FOUND THEN CONTINUE; END IF;
    SELECT * INTO evidence FROM public.bizportal_customer_ar_source_evidence_dev e
      WHERE e.company_id = candidate.company_id AND e.invoice_id = candidate.invoice_id
        AND e.source_created_at >= activation;
    IF NOT FOUND THEN
      -- Never erase history or alter another owner's AR row. Preview rechecks
      -- proof independently, including reversals written by an unlisted actor.
      UPDATE public.ar_subledger SET status = 'STALE', updated_at = clock_timestamp()
        WHERE company_id = candidate.company_id AND invoice_id = candidate.invoice_id
          AND notes = 'bizportal:customer-ar-source:v1' AND status <> 'STALE';
      CONTINUE;
    END IF;
    INSERT INTO public.ar_subledger AS ledger
      (company_id, invoice_id, customer_id, invoice_number, invoice_date, due_date,
       currency, gross_amount, outstanding_amount, paid_amount, status, gl_entry_id, period, notes)
    VALUES (evidence.company_id, evidence.invoice_id, evidence.customer_id,
      evidence.invoice_number, evidence.invoice_date, evidence.due_date, 'IDR',
      evidence.gross_amount, evidence.outstanding_amount, evidence.paid_amount,
      evidence.ar_status, evidence.gl_entry_id, to_char(evidence.invoice_date, 'YYYY-MM'),
      'bizportal:customer-ar-source:v1')
    ON CONFLICT (company_id, invoice_id) WHERE invoice_id IS NOT NULL DO UPDATE
      SET customer_id = EXCLUDED.customer_id, invoice_number = EXCLUDED.invoice_number,
          invoice_date = EXCLUDED.invoice_date, due_date = EXCLUDED.due_date,
          gross_amount = EXCLUDED.gross_amount, outstanding_amount = EXCLUDED.outstanding_amount,
          paid_amount = EXCLUDED.paid_amount, status = EXCLUDED.status,
          period = EXCLUDED.period, updated_at = clock_timestamp()
      WHERE ledger.notes = 'bizportal:customer-ar-source:v1'
        AND ledger.gl_entry_id = EXCLUDED.gl_entry_id
        AND ROW(ledger.customer_id, ledger.invoice_number, ledger.invoice_date, ledger.due_date,
          ledger.gross_amount, ledger.outstanding_amount, ledger.paid_amount, ledger.status, ledger.period)
          IS DISTINCT FROM ROW(EXCLUDED.customer_id, EXCLUDED.invoice_number, EXCLUDED.invoice_date,
          EXCLUDED.due_date, EXCLUDED.gross_amount, EXCLUDED.outstanding_amount,
          EXCLUDED.paid_amount, EXCLUDED.status, EXCLUDED.period);
  END LOOP;
  RETURN NULL;
EXCEPTION WHEN insufficient_privilege THEN
  -- A revoked role grant must not break an existing canonical source posting.
  -- This subtransaction's projection changes roll back; preview stays unproven.
  RAISE WARNING 'CUSTOMER_AR_ACTOR_WRITE_PRIVILEGE_INCOMPLETE';
  RETURN NULL;
END
$link$;
REVOKE ALL ON FUNCTION public.bizportal_customer_ar_after_source_dev() FROM PUBLIC;
COMMENT ON FUNCTION public.bizportal_customer_ar_after_source_dev() IS
 'DEV only. SECURITY INVOKER projection of existing posted invoice sources into existing AR; no payment or journal writer.';

CREATE CONSTRAINT TRIGGER customer_ar_sales_source_dev
AFTER INSERT OR UPDATE OR DELETE ON public.sales_documents
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.bizportal_customer_ar_after_source_dev();
CREATE CONSTRAINT TRIGGER customer_ar_journal_source_dev
AFTER INSERT OR UPDATE OR DELETE ON public.accounting_entries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.bizportal_customer_ar_after_source_dev();
CREATE CONSTRAINT TRIGGER customer_ar_journal_lines_dev
AFTER INSERT OR UPDATE OR DELETE ON public.accounting_entry_lines
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.bizportal_customer_ar_after_source_dev();
COMMIT;
