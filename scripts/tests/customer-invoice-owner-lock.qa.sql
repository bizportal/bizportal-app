-- Disposable only: test least-privilege FOR SHARE semantics.
DO $guard$ BEGIN
 IF current_database() <> 'invoice_synthetic' THEN RAISE EXCEPTION 'DISPOSABLE_ONLY'; END IF;
END $guard$;
CREATE TABLE public.qa_owner_user (
  id integer primary key,
  company_id integer not null,
  email text not null,
  updated_at timestamptz not null default now()
);
INSERT INTO public.qa_owner_user(id,company_id,email)
VALUES (1,1,'qa-owner@invalid.local'),(3,3,'qa-diva-owner@invalid.local');
ALTER TABLE public.qa_owner_user ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.qa_owner_user
 TO bizportal_customer_invoice_cst_writer_dev,
    bizportal_customer_invoice_diva_writer_dev;
CREATE POLICY qa_user_select_cst ON public.qa_owner_user FOR SELECT
 TO bizportal_customer_invoice_cst_writer_dev
 USING (company_id=1 AND current_user=session_user);
CREATE POLICY qa_user_select_diva ON public.qa_owner_user FOR SELECT
 TO bizportal_customer_invoice_diva_writer_dev
 USING (company_id=3 AND current_user=session_user);
CREATE POLICY qa_user_update_cst_deny ON public.qa_owner_user FOR UPDATE
 TO bizportal_customer_invoice_cst_writer_dev USING (false) WITH CHECK (false);
CREATE POLICY qa_user_update_diva_deny ON public.qa_owner_user FOR UPDATE
 TO bizportal_customer_invoice_diva_writer_dev USING (false) WITH CHECK (false);
