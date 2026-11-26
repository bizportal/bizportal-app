-- PR147 isolated PostgreSQL only. Demonstrate company-scoped, read-only
-- sheet lookup with NOLOGIN and without a credential or live role grant.
-- Run AFTER bank-sheet-cutover-positive-fixture.sql and the actual migration.
\set ON_ERROR_STOP on
INSERT INTO public.bank_sheet_configs
(id,company_id,label,sheet_id,tab_name,is_active,bank_account_number,bank_account_id)
VALUES (5,3,'isolated other tenant','synthetic-sheet-C','tenant3',false,'1640006707220',31);

CREATE ROLE pr147_bank_sheet_reader_cst_dev NOLOGIN NOINHERIT;
GRANT USAGE ON SCHEMA public TO pr147_bank_sheet_reader_cst_dev;
GRANT SELECT ON public.bank_sheet_configs, public.company_bank_accounts
TO pr147_bank_sheet_reader_cst_dev;
ALTER TABLE public.bank_sheet_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_bank_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY pr147_cst_read_sheet ON public.bank_sheet_configs
 FOR SELECT TO pr147_bank_sheet_reader_cst_dev
 USING (company_id=1 AND CURRENT_USER=SESSION_USER);
CREATE POLICY pr147_cst_read_account ON public.company_bank_accounts
 FOR SELECT TO pr147_bank_sheet_reader_cst_dev
 USING (company_id=1 AND CURRENT_USER=SESSION_USER);
