-- Synthetic fixture only. Mirrors the inspected CST-DEV columns and partial
-- AR uniqueness. No live connection or copied business/customer data.
CREATE ROLE bizportal_finance_cst_login_dev LOGIN PASSWORD 'synthetic-cst-only' NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE bizportal_finance_diva_login_dev LOGIN PASSWORD 'synthetic-diva-only' NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE unlisted_issuer_ci LOGIN PASSWORD 'synthetic-unlisted-only' NOINHERIT NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev,unlisted_issuer_ci;
CREATE TABLE public.sales_documents (
 id integer PRIMARY KEY, company_id integer, customer_id integer, customer_name text NOT NULL DEFAULT 'Synthetic customer',
 invoice_number text, invoice_date date, due_date date, invoice_status text NOT NULL DEFAULT 'invoiced',
 status text NOT NULL DEFAULT 'confirmed', payment_status text NOT NULL DEFAULT 'unpaid',
 amount_paid numeric(14,2) NOT NULL DEFAULT 0, grand_total numeric(14,2) NOT NULL DEFAULT 100,
 cancelled_at timestamp, updated_at timestamp NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.accounting_settings (id serial PRIMARY KEY, company_id integer, ar_account_id integer, sales_journal_id integer);
CREATE TABLE public.chart_of_accounts (id integer PRIMARY KEY, company_id integer, type text NOT NULL, subtype text,
 is_active boolean NOT NULL DEFAULT true, is_postable boolean NOT NULL DEFAULT true, is_header boolean NOT NULL DEFAULT false);
CREATE TABLE public.accounting_journals (id integer PRIMARY KEY, company_id integer, type text NOT NULL);
CREATE TABLE public.accounting_entries (
 id integer PRIMARY KEY, company_id integer NOT NULL, source text NOT NULL, source_id integer,
 journal_id integer NOT NULL, status text NOT NULL DEFAULT 'posted',
 total_debit numeric(14,2) NOT NULL DEFAULT 100, total_credit numeric(14,2) NOT NULL DEFAULT 100,
 is_voided boolean NOT NULL DEFAULT false, is_reversed boolean NOT NULL DEFAULT false,
 void_entry_id integer, created_at timestamp NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX accounting_entries_source_idx ON public.accounting_entries(company_id,source,source_id)
 WHERE source IS NOT NULL AND source_id IS NOT NULL AND source <> 'manual';
CREATE TABLE public.accounting_entry_lines (
 id serial PRIMARY KEY, entry_id integer NOT NULL, company_id integer, account_id integer NOT NULL,
 debit numeric(14,2) NOT NULL DEFAULT 0, credit numeric(14,2) NOT NULL DEFAULT 0
);
CREATE TABLE public.ar_subledger (
 id serial PRIMARY KEY, company_id integer NOT NULL, invoice_id integer, customer_id integer,
 invoice_number text, invoice_date date, due_date date, currency text NOT NULL DEFAULT 'IDR',
 gross_amount numeric NOT NULL DEFAULT 0, outstanding_amount numeric NOT NULL DEFAULT 0,
 paid_amount numeric NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'OPEN', gl_entry_id integer,
 period text, notes text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX idx_ar_sub_invoice ON public.ar_subledger(company_id,invoice_id) WHERE invoice_id IS NOT NULL;
CREATE TABLE public.bank_mutations (id integer PRIMARY KEY, company_id integer, direction text, status text, amount numeric);
CREATE TABLE public.payments (id integer PRIMARY KEY, company_id integer, amount numeric, status text);
INSERT INTO public.bank_mutations VALUES (1,1,'IN','unmatched',100),(3,3,'IN','unmatched',100);
INSERT INTO public.payments VALUES (1,1,7,'pending');
INSERT INTO public.accounting_settings(company_id,ar_account_id,sales_journal_id) VALUES(1,101,11),(3,301,31),(2,201,21);
INSERT INTO public.chart_of_accounts(id,company_id,type,subtype) VALUES
 (101,1,'asset','receivable'),(102,1,'revenue',NULL),(103,1,'liability',NULL),
 (201,2,'asset','receivable'),(202,2,'revenue',NULL),
 (301,3,'asset','receivable'),(302,3,'revenue',NULL);
INSERT INTO public.accounting_journals VALUES (11,1,'sales'),(21,2,'sales'),(31,3,'sales');
DO $rls$
DECLARE relation_name text;
BEGIN
 FOREACH relation_name IN ARRAY ARRAY['sales_documents','accounting_settings','chart_of_accounts',
   'accounting_journals','accounting_entries','accounting_entry_lines','ar_subledger'] LOOP
   EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', relation_name);
 END LOOP;
END
$rls$;
-- Valid old source and unrelated AR must survive install/activation/rollback.
INSERT INTO public.sales_documents(id,company_id,invoice_number,invoice_date,due_date)
 VALUES(900,1,'INV-OLD-900','2026-11-01','2026-12-01'),(901,1,'INV-OTHER-901','2026-11-01','2026-12-01');
INSERT INTO public.accounting_entries(id,company_id,source,source_id,journal_id,created_at)
 VALUES(900,1,'sales_invoice',900,11,'2026-11-01'),(901,1,'sales_invoice',901,11,'2026-11-01');
INSERT INTO public.accounting_entry_lines(entry_id,account_id,debit,credit)
 VALUES(900,101,100,0),(900,102,0,100),(901,101,100,0),(901,102,0,100);
INSERT INTO public.ar_subledger(company_id,invoice_id,invoice_number,gross_amount,outstanding_amount,gl_entry_id,notes)
 VALUES(1,901,'INV-OTHER-901',100,100,901,'existing-other-owner');
