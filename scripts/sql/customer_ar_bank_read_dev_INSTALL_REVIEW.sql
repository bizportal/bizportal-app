-- CST-DEV xssrfshdrtdfupgqwfdw only: private Customer AR preview reads.
-- No bank mutation/payment writes, role changes, sequence grants or backfill.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $preflight$
DECLARE actor name;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.bank_mutations'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'CUSTOMER_AR_BANK_RLS_REQUIRED';
  END IF;
  FOREACH actor IN ARRAY ARRAY['bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev']::name[] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = actor
      AND NOT rolsuper AND NOT rolbypassrls AND NOT rolinherit) THEN
      RAISE EXCEPTION 'CUSTOMER_AR_BANK_COMPANY_ROLE_INVALID %', actor;
    END IF;
    IF has_any_column_privilege(actor, 'public.bank_mutations', 'SELECT,INSERT,UPDATE,REFERENCES')
      OR has_table_privilege(actor, 'public.bank_mutations', 'DELETE,TRUNCATE,TRIGGER') THEN
      RAISE EXCEPTION 'CUSTOMER_AR_BANK_GRANT_BASELINE_CHANGED %', actor;
    END IF;
  END LOOP;
END
$preflight$;
GRANT SELECT (id, company_id, direction, status, amount, description,
  bank_reference, provider_order_id, created_at) ON public.bank_mutations
  TO bizportal_finance_cst_login_dev, bizportal_finance_diva_login_dev;
CREATE POLICY customer_ar_bank_candidate_read_dev ON public.bank_mutations
FOR SELECT TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev
USING (current_user = session_user
  AND company_id = CASE session_user WHEN 'bizportal_finance_cst_login_dev' THEN 1 WHEN 'bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END
  AND upper(direction) = 'IN' AND lower(status) = 'unmatched');
CREATE POLICY customer_ar_bank_company_guard_dev ON public.bank_mutations
AS RESTRICTIVE FOR SELECT TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev
USING (current_user = session_user
  AND company_id = CASE session_user WHEN 'bizportal_finance_cst_login_dev' THEN 1 WHEN 'bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END
  AND upper(direction) = 'IN' AND lower(status) = 'unmatched');
COMMIT;
