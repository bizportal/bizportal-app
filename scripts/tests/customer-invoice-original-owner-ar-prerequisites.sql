-- Test-only prerequisites for the existing reviewed Customer AR source triggers.
-- Executed only in the fresh invoice_synthetic database after base ORM DDL.
DO $$
BEGIN
 IF current_database() <> 'invoice_synthetic' THEN
   RAISE EXCEPTION 'DISPOSABLE_AR_ONLY';
 END IF;
END $$;

CREATE ROLE bizportal_finance_cst_login_dev LOGIN PASSWORD 'synthetic-cst-role' NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE bizportal_finance_diva_login_dev LOGIN PASSWORD 'synthetic-diva-role' NOINHERIT NOSUPERUSER NOBYPASSRLS;

ALTER TABLE public.accounting_entry_lines ADD COLUMN company_id integer;
CREATE TABLE public.ar_subledger (
  id serial PRIMARY KEY,
  company_id integer NOT NULL,
  invoice_id integer,
  customer_id integer,
  invoice_number text,
  invoice_date date,
  due_date date,
  currency text NOT NULL DEFAULT 'IDR',
  gross_amount numeric NOT NULL DEFAULT 0,
  outstanding_amount numeric NOT NULL DEFAULT 0,
  paid_amount numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'OPEN',
  gl_entry_id integer,
  period text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX idx_ar_sub_invoice ON public.ar_subledger(company_id,invoice_id) WHERE invoice_id IS NOT NULL;
GRANT USAGE ON SCHEMA public TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
DO $guard$
DECLARE tbl text;
BEGIN
 FOREACH tbl IN ARRAY ARRAY[
  'sales_documents','accounting_entries','accounting_entry_lines',
  'accounting_settings','chart_of_accounts','accounting_journals','ar_subledger'
 ] LOOP
   EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
 END LOOP;
END $guard$;
