-- DISPOSABLE FIXTURE ONLY. Not a Supabase migration or deployment grant script.
-- Existing runner independently pins 127.0.0.1:65432/payroll_ci and cleans it up.
BEGIN;
DO $$ BEGIN
 IF current_database() <> 'payroll_ci' OR current_user <> 'postgres.xssrfshdrtdfupgqwfdw'
    OR NOT EXISTS (SELECT 1 FROM public.chart_of_accounts WHERE id=10 AND code='SYNTH-10')
    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='bizportal_payroll_settlement_dev' AND NOT rolsuper AND NOT rolbypassrls)
 THEN RAISE EXCEPTION 'DISPOSABLE_PERMISSION_FIXTURE_REQUIRED'; END IF;
END $$;

-- Remove the representative fixture's broad table-wide UPDATE permissions.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM bizportal_payroll_settlement_dev;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM bizportal_payroll_settlement_dev;
-- Column privileges are independent of table ACLs; remove the earlier lock grants.
REVOKE UPDATE(id) ON employees,chart_of_accounts,payroll_items,accounting_settings,
 cash_advance_repayments,fleet_ledger_entries FROM bizportal_payroll_settlement_dev;
REVOKE UPDATE(company_id) ON financial_periods FROM bizportal_payroll_settlement_dev;

GRANT SELECT ON accounting_entries,accounting_entry_lines,journal_sequences,ledger_events,
 financial_outbox_events,employees,chart_of_accounts,accounting_journals,financial_periods,
 payroll_items,payroll_runs,cash_advances,payroll_kasbon_auto_reservations,
 cash_advance_repayments,fleet_ledger_entries,accounting_settings,
 payroll_cash_advance_allocations,cash_advance_installment_schedules
 TO bizportal_payroll_settlement_dev;

-- The unchanged Drizzle journal builder emits DEFAULTs for its table schema.
-- Its INSERT privilege is still table-level; tenant/source RLS below constrains it.
-- This is not a claim that arbitrary SQL by this trusted writer is authorized.
GRANT INSERT ON accounting_entries,accounting_entry_lines TO bizportal_payroll_settlement_dev;
GRANT INSERT(journal_prefix,company_id,year,next_seq),UPDATE(next_seq)
 ON journal_sequences TO bizportal_payroll_settlement_dev;
GRANT INSERT(company_id,event_type,period,entry_id,ledger_entry_id,actor,payload)
 ON ledger_events TO bizportal_payroll_settlement_dev;
GRANT INSERT(event_type,payload,entry_id,company_id)
 ON financial_outbox_events TO bizportal_payroll_settlement_dev;
GRANT UPDATE(status,checksum_hash,previous_entry_id)
 ON accounting_entries TO bizportal_payroll_settlement_dev;
GRANT UPDATE(status,posting_status,accounting_entry_id,posted_at,posting_error,posting_claimed_at)
 ON payroll_runs TO bizportal_payroll_settlement_dev;
GRANT UPDATE(paid_amount,settled_amount,remaining_amount,status,lifecycle_status,
 repayment_journal_id,repaid_at,updated_at) ON cash_advances TO bizportal_payroll_settlement_dev;
GRANT UPDATE(state,confirmed_at) ON payroll_kasbon_auto_reservations TO bizportal_payroll_settlement_dev;
GRANT INSERT(advance_id,amount,payment_method,date,notes,entry_id,idempotency_key,
 posted_at,created_by,payment_reference) ON cash_advance_repayments TO bizportal_payroll_settlement_dev;
GRANT INSERT(company_id,ledger_date,period,source_type,source_id,source_ref,account_id,
 account_code,account_name,account_type,debit,credit,description,created_by)
 ON fleet_ledger_entries TO bizportal_payroll_settlement_dev;

-- PostgreSQL row locks need UPDATE permission on at least one column. An extra
-- fixture-only trigger forbids every actual UPDATE on these read/lock tables.
-- No immutable-journal or reviewed-payroll guard is disabled or replaced.
GRANT UPDATE(id) ON employees,chart_of_accounts,payroll_items,accounting_settings,
 accounting_entry_lines,cash_advance_repayments,fleet_ledger_entries
 TO bizportal_payroll_settlement_dev;
GRANT UPDATE(company_id) ON financial_periods TO bizportal_payroll_settlement_dev;
CREATE FUNCTION ci_payroll_lock_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF current_user='bizportal_payroll_settlement_dev' THEN
  RAISE EXCEPTION 'PAYROLL_FIXTURE_LOCK_ONLY_NO_MUTATION' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['employees','chart_of_accounts','payroll_items','accounting_settings',
 'accounting_entry_lines','cash_advance_repayments','fleet_ledger_entries','financial_periods'] LOOP
  EXECUTE format('CREATE TRIGGER ci_payroll_lock_only BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION ci_payroll_lock_only()',t);
 END LOOP;
END $$;
GRANT USAGE,SELECT ON SEQUENCE accounting_entries_id_seq,accounting_entry_lines_id_seq,
 ledger_events_id_seq,financial_outbox_events_id_seq,cash_advance_repayments_id_seq,
 fleet_ledger_entries_id_seq TO bizportal_payroll_settlement_dev;

-- Restrictive policies complement, rather than relax, existing company scope.
CREATE POLICY ci_payroll_source_only ON accounting_entries AS RESTRICTIVE
 TO bizportal_payroll_settlement_dev USING (source='payroll') WITH CHECK (source='payroll');
CREATE POLICY ci_payroll_ledger_only ON fleet_ledger_entries AS RESTRICTIVE
 TO bizportal_payroll_settlement_dev USING (source_type='payroll') WITH CHECK (source_type='payroll');
CREATE POLICY ci_payroll_advance_only ON cash_advances AS RESTRICTIVE
 TO bizportal_payroll_settlement_dev USING (type='kasbon') WITH CHECK (type='kasbon');

-- There are intentionally NO rights on salary_payments, approval timestamp,
-- approval receipt notes, employee master salary, item amounts, bank or DDL.

COMMIT;
