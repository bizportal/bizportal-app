-- DEV ONLY: xssrfshdrtdfupgqwfdw (CST-DEV).
-- Reuse the existing Fleet service and canonical Finance receiver.
-- Source company 1; Finance target company 3 / PT Diva Servis.
-- Credentials are provisioned separately and never stored in this migration.
-- No changes to existing readers, shared Finance roles, triggers, or PROD.
BEGIN;
DO $preflight$
DECLARE expected_table text;
BEGIN
  IF current_database() <> 'postgres' THEN RAISE EXCEPTION 'Expected postgres database'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('fleet_cash_source_login_dev','bizportal_fleet_finance_login_dev')) THEN
    RAISE EXCEPTION 'Dedicated Fleet runtime identities already exist; inspect rather than overwrite';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id=1 AND is_active IS TRUE)
     OR NOT EXISTS (SELECT 1 FROM public.companies WHERE id=3 AND name='PT Diva Servis' AND is_active IS TRUE) THEN
    RAISE EXCEPTION 'Expected active Fleet source and Diva destination';
  END IF;
  FOREACH expected_table IN ARRAY ARRAY['companies','accounting_settings','chart_of_accounts','accounting_journals','accounting_entries','accounting_entry_lines','fleet_ledger_entries','financial_periods','fleet_cash_payments','fleet_outstanding'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=expected_table AND c.relrowsecurity) THEN
      RAISE EXCEPTION 'Required RLS is not active on %',expected_table;
    END IF;
  END LOOP;
END $preflight$;

CREATE ROLE fleet_cash_source_login_dev LOGIN PASSWORD NULL NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 2;
GRANT CONNECT ON DATABASE postgres TO fleet_cash_source_login_dev;
GRANT USAGE ON SCHEMA public TO fleet_cash_source_login_dev;
ALTER ROLE fleet_cash_source_login_dev IN DATABASE postgres SET statement_timeout = '20s';
ALTER ROLE fleet_cash_source_login_dev IN DATABASE postgres SET lock_timeout = '5s';
ALTER ROLE fleet_cash_source_login_dev IN DATABASE postgres SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE fleet_cash_source_login_dev IN DATABASE postgres SET search_path = pg_catalog,public;

CREATE ROLE bizportal_fleet_finance_login_dev LOGIN PASSWORD NULL NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 2;
GRANT CONNECT ON DATABASE postgres TO bizportal_fleet_finance_login_dev;
GRANT USAGE ON SCHEMA public TO bizportal_fleet_finance_login_dev;
ALTER ROLE bizportal_fleet_finance_login_dev IN DATABASE postgres SET statement_timeout = '20s';
ALTER ROLE bizportal_fleet_finance_login_dev IN DATABASE postgres SET lock_timeout = '5s';
ALTER ROLE bizportal_fleet_finance_login_dev IN DATABASE postgres SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE bizportal_fleet_finance_login_dev IN DATABASE postgres SET search_path = pg_catalog,public;

-- Fleet source identity: operational cash rows and balances only.
GRANT SELECT,INSERT ON public.fleet_cash_payments TO fleet_cash_source_login_dev;
GRANT UPDATE (status,accounting_entry_id,updated_at) ON public.fleet_cash_payments TO fleet_cash_source_login_dev;
GRANT SELECT ON public.fleet_outstanding TO fleet_cash_source_login_dev;
GRANT UPDATE (outstanding_amount,status,resolved_at,updated_at) ON public.fleet_outstanding TO fleet_cash_source_login_dev;
GRANT USAGE ON SEQUENCE public.fleet_cash_payments_id_seq TO fleet_cash_source_login_dev;
-- Receipt metadata is needed only to enforce the intentional 1 -> 3 link.
GRANT SELECT (id,company_id,source,source_id,source_module,source_schema,source_table,source_event_id,status,entry_status)
ON public.accounting_entries TO fleet_cash_source_login_dev;

CREATE POLICY fleet_source_receipt_read_dev ON public.accounting_entries
AS PERMISSIVE FOR SELECT TO fleet_cash_source_login_dev
USING ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'fleet_cash_source_login_dev' AND company_id = 3 AND source = 'fleet_cash_payment' AND source_module = 'fleet_intelligence' AND source_schema = 'public' AND source_table = 'fleet_cash_payments' AND source_id > 0 AND source_event_id = 'fleet-cash-payment:1:' || source_id::text));

CREATE POLICY fleet_source_receipt_boundary_dev ON public.accounting_entries
AS RESTRICTIVE FOR ALL TO fleet_cash_source_login_dev
USING ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'fleet_cash_source_login_dev' AND company_id = 3 AND source = 'fleet_cash_payment' AND source_module = 'fleet_intelligence' AND source_schema = 'public' AND source_table = 'fleet_cash_payments' AND source_id > 0 AND source_event_id = 'fleet-cash-payment:1:' || source_id::text))
WITH CHECK ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'fleet_cash_source_login_dev' AND company_id = 3 AND source = 'fleet_cash_payment' AND source_module = 'fleet_intelligence' AND source_schema = 'public' AND source_table = 'fleet_cash_payments' AND source_id > 0 AND source_event_id = 'fleet-cash-payment:1:' || source_id::text));

CREATE POLICY fleet_cash_source_read_dev ON public.fleet_cash_payments
AS PERMISSIVE FOR SELECT TO fleet_cash_source_login_dev
USING ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'fleet_cash_source_login_dev' AND company_id = 1));

CREATE POLICY fleet_cash_source_insert_dev ON public.fleet_cash_payments
AS PERMISSIVE FOR INSERT TO fleet_cash_source_login_dev
WITH CHECK ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'fleet_cash_source_login_dev' AND company_id = 1) AND amount > 0 AND status='confirmed' AND accounting_entry_id IS NULL);

CREATE POLICY fleet_cash_source_update_dev ON public.fleet_cash_payments
AS PERMISSIVE FOR UPDATE TO fleet_cash_source_login_dev
USING ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'fleet_cash_source_login_dev' AND company_id = 1))
WITH CHECK ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'fleet_cash_source_login_dev' AND company_id = 1) AND amount > 0 AND ((status='confirmed' AND accounting_entry_id IS NULL) OR (status IN ('posted','cancelled') AND accounting_entry_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.accounting_entries e WHERE e.id=fleet_cash_payments.accounting_entry_id AND e.company_id=3 AND e.source='fleet_cash_payment' AND e.source_id=fleet_cash_payments.id AND e.status='posted' AND e.entry_status='POSTED' AND e.source_event_id='fleet-cash-payment:1:' || fleet_cash_payments.id::text))));

CREATE POLICY fleet_cash_source_boundary_dev ON public.fleet_cash_payments
AS RESTRICTIVE FOR ALL TO fleet_cash_source_login_dev
USING ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'fleet_cash_source_login_dev' AND company_id = 1))
WITH CHECK ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'fleet_cash_source_login_dev' AND company_id = 1));

CREATE POLICY fleet_cash_outstanding_read_dev ON public.fleet_outstanding
AS PERMISSIVE FOR SELECT TO fleet_cash_source_login_dev
USING ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'fleet_cash_source_login_dev' AND company_id = 1));

CREATE POLICY fleet_cash_outstanding_update_dev ON public.fleet_outstanding
AS PERMISSIVE FOR UPDATE TO fleet_cash_source_login_dev
USING ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'fleet_cash_source_login_dev' AND company_id = 1))
WITH CHECK ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'fleet_cash_source_login_dev' AND company_id = 1) AND outstanding_amount >= 0);

CREATE POLICY fleet_cash_outstanding_boundary_dev ON public.fleet_outstanding
AS RESTRICTIVE FOR ALL TO fleet_cash_source_login_dev
USING ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'fleet_cash_source_login_dev' AND company_id = 1))
WITH CHECK ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'fleet_cash_source_login_dev' AND company_id = 1));

-- Finance identity: source payment read/lock only. WITH CHECK(false) forbids
-- actual source mutation even if a broader permissive policy is added later.
GRANT SELECT ON public.fleet_cash_payments TO bizportal_fleet_finance_login_dev;
GRANT UPDATE (id) ON public.fleet_cash_payments TO bizportal_fleet_finance_login_dev;

CREATE POLICY fleet_finance_source_read_dev ON public.fleet_cash_payments
AS PERMISSIVE FOR SELECT TO bizportal_fleet_finance_login_dev
USING ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id=1));

CREATE POLICY fleet_finance_source_lock_dev ON public.fleet_cash_payments
AS PERMISSIVE FOR UPDATE TO bizportal_fleet_finance_login_dev
USING ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id=1))
WITH CHECK (false);

CREATE POLICY fleet_finance_source_boundary_dev ON public.fleet_cash_payments
AS RESTRICTIVE FOR ALL TO bizportal_fleet_finance_login_dev
USING ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id=1))
WITH CHECK ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id=1));

CREATE POLICY fleet_finance_source_no_mutation_dev ON public.fleet_cash_payments
AS RESTRICTIVE FOR UPDATE TO bizportal_fleet_finance_login_dev
USING (true)
WITH CHECK (false);

GRANT SELECT (id,is_active) ON public.companies TO bizportal_fleet_finance_login_dev;
GRANT SELECT ON public.accounting_settings,public.chart_of_accounts,public.accounting_journals,public.financial_periods TO bizportal_fleet_finance_login_dev;
GRANT SELECT,INSERT ON public.accounting_entries,public.accounting_entry_lines,public.fleet_ledger_entries TO bizportal_fleet_finance_login_dev;
GRANT UPDATE (status,entry_status,posted_at) ON public.accounting_entries TO bizportal_fleet_finance_login_dev;
GRANT USAGE ON SEQUENCE public.accounting_entries_id_seq,public.accounting_entry_lines_id_seq,public.fleet_ledger_entries_id_seq TO bizportal_fleet_finance_login_dev;

CREATE POLICY fleet_finance_target_read_dev ON public.companies
AS PERMISSIVE FOR SELECT TO bizportal_fleet_finance_login_dev
USING (CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND id=3 AND is_active IS TRUE);

CREATE POLICY fleet_finance_target_boundary_dev ON public.companies
AS RESTRICTIVE FOR ALL TO bizportal_fleet_finance_login_dev
USING (CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND id=3 AND is_active IS TRUE)
WITH CHECK (CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND id=3 AND is_active IS TRUE);

CREATE POLICY fleet_finance_target_read_dev ON public.accounting_settings
AS PERMISSIVE FOR SELECT TO bizportal_fleet_finance_login_dev
USING (CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id=3);

CREATE POLICY fleet_finance_target_boundary_dev ON public.accounting_settings
AS RESTRICTIVE FOR ALL TO bizportal_fleet_finance_login_dev
USING (CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id=3)
WITH CHECK (CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id=3);

CREATE POLICY fleet_finance_target_read_dev ON public.chart_of_accounts
AS PERMISSIVE FOR SELECT TO bizportal_fleet_finance_login_dev
USING (CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id=3);

CREATE POLICY fleet_finance_target_boundary_dev ON public.chart_of_accounts
AS RESTRICTIVE FOR ALL TO bizportal_fleet_finance_login_dev
USING (CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id=3)
WITH CHECK (CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id=3);

CREATE POLICY fleet_finance_target_read_dev ON public.accounting_journals
AS PERMISSIVE FOR SELECT TO bizportal_fleet_finance_login_dev
USING (CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id=3);

CREATE POLICY fleet_finance_target_boundary_dev ON public.accounting_journals
AS RESTRICTIVE FOR ALL TO bizportal_fleet_finance_login_dev
USING (CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id=3)
WITH CHECK (CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id=3);

CREATE POLICY fleet_finance_target_read_dev ON public.financial_periods
AS PERMISSIVE FOR SELECT TO bizportal_fleet_finance_login_dev
USING (CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id=3);

CREATE POLICY fleet_finance_target_boundary_dev ON public.financial_periods
AS RESTRICTIVE FOR ALL TO bizportal_fleet_finance_login_dev
USING (CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id=3)
WITH CHECK (CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id=3);

CREATE POLICY fleet_finance_entry_read_dev ON public.accounting_entries
AS PERMISSIVE FOR SELECT TO bizportal_fleet_finance_login_dev
USING ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id = 3 AND source_module = 'fleet_intelligence' AND source_schema = 'public' AND source_table = 'fleet_cash_payments' AND source_id > 0 AND ((source = 'fleet_cash_payment' AND source_event_id = 'fleet-cash-payment:1:' || source_id::text) OR (source = 'reversal' AND previous_entry_id = source_id AND source_event_id ~ '^fleet-cash-payment-reversal:1:[1-9][0-9]*:[1-9][0-9]*$'))));

CREATE POLICY fleet_finance_entry_insert_dev ON public.accounting_entries
AS PERMISSIVE FOR INSERT TO bizportal_fleet_finance_login_dev
WITH CHECK ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id = 3 AND source_module = 'fleet_intelligence' AND source_schema = 'public' AND source_table = 'fleet_cash_payments' AND source_id > 0 AND ((source = 'fleet_cash_payment' AND source_event_id = 'fleet-cash-payment:1:' || source_id::text) OR (source = 'reversal' AND previous_entry_id = source_id AND source_event_id ~ '^fleet-cash-payment-reversal:1:[1-9][0-9]*:[1-9][0-9]*$'))) AND status='draft' AND entry_status='DRAFT');

CREATE POLICY fleet_finance_entry_post_dev ON public.accounting_entries
AS PERMISSIVE FOR UPDATE TO bizportal_fleet_finance_login_dev
USING ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id = 3 AND source_module = 'fleet_intelligence' AND source_schema = 'public' AND source_table = 'fleet_cash_payments' AND source_id > 0 AND ((source = 'fleet_cash_payment' AND source_event_id = 'fleet-cash-payment:1:' || source_id::text) OR (source = 'reversal' AND previous_entry_id = source_id AND source_event_id ~ '^fleet-cash-payment-reversal:1:[1-9][0-9]*:[1-9][0-9]*$'))))
WITH CHECK ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id = 3 AND source_module = 'fleet_intelligence' AND source_schema = 'public' AND source_table = 'fleet_cash_payments' AND source_id > 0 AND ((source = 'fleet_cash_payment' AND source_event_id = 'fleet-cash-payment:1:' || source_id::text) OR (source = 'reversal' AND previous_entry_id = source_id AND source_event_id ~ '^fleet-cash-payment-reversal:1:[1-9][0-9]*:[1-9][0-9]*$'))) AND status='posted' AND entry_status='POSTED');

CREATE POLICY fleet_finance_entry_boundary_dev ON public.accounting_entries
AS RESTRICTIVE FOR ALL TO bizportal_fleet_finance_login_dev
USING ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id = 3 AND source_module = 'fleet_intelligence' AND source_schema = 'public' AND source_table = 'fleet_cash_payments' AND source_id > 0 AND ((source = 'fleet_cash_payment' AND source_event_id = 'fleet-cash-payment:1:' || source_id::text) OR (source = 'reversal' AND previous_entry_id = source_id AND source_event_id ~ '^fleet-cash-payment-reversal:1:[1-9][0-9]*:[1-9][0-9]*$'))))
WITH CHECK ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id = 3 AND source_module = 'fleet_intelligence' AND source_schema = 'public' AND source_table = 'fleet_cash_payments' AND source_id > 0 AND ((source = 'fleet_cash_payment' AND source_event_id = 'fleet-cash-payment:1:' || source_id::text) OR (source = 'reversal' AND previous_entry_id = source_id AND source_event_id ~ '^fleet-cash-payment-reversal:1:[1-9][0-9]*:[1-9][0-9]*$'))));

CREATE POLICY fleet_finance_line_read_dev ON public.accounting_entry_lines
AS PERMISSIVE FOR SELECT TO bizportal_fleet_finance_login_dev
USING ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id = 3 AND source_module = 'fleet_intelligence' AND source_table = 'fleet_cash_payments' AND source_id > 0 AND EXISTS (SELECT 1 FROM public.accounting_entries e WHERE e.id = accounting_entry_lines.entry_id AND e.company_id = 3 AND ((e.source = 'fleet_cash_payment' AND e.source_id = accounting_entry_lines.source_id) OR (e.source = 'reversal' AND e.source_event_id = 'fleet-cash-payment-reversal:1:' || accounting_entry_lines.source_id::text || ':' || e.source_id::text)))));

CREATE POLICY fleet_finance_line_insert_dev ON public.accounting_entry_lines
AS PERMISSIVE FOR INSERT TO bizportal_fleet_finance_login_dev
WITH CHECK ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id = 3 AND source_module = 'fleet_intelligence' AND source_table = 'fleet_cash_payments' AND source_id > 0 AND EXISTS (SELECT 1 FROM public.accounting_entries e WHERE e.id = accounting_entry_lines.entry_id AND e.company_id = 3 AND ((e.source = 'fleet_cash_payment' AND e.source_id = accounting_entry_lines.source_id) OR (e.source = 'reversal' AND e.source_event_id = 'fleet-cash-payment-reversal:1:' || accounting_entry_lines.source_id::text || ':' || e.source_id::text)))));

CREATE POLICY fleet_finance_line_boundary_dev ON public.accounting_entry_lines
AS RESTRICTIVE FOR ALL TO bizportal_fleet_finance_login_dev
USING ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id = 3 AND source_module = 'fleet_intelligence' AND source_table = 'fleet_cash_payments' AND source_id > 0 AND EXISTS (SELECT 1 FROM public.accounting_entries e WHERE e.id = accounting_entry_lines.entry_id AND e.company_id = 3 AND ((e.source = 'fleet_cash_payment' AND e.source_id = accounting_entry_lines.source_id) OR (e.source = 'reversal' AND e.source_event_id = 'fleet-cash-payment-reversal:1:' || accounting_entry_lines.source_id::text || ':' || e.source_id::text)))))
WITH CHECK ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id = 3 AND source_module = 'fleet_intelligence' AND source_table = 'fleet_cash_payments' AND source_id > 0 AND EXISTS (SELECT 1 FROM public.accounting_entries e WHERE e.id = accounting_entry_lines.entry_id AND e.company_id = 3 AND ((e.source = 'fleet_cash_payment' AND e.source_id = accounting_entry_lines.source_id) OR (e.source = 'reversal' AND e.source_event_id = 'fleet-cash-payment-reversal:1:' || accounting_entry_lines.source_id::text || ':' || e.source_id::text)))));

CREATE POLICY fleet_finance_ledger_read_dev ON public.fleet_ledger_entries
AS PERMISSIVE FOR SELECT TO bizportal_fleet_finance_login_dev
USING ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id = 3 AND source_type IN ('fleet_cash_payment','reversal') AND EXISTS (SELECT 1 FROM public.accounting_entries e WHERE e.company_id = 3 AND e.entry_number = fleet_ledger_entries.source_ref AND e.source::text = fleet_ledger_entries.source_type AND e.source_id = fleet_ledger_entries.source_id AND e.date = fleet_ledger_entries.ledger_date)));

CREATE POLICY fleet_finance_ledger_insert_dev ON public.fleet_ledger_entries
AS PERMISSIVE FOR INSERT TO bizportal_fleet_finance_login_dev
WITH CHECK ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id = 3 AND source_type IN ('fleet_cash_payment','reversal') AND EXISTS (SELECT 1 FROM public.accounting_entries e WHERE e.company_id = 3 AND e.entry_number = fleet_ledger_entries.source_ref AND e.source::text = fleet_ledger_entries.source_type AND e.source_id = fleet_ledger_entries.source_id AND e.date = fleet_ledger_entries.ledger_date)));

CREATE POLICY fleet_finance_ledger_boundary_dev ON public.fleet_ledger_entries
AS RESTRICTIVE FOR ALL TO bizportal_fleet_finance_login_dev
USING ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id = 3 AND source_type IN ('fleet_cash_payment','reversal') AND EXISTS (SELECT 1 FROM public.accounting_entries e WHERE e.company_id = 3 AND e.entry_number = fleet_ledger_entries.source_ref AND e.source::text = fleet_ledger_entries.source_type AND e.source_id = fleet_ledger_entries.source_id AND e.date = fleet_ledger_entries.ledger_date)))
WITH CHECK ((CURRENT_USER = SESSION_USER AND SESSION_USER = 'bizportal_fleet_finance_login_dev' AND company_id = 3 AND source_type IN ('fleet_cash_payment','reversal') AND EXISTS (SELECT 1 FROM public.accounting_entries e WHERE e.company_id = 3 AND e.entry_number = fleet_ledger_entries.source_ref AND e.source::text = fleet_ledger_entries.source_type AND e.source_id = fleet_ledger_entries.source_id AND e.date = fleet_ledger_entries.ledger_date)));

DO $verification$
BEGIN
  IF has_schema_privilege('fleet_cash_source_login_dev','public','CREATE')
     OR has_schema_privilege('bizportal_fleet_finance_login_dev','public','CREATE') THEN
    RAISE EXCEPTION 'Dedicated Fleet identities must not create schema objects';
  END IF;
  IF has_table_privilege('fleet_cash_source_login_dev','public.accounting_entries','INSERT')
     OR has_table_privilege('fleet_cash_source_login_dev','public.accounting_entry_lines','INSERT')
     OR has_table_privilege('bizportal_fleet_finance_login_dev','public.fleet_cash_payments','INSERT')
     OR has_column_privilege('bizportal_fleet_finance_login_dev','public.fleet_cash_payments','amount','UPDATE') THEN
    RAISE EXCEPTION 'Unexpected broad source/Finance write privilege';
  END IF;
END $verification$;
COMMIT;
