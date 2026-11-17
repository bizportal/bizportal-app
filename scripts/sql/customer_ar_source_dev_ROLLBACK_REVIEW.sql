-- CST-DEV only. Disable source events without deleting any financial history.
-- AR rows remain for audit; the preview independently revalidates their source.
-- This reverses only the new grants/policies; install asserts they did not exist.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TRIGGER customer_ar_sales_source_dev ON public.sales_documents;
DROP TRIGGER customer_ar_journal_source_dev ON public.accounting_entries;
DROP TRIGGER customer_ar_journal_lines_dev ON public.accounting_entry_lines;
DROP FUNCTION public.bizportal_customer_ar_after_source_dev();
DROP TRIGGER customer_ar_stale_row_guard_dev ON public.ar_subledger;
DROP FUNCTION public.bizportal_customer_ar_stale_guard_dev();
DROP POLICY customer_ar_insert_proven_source_dev ON public.ar_subledger;
DROP POLICY customer_ar_update_owned_projection_dev ON public.ar_subledger;
DO $policies$
DECLARE relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY['sales_documents', 'accounting_entries',
    'accounting_entry_lines', 'accounting_settings', 'chart_of_accounts',
    'accounting_journals', 'ar_subledger'] LOOP
    EXECUTE format('DROP POLICY customer_ar_company_read_dev ON public.%I', relation_name);
    EXECUTE format('DROP POLICY customer_ar_company_guard_dev ON public.%I', relation_name);
  END LOOP;
END
$policies$;
REVOKE SELECT ON public.sales_documents, public.accounting_entries,
  public.accounting_entry_lines, public.accounting_settings, public.chart_of_accounts,
  public.accounting_journals, public.ar_subledger
  FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
REVOKE INSERT (company_id, invoice_id, customer_id, invoice_number, invoice_date,
  due_date, currency, gross_amount, outstanding_amount, paid_amount, status,
  gl_entry_id, period, notes) ON public.ar_subledger
  FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
REVOKE UPDATE (customer_id, invoice_number, invoice_date, due_date, gross_amount,
  outstanding_amount, paid_amount, status, period, updated_at) ON public.ar_subledger
  FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
REVOKE USAGE ON SEQUENCE public.ar_subledger_id_seq
  FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
DROP VIEW public.bizportal_customer_ar_source_evidence_dev;
DROP TABLE public.bizportal_customer_ar_source_actors_dev;
COMMIT;
