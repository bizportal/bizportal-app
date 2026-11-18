-- Disposable only: permit row locking without permitting UPDATE writes.
DO $guard$ BEGIN
 IF current_database() <> 'invoice_synthetic' THEN RAISE EXCEPTION 'DISPOSABLE_ONLY'; END IF;
END $guard$;
DROP POLICY qa_user_update_cst_deny ON public.qa_owner_user;
DROP POLICY qa_user_update_diva_deny ON public.qa_owner_user;
CREATE POLICY qa_user_update_cst_lock ON public.qa_owner_user FOR UPDATE
 TO bizportal_customer_invoice_cst_writer_dev
 USING (company_id=1 AND current_user=session_user)
 WITH CHECK (false);
CREATE POLICY qa_user_update_diva_lock ON public.qa_owner_user FOR UPDATE
 TO bizportal_customer_invoice_diva_writer_dev
 USING (company_id=3 AND current_user=session_user)
 WITH CHECK (false);
