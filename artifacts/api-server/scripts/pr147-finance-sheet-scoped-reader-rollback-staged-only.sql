-- PR147 rollback of staged DEV-only CST/Diva bank Sheet reader.
-- DO NOT run on PROD. Apply only if the staged policy was applied to
-- CST-DEV after original grants/policies were independently recorded.
-- Baseline on 2026-11-19: both dedicated finance login roles had no SELECT
-- on bank_sheet_configs or company_bank_accounts; preexisting SELECT on
-- chart_of_accounts and schema USAGE must be preserved.
BEGIN;
DROP POLICY IF EXISTS pr147_finance_cst_sheet_read_dev ON public.bank_sheet_configs;
DROP POLICY IF EXISTS pr147_finance_diva_sheet_read_dev ON public.bank_sheet_configs;
DROP POLICY IF EXISTS pr147_finance_cst_bank_read_dev ON public.company_bank_accounts;
DROP POLICY IF EXISTS pr147_finance_diva_bank_read_dev ON public.company_bank_accounts;
REVOKE SELECT ON public.bank_sheet_configs,public.company_bank_accounts
 FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
-- Do not revoke SELECT on chart_of_accounts: it existed before PR147.
-- Do not revoke USAGE on public: it existed before PR147.
COMMIT;
