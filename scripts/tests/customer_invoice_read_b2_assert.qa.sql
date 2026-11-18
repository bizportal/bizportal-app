-- Disposable QA: Phase B2 read-only identity and company-approval acceptance.
DO $qa$
DECLARE t int;w text;n int;
BEGIN
 w:=session_user;
 t:=CASE w
  WHEN 'bizportal_customer_invoice_cst_writer_dev' THEN 1
  WHEN 'bizportal_customer_invoice_diva_writer_dev' THEN 3
  ELSE NULL END;
 IF t IS NULL OR current_user<>session_user THEN
  RAISE EXCEPTION 'B2_DIRECT_LOGIN_REQUIRED';
 END IF;
 IF NOT row_security_active('public.users'::regclass)
 OR NOT row_security_active('public.portal_customers'::regclass)
 OR NOT row_security_active('public.portal_company_members'::regclass)
 OR NOT row_security_active('public.portal_company_requests'::regclass) THEN
  RAISE EXCEPTION 'B2_EFFECTIVE_RLS_REQUIRED';
 END IF;
 IF (SELECT count(*) FROM public.users)<>2 THEN
  RAISE EXCEPTION 'B2_SUPERADMIN_COMPANY_SCOPE_INVALID';
 END IF;
 IF (SELECT count(*) FROM public.portal_customers)<>3 THEN
  RAISE EXCEPTION 'B2_PORTAL_ADMIN_AND_INVOICE_CUSTOMER_SCOPE_INVALID';
 END IF;
 IF (SELECT count(*) FROM public.portal_company_members)<>2 THEN
  RAISE EXCEPTION 'B2_ONLY_ACTIVE_MEMBER_OWN_COMPANY';
 END IF;
 IF (SELECT count(*) FROM public.portal_company_requests)<>1 THEN
  RAISE EXCEPTION 'B2_ONLY_INDEPENDENT_APPROVED_ADMIN_REQUEST';
 END IF;
 IF (SELECT count(*) FROM public.portal_company_requests
    WHERE matched_company_id<>t OR reviewed_by=portal_customer_id
       OR status<>'approved' OR reviewed_at IS NULL)<>0 THEN
  RAISE EXCEPTION 'B2_FOREIGN_OR_SELF_REVIEW_VISIBLE';
 END IF;
 IF has_column_privilege(w,'public.users','password_hash','SELECT')
    OR has_column_privilege(w,'public.portal_customers','password_hash','SELECT')
    OR has_table_privilege(w,'public.users','UPDATE')
    OR has_table_privilege(w,'public.portal_company_requests','UPDATE')
    OR has_table_privilege(w,'public.portal_company_members','UPDATE')
    OR has_table_privilege(w,'public.portal_customers','UPDATE') THEN
  RAISE EXCEPTION 'B2_PRIVATE_FIELDS_OR_WRITE_GRANTED';
 END IF;
 -- GUC-controlled tenant impersonation must not alter CURRENT_USER-based scope.
 PERFORM set_config('app.marketplace_company_id',(CASE t WHEN 1 THEN '3' ELSE '1' END),false);
 IF (SELECT count(*) FROM public.portal_company_requests)<>1
    OR (SELECT count(*) FROM public.users)<>2 THEN
  RAISE EXCEPTION 'B2_TENANT_GUC_SPOOF';
 END IF;
 RAISE NOTICE 'CST_INVOICE_B2_SCOPED_AUTH_READ_ONLY_PASS: role=% company=%',w,t;
END $qa$;
