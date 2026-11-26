-- PR147 positive/rollback fixture. Disposable PostgreSQL CI only.
\set ON_ERROR_STOP on
CREATE TABLE public.company_bank_accounts (
 id integer PRIMARY KEY, company_id integer NOT NULL,
 account_number text NOT NULL, is_active boolean NOT NULL DEFAULT true,
 account_type text
);
CREATE TABLE public.bank_sheet_configs (
 id integer PRIMARY KEY, company_id integer, label text,
 sheet_id text, tab_name text, is_active boolean,
 last_synced_at timestamptz, last_sync_status text, last_sync_error text,
 created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
 bank_account_number text, bank_name text
);
CREATE TABLE public.accounting_entries (
 id integer PRIMARY KEY, status text NOT NULL, posted_at timestamptz
);
CREATE TABLE public.bank_mutations (
 id integer PRIMARY KEY, company_id integer, bank_account_id text,
 source text, sheet_config_id integer, journal_entry_id integer,
 accounting_posted boolean DEFAULT false, status text,
 transaction_date date
);
INSERT INTO public.company_bank_accounts (id,company_id,account_number,is_active,account_type)
VALUES (17,1,'1640006707220',true,'bank'),(2,1,'1234567890',true,'bank'),
       (31,3,'1640006707220',true,'bank');
INSERT INTO public.bank_sheet_configs
(id,company_id,label,sheet_id,tab_name,is_active,bank_account_number)
VALUES (2,1,'mutasi dev','synthetic-sheet-A','mutasidev',false,'1640006707220'),
       (3,1,'kas besar','synthetic-sheet-B','kasbesar',true,'1234567890');
INSERT INTO public.bank_mutations
(id,company_id,bank_account_id,source,sheet_config_id,accounting_posted,status,transaction_date)
VALUES (1,1,'2','google_sheet',3,false,'pending','2026-11-01'),
       (2,1,'17','manual',2,false,'pending','2026-11-02');
