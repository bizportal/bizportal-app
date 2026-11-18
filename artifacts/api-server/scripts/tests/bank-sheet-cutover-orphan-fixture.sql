-- Disposable-only test of the EXACT existing migration's pre-DDL guard.
-- Use with psql -v ON_ERROR_STOP=1 in PostgreSQL running without live data.
\set ON_ERROR_STOP on
CREATE TABLE public.bank_sheet_configs (
  id integer primary key, company_id integer, bank_account_number text
);
CREATE TABLE public.bank_mutations (
  id integer primary key, company_id integer, source text, sheet_config_id integer,
  journal_entry_id integer
);
INSERT INTO public.bank_sheet_configs VALUES (2,1,'1640006707220'),(3,1,'1234567890');
INSERT INTO public.bank_mutations(id,company_id,source,sheet_config_id,journal_entry_id)
VALUES (26,1,'google_sheet',4,314),(27,1,'google_sheet',4,NULL);

-- The preflight must raise while remaining in an atomic transaction.
-- The actual guard will be read from ensure-bank-sheet-account-isolation.sql
-- by the test runner and executed here. Do not replace with permissive DDL.
