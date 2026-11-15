-- CST-DEV ONLY: corrective replacement of the 3 existing PR50 Finance INSERT policies.
-- DOES NOT create a new Finance writer, credential, role, data row, or posting path.
-- Apply only through Supabase project xssrfshdrtdfupgqwfdw with the reviewed
-- project-scoped migration action. No PROD or Hostinger deployment effect.
--
-- This script is intended to be applied atomically as one migration.
-- It refuses concurrent active Finance sessions and unrecognized policy drift.
DO $finance_rls_preflight$
DECLARE
  role_ok boolean;
  policies_ok boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_authid
    WHERE rolname='bizportal_marketplace_finance_login_dev'
      AND rolcanlogin AND NOT rolbypassrls AND NOT rolsuper
      AND rolpassword IS NULL
  ) INTO role_ok;
  IF NOT role_ok THEN
    RAISE EXCEPTION 'CST_DEV_FINANCE_ROLE_STATE_CHANGED';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity
    WHERE usename='bizportal_marketplace_finance_login_dev'
  ) THEN
    RAISE EXCEPTION 'CST_DEV_FINANCE_ACTIVE_SESSIONS_PRESENT';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public'
      AND c.relname IN ('mkt_ap_preparations','payment_requests','mkt_accounting_handoffs')
      AND NOT c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'CST_DEV_FINANCE_TABLE_RLS_DISABLED';
  END IF;
  SELECT (
    (SELECT count(*) FROM pg_policies p
     WHERE p.schemaname='public' AND p.tablename='mkt_ap_preparations'
       AND p.policyname='pr50_finance_dev_ap_insert' AND p.cmd='INSERT'
       AND 'bizportal_marketplace_finance_login_dev'=ANY(p.roles)
       AND p.with_check LIKE '%vi.company_id = vi.company_id%'
       AND p.with_check LIKE '%three_way_match_status%')=1
    AND (SELECT count(*) FROM pg_policies p
     WHERE p.schemaname='public' AND p.tablename='payment_requests'
       AND p.policyname='pr50_finance_dev_payment_insert' AND p.cmd='INSERT'
       AND 'bizportal_marketplace_finance_login_dev'=ANY(p.roles)
       AND p.with_check LIKE '%ap.company_id = ap.company_id%'
       AND p.with_check LIKE '%journal_entry_id%')=1
    AND (SELECT count(*) FROM pg_policies p
     WHERE p.schemaname='public' AND p.tablename='mkt_accounting_handoffs'
       AND p.policyname='pr50_finance_dev_handoff_insert' AND p.cmd='INSERT'
       AND 'bizportal_marketplace_finance_login_dev'=ANY(p.roles)
       AND p.with_check LIKE '%ap.company_id = ap.company_id%'
       AND p.with_check LIKE '%pr.company_id = pr.company_id%')=1
  ) INTO policies_ok;
  IF NOT policies_ok THEN
    RAISE EXCEPTION 'CST_DEV_FINANCE_POLICY_DRIFT_OR_ALREADY_FIXED';
  END IF;
END
$finance_rls_preflight$;

-- Preserve existing GUC, three-way matched invoice and parent lookup checks;
-- replace only tautological parent-company comparisons. Match the canonical
-- service's existing initial AP status; financial transitions remain separate.
ALTER POLICY pr50_finance_dev_ap_insert ON public.mkt_ap_preparations
  WITH CHECK (
    company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer
    AND status = 'ap_preparation'::public.mkt_ap_preparation_status
    AND EXISTS (SELECT 1 FROM public.vendor_invoices vi
      WHERE vi.id=mkt_ap_preparations.vendor_invoice_id
        AND vi.company_id=mkt_ap_preparations.company_id
        AND vi.mkt_purchase_order_id IS NOT NULL
        AND vi.three_way_match_status='passed')
  );

ALTER POLICY pr50_finance_dev_payment_insert ON public.payment_requests
  WITH CHECK (
    company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer
    AND source_type='marketplace_ap'
    AND status='draft'
    AND mkt_ap_preparation_id IS NOT NULL
    AND journal_entry_id IS NULL
    AND EXISTS (SELECT 1 FROM public.mkt_ap_preparations ap
      WHERE ap.id=payment_requests.mkt_ap_preparation_id
        AND ap.company_id=payment_requests.company_id)
  );

ALTER POLICY pr50_finance_dev_handoff_insert ON public.mkt_accounting_handoffs
  WITH CHECK (
    company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer
    AND accounting_status='draft_not_posted'
    AND EXISTS (SELECT 1 FROM public.mkt_ap_preparations ap
      WHERE ap.id=mkt_accounting_handoffs.ap_preparation_id
        AND ap.company_id=mkt_accounting_handoffs.company_id)
    AND EXISTS (SELECT 1 FROM public.payment_requests pr
      WHERE pr.id=mkt_accounting_handoffs.payment_request_id
        AND pr.company_id=mkt_accounting_handoffs.company_id
        AND pr.source_type='marketplace_ap'
        AND pr.status='draft')
  );

DO $finance_rls_attest$
BEGIN
  IF (SELECT count(*) FROM pg_policies p
      WHERE p.schemaname='public'
        AND p.policyname IN ('pr50_finance_dev_ap_insert',
                             'pr50_finance_dev_payment_insert',
                             'pr50_finance_dev_handoff_insert')
        AND p.with_check NOT LIKE '%current_setting%') <> 0 THEN
    RAISE EXCEPTION 'CST_DEV_FINANCE_GUC_CONSTRAINT_LOST';
  END IF;
  IF (SELECT count(*) FROM pg_policies p
      WHERE p.schemaname='public'
        AND p.policyname IN ('pr50_finance_dev_ap_insert',
                             'pr50_finance_dev_payment_insert',
                             'pr50_finance_dev_handoff_insert')
        AND p.with_check ~ '(vi|ap|pr)\.company_id\s*=\s*\1\.company_id') <> 0 THEN
    RAISE EXCEPTION 'CST_DEV_FINANCE_COMPANY_SELF_COMPARISON_REMAINS';
  END IF;
END
$finance_rls_attest$;
