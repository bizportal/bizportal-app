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
CREATE TABLE public.accounting_entries (
  id integer primary key, status text not null
);
INSERT INTO public.bank_sheet_configs VALUES (2,1,'1640006707220'),(3,1,'1234567890');
-- The historical seven journal references include five draft entries
-- and two missing accounting_entries rows. Preserve these contradictions
-- in the disposable fixture; do not "repair" the financial source silently.
INSERT INTO public.accounting_entries(id,status)
SELECT 1000+n,'draft' FROM generate_series(1,5) AS n;

-- Match the historic count and posted-source ratio found by read-only
-- CST-DEV audit, but create these rows ONLY in ephemeral PostgreSQL.
INSERT INTO public.bank_mutations(id,company_id,source,sheet_config_id,journal_entry_id)
SELECT n+25,1,'google_sheet',4, CASE WHEN n<=7 THEN 1000+n ELSE NULL END
FROM generate_series(1,21) AS n;

-- The preflight must raise while remaining in an atomic transaction.
-- The actual guard will be read from ensure-bank-sheet-account-isolation.sql
-- by the test runner and executed here. Do not replace with permissive DDL.
