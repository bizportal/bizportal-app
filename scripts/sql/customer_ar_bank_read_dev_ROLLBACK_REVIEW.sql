-- Reverse only the nine newly granted read columns and two new policies.
-- Existing Payroll/settlement policies, roles and all bank rows stay intact.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP POLICY customer_ar_bank_candidate_read_dev ON public.bank_mutations;
DROP POLICY customer_ar_bank_company_guard_dev ON public.bank_mutations;
REVOKE SELECT (id, company_id, direction, status, amount, description,
  bank_reference, provider_order_id, created_at) ON public.bank_mutations
  FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
COMMIT;
