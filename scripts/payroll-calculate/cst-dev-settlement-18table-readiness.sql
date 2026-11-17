-- CST-DEV settlement role only, DEFAULT NOLOGIN. Do not activate posting.
-- Reuse the already-present 18 tables/constraints/triggers and existing roles.
-- Never run against PROD. This is NOT a credential or data migration.
DO $guard$
DECLARE table_name text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='bizportal_payroll_settlement_dev'
    AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb
    AND NOT rolreplication)
 THEN RAISE EXCEPTION 'RESTRICTED_SETTLEMENT_ROLE_REQUIRED'; END IF;
 FOREACH table_name IN ARRAY ARRAY[
  'accounting_entries','accounting_entry_lines','journal_sequences','ledger_events',
  'financial_outbox_events','payroll_runs','payroll_items','cash_advances',
  'cash_advance_repayments','payroll_kasbon_auto_reservations','fleet_ledger_entries',
  'employees','chart_of_accounts','accounting_journals','financial_periods',
  'accounting_settings','payroll_cash_advance_allocations',
  'cash_advance_installment_schedules'
 ] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=table_name AND c.relkind='r' AND c.relrowsecurity)
  THEN RAISE EXCEPTION 'SETTLEMENT_RLS_MISSING: %',table_name; END IF;
 END LOOP;
 IF has_schema_privilege('bizportal_payroll_settlement_dev','public','CREATE') OR
    COALESCE(has_table_privilege('bizportal_payroll_settlement_dev',
      to_regclass('public.salary_payments'),'INSERT'),false)
 THEN RAISE EXCEPTION 'SETTLEMENT_SCHEMA_OR_PAYOUT_ACCESS_FORBIDDEN'; END IF;
END $guard$;

GRANT USAGE ON SCHEMA public TO bizportal_payroll_settlement_dev;
GRANT SELECT ON public.accounting_entries,public.accounting_entry_lines,
 public.journal_sequences,public.ledger_events,public.financial_outbox_events,
 public.payroll_runs,public.payroll_items,public.cash_advances,
 public.cash_advance_repayments,public.payroll_kasbon_auto_reservations,
 public.fleet_ledger_entries,public.employees,public.chart_of_accounts,
 public.accounting_journals,public.financial_periods,public.accounting_settings,
 public.payroll_cash_advance_allocations,public.cash_advance_installment_schedules
 TO bizportal_payroll_settlement_dev;

-- No table-wide UPDATE/DELETE/TRUNCATE for settlement. The native Drizzle
-- package needs table-level INSERT for exactly two original journal tables.
GRANT INSERT ON public.accounting_entries,public.accounting_entry_lines
 TO bizportal_payroll_settlement_dev;
GRANT UPDATE(status,checksum_hash,previous_entry_id) ON public.accounting_entries
 TO bizportal_payroll_settlement_dev;
GRANT UPDATE(id) ON public.accounting_entry_lines TO bizportal_payroll_settlement_dev;
GRANT INSERT(journal_prefix,company_id,year,next_seq),UPDATE(next_seq)
 ON public.journal_sequences TO bizportal_payroll_settlement_dev;
GRANT INSERT(company_id,event_type,period,entry_id,ledger_entry_id,actor,payload)
 ON public.ledger_events TO bizportal_payroll_settlement_dev;
GRANT INSERT(event_type,payload,entry_id,company_id)
 ON public.financial_outbox_events TO bizportal_payroll_settlement_dev;
GRANT UPDATE(status,posting_status,accounting_entry_id,posted_at,posting_error,posting_claimed_at)
 ON public.payroll_runs TO bizportal_payroll_settlement_dev;
GRANT UPDATE(id) ON public.payroll_items TO bizportal_payroll_settlement_dev;
GRANT UPDATE(settled_amount,remaining_amount,status,lifecycle_status,
 repayment_journal_id,repaid_at,updated_at)
 ON public.cash_advances TO bizportal_payroll_settlement_dev;
GRANT INSERT(advance_id,amount,payment_method,date,notes,entry_id,idempotency_key,
 posted_at,created_by,payment_reference),UPDATE(id)
 ON public.cash_advance_repayments TO bizportal_payroll_settlement_dev;
GRANT UPDATE(state,confirmed_at) ON public.payroll_kasbon_auto_reservations
 TO bizportal_payroll_settlement_dev;
GRANT INSERT(company_id,ledger_date,period,source_type,source_id,source_ref,
 account_id,account_code,account_name,account_type,debit,credit,description,created_by),
 UPDATE(id) ON public.fleet_ledger_entries TO bizportal_payroll_settlement_dev;
-- Existing role-scoped row locks. UPDATE policy WITH CHECK(false) prevents
-- actual mutation of these master-data/identity columns.
GRANT UPDATE(id) ON public.employees,public.chart_of_accounts,
 public.accounting_settings TO bizportal_payroll_settlement_dev;
GRANT UPDATE(company_id) ON public.financial_periods
 TO bizportal_payroll_settlement_dev;
GRANT USAGE,SELECT ON SEQUENCE public.accounting_entries_id_seq,
 public.accounting_entry_lines_id_seq,public.ledger_events_id_seq,
 public.financial_outbox_events_id_seq,public.cash_advance_repayments_id_seq,
 public.fleet_ledger_entries_id_seq TO bizportal_payroll_settlement_dev;

-- Existing company-1-only SELECT/UPDATE policies for payroll_runs,
-- payroll_items, employees, cash_advances and reservations are preserved.
CREATE POLICY settlement_dev_accrual_insert_20261118
 ON public.accounting_entries FOR INSERT TO bizportal_payroll_settlement_dev
 WITH CHECK(company_id=1 AND source::text='payroll'
  AND current_setting('app.payroll_company_id',true)='1');
CREATE POLICY settlement_dev_accrual_update_20261118
 ON public.accounting_entries FOR UPDATE TO bizportal_payroll_settlement_dev
 USING(company_id=1 AND source::text='payroll'
  AND current_setting('app.payroll_company_id',true)='1')
 WITH CHECK(company_id=1 AND source::text='payroll'
  AND current_setting('app.payroll_company_id',true)='1');

CREATE POLICY settlement_dev_entry_lines_read_20261118
 ON public.accounting_entry_lines FOR SELECT TO bizportal_payroll_settlement_dev
 USING(EXISTS(SELECT 1 FROM public.accounting_entries e
  WHERE e.id=accounting_entry_lines.entry_id AND e.company_id=1
   AND e.source::text='payroll'
   AND current_setting('app.payroll_company_id',true)='1'));
CREATE POLICY settlement_dev_entry_lines_insert_20261118
 ON public.accounting_entry_lines FOR INSERT TO bizportal_payroll_settlement_dev
 WITH CHECK(EXISTS(SELECT 1 FROM public.accounting_entries e
  WHERE e.id=accounting_entry_lines.entry_id AND e.company_id=1
   AND e.source::text='payroll'
   AND current_setting('app.payroll_company_id',true)='1'));
CREATE POLICY settlement_dev_entry_lines_lock_20261118
 ON public.accounting_entry_lines FOR UPDATE TO bizportal_payroll_settlement_dev
 USING(EXISTS(SELECT 1 FROM public.accounting_entries e
  WHERE e.id=accounting_entry_lines.entry_id AND e.company_id=1
   AND e.source::text='payroll'
   AND current_setting('app.payroll_company_id',true)='1'))
 WITH CHECK(false);

CREATE POLICY settlement_dev_journal_seq_scope_20261118
 ON public.journal_sequences TO bizportal_payroll_settlement_dev
 USING(company_id=1 AND current_setting('app.payroll_company_id',true)='1')
 WITH CHECK(company_id=1 AND current_setting('app.payroll_company_id',true)='1');
CREATE POLICY settlement_dev_ledger_events_scope_20261118
 ON public.ledger_events TO bizportal_payroll_settlement_dev
 USING(company_id=1 AND current_setting('app.payroll_company_id',true)='1')
 WITH CHECK(company_id=1 AND current_setting('app.payroll_company_id',true)='1');
CREATE POLICY settlement_dev_financial_outbox_scope_20261118
 ON public.financial_outbox_events TO bizportal_payroll_settlement_dev
 USING(company_id=1 AND current_setting('app.payroll_company_id',true)='1')
 WITH CHECK(company_id=1 AND current_setting('app.payroll_company_id',true)='1');

CREATE POLICY settlement_dev_payroll_run_post_20261118
 ON public.payroll_runs FOR UPDATE TO bizportal_payroll_settlement_dev
 USING(company_id=1 AND status='reviewed' AND posting_status='pending'
  AND approved_at IS NOT NULL AND accounting_entry_id IS NULL
  AND payment_entry_id IS NULL
  AND COALESCE(notes,'') LIKE '%[PAYROLL_SUPER_ADMIN_APPROVAL_V1]%'
  AND current_setting('app.payroll_company_id',true)='1')
 WITH CHECK(company_id=1 AND status='approved' AND posting_status='posted'
  AND accounting_entry_id IS NOT NULL AND payment_entry_id IS NULL
  AND current_setting('app.payroll_company_id',true)='1');
CREATE POLICY settlement_dev_payroll_item_lock_20261118
 ON public.payroll_items FOR UPDATE TO bizportal_payroll_settlement_dev
 USING(EXISTS(SELECT 1 FROM public.payroll_runs r
  WHERE r.id=payroll_items.run_id AND r.company_id=1
   AND current_setting('app.payroll_company_id',true)='1'))
 WITH CHECK(false);

CREATE POLICY settlement_dev_repayments_scope_20261118
 ON public.cash_advance_repayments TO bizportal_payroll_settlement_dev
 USING(EXISTS(SELECT 1 FROM public.cash_advances a
  WHERE a.id=cash_advance_repayments.advance_id AND a.company_id=1
   AND a.type='kasbon'
   AND current_setting('app.payroll_company_id',true)='1'))
 WITH CHECK(EXISTS(SELECT 1 FROM public.cash_advances a
  WHERE a.id=cash_advance_repayments.advance_id AND a.company_id=1
   AND a.type='kasbon'
   AND current_setting('app.payroll_company_id',true)='1')
  AND payment_method='payroll');

CREATE POLICY settlement_dev_fleet_ledger_scope_20261118
 ON public.fleet_ledger_entries FOR SELECT TO bizportal_payroll_settlement_dev
 USING(company_id=1 AND source_type='payroll'
  AND current_setting('app.payroll_company_id',true)='1');
CREATE POLICY settlement_dev_fleet_ledger_insert_20261118
 ON public.fleet_ledger_entries FOR INSERT TO bizportal_payroll_settlement_dev
 WITH CHECK(company_id=1 AND source_type='payroll'
  AND current_setting('app.payroll_company_id',true)='1');
CREATE POLICY settlement_dev_fleet_ledger_lock_20261118
 ON public.fleet_ledger_entries FOR UPDATE TO bizportal_payroll_settlement_dev
 USING(company_id=1 AND source_type='payroll'
  AND current_setting('app.payroll_company_id',true)='1')
 WITH CHECK(false);

CREATE POLICY settlement_dev_employee_lock_20261118
 ON public.employees FOR UPDATE TO bizportal_payroll_settlement_dev
 USING(company_id=1 AND current_setting('app.payroll_company_id',true)='1')
 WITH CHECK(false);
CREATE POLICY settlement_dev_coa_read_20261118
 ON public.chart_of_accounts FOR SELECT TO bizportal_payroll_settlement_dev
 USING(company_id=1 AND current_setting('app.payroll_company_id',true)='1');
CREATE POLICY settlement_dev_coa_lock_20261118
 ON public.chart_of_accounts FOR UPDATE TO bizportal_payroll_settlement_dev
 USING(company_id=1 AND current_setting('app.payroll_company_id',true)='1')
 WITH CHECK(false);
CREATE POLICY settlement_dev_journals_read_20261118
 ON public.accounting_journals FOR SELECT TO bizportal_payroll_settlement_dev
 USING(company_id=1 AND current_setting('app.payroll_company_id',true)='1');
CREATE POLICY settlement_dev_financial_period_read_20261118
 ON public.financial_periods FOR SELECT TO bizportal_payroll_settlement_dev
 USING(company_id=1 AND current_setting('app.payroll_company_id',true)='1');
CREATE POLICY settlement_dev_financial_period_lock_20261118
 ON public.financial_periods FOR UPDATE TO bizportal_payroll_settlement_dev
 USING(company_id=1 AND current_setting('app.payroll_company_id',true)='1')
 WITH CHECK(false);
CREATE POLICY settlement_dev_settings_read_20261118
 ON public.accounting_settings FOR SELECT TO bizportal_payroll_settlement_dev
 USING(company_id=1 AND current_setting('app.payroll_company_id',true)='1');
CREATE POLICY settlement_dev_settings_lock_20261118
 ON public.accounting_settings FOR UPDATE TO bizportal_payroll_settlement_dev
 USING(company_id=1 AND current_setting('app.payroll_company_id',true)='1')
 WITH CHECK(false);
CREATE POLICY settlement_dev_allocations_read_20261118
 ON public.payroll_cash_advance_allocations FOR SELECT TO bizportal_payroll_settlement_dev
 USING(EXISTS(SELECT 1 FROM public.payroll_items i JOIN public.payroll_runs r
   ON r.id=i.run_id WHERE i.id=payroll_cash_advance_allocations.payroll_item_id
   AND r.company_id=1 AND current_setting('app.payroll_company_id',true)='1'));
CREATE POLICY settlement_dev_installments_read_20261118
 ON public.cash_advance_installment_schedules FOR SELECT TO bizportal_payroll_settlement_dev
 USING(company_id=1 AND current_setting('app.payroll_company_id',true)='1'
  AND EXISTS(SELECT 1 FROM public.cash_advances a
    WHERE a.id=cash_advance_installment_schedules.advance_id
    AND a.company_id=1 AND a.type='kasbon'));
