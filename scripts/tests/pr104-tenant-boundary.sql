-- Synthetic PostgreSQL-only tenant RLS contract test.
-- All objects are created and dropped inside one disposable PostgreSQL container.
-- No actual CST-DEV role or database credential is involved.
BEGIN;
CREATE ROLE ci_pr104_finance NOLOGIN NOINHERIT NOBYPASSRLS;
GRANT ci_pr104_finance TO postgres WITH SET TRUE;
CREATE TABLE public.ci_pr104_po (
 id integer PRIMARY KEY, company_id integer NOT NULL, vendor_token text NOT NULL
);
INSERT INTO public.ci_pr104_po VALUES
 (11,1,'ci-token-one'),(31,3,'ci-token-three');
ALTER TABLE public.ci_pr104_po ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA public TO ci_pr104_finance;
GRANT SELECT ON public.ci_pr104_po TO ci_pr104_finance;
CREATE POLICY pr104_finance_read ON public.ci_pr104_po
 FOR SELECT TO ci_pr104_finance
 USING(company_id = NULLIF(current_setting('app.marketplace_company_id',true),'')::integer);
SET LOCAL ROLE ci_pr104_finance;
SELECT set_config('app.marketplace_company_id','1',true);
DO $assert$ BEGIN
 IF (SELECT count(*) FROM public.ci_pr104_po) <> 1
    OR NOT EXISTS (SELECT 1 FROM public.ci_pr104_po WHERE company_id=1)
 THEN RAISE EXCEPTION 'TENANT_1_SCOPE_FAILURE'; END IF;
END $assert$;
SELECT set_config('app.marketplace_company_id','3',true);
DO $assert$ BEGIN
 IF (SELECT count(*) FROM public.ci_pr104_po) <> 1
    OR NOT EXISTS (SELECT 1 FROM public.ci_pr104_po WHERE company_id=3)
 THEN RAISE EXCEPTION 'TENANT_3_SCOPE_SWITCH_FAILURE'; END IF;
END $assert$;
RESET ROLE;
ROLLBACK;
-- The outer rollback removes all test roles, policies, and fixtures.
SELECT CASE
 WHEN to_regclass('public.ci_pr104_po') IS NULL
 AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ci_pr104_finance')
 THEN 'PR104_CALLER_SETTABLE_TENANT_SCOPE_REPRODUCED_AND_CLEANED_PASS'
 ELSE 'PR104_TEST_CLEANUP_FAILED'
 END AS result;
