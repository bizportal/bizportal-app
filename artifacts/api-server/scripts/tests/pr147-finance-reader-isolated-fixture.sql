-- Disposable PostgreSQL only. Create no live Supabase roles or company data.
\set ON_ERROR_STOP on
CREATE ROLE bizportal_finance_cst_login_dev LOGIN NOINHERIT;
CREATE ROLE bizportal_finance_diva_login_dev LOGIN NOINHERIT;
CREATE TABLE public.bank_sheet_configs (id integer PRIMARY KEY,company_id integer NOT NULL,label text);
CREATE TABLE public.company_bank_accounts (id integer PRIMARY KEY,company_id integer NOT NULL,account_number text);
CREATE TABLE public.chart_of_accounts (id integer PRIMARY KEY,company_id integer NOT NULL);
INSERT INTO public.bank_sheet_configs VALUES (2,1,'mutasi dev'),(3,1,'kas besar'),(5,3,'Diva only');
INSERT INTO public.company_bank_accounts VALUES (17,1,'111'),(2,1,'222'),(31,3,'333');
INSERT INTO public.chart_of_accounts VALUES (17,1),(2,1),(31,3);
ALTER TABLE public.bank_sheet_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chart_of_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY coa_cst ON public.chart_of_accounts FOR SELECT TO bizportal_finance_cst_login_dev USING (company_id=1 AND CURRENT_USER=SESSION_USER);
CREATE POLICY coa_diva ON public.chart_of_accounts FOR SELECT TO bizportal_finance_diva_login_dev USING (company_id=3 AND CURRENT_USER=SESSION_USER);
