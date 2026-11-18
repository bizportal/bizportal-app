-- Run with direct synthetic CST/DIVA login after Phase B1/B2/B3 in PG16 QA.
DO $qa$
DECLARE
 t int; w text; n int; changed int;
BEGIN
 w:=session_user;
 t:=CASE w WHEN 'bizportal_customer_invoice_cst_writer_dev' THEN 1
           WHEN 'bizportal_customer_invoice_diva_writer_dev' THEN 3
           ELSE NULL END;
 IF t IS NULL OR current_user<>session_user THEN
  RAISE EXCEPTION 'B3_DIRECT_LOGIN_REQUIRED';
 END IF;
 IF NOT has_column_privilege(w,'public.users','updated_at','UPDATE')
 OR NOT has_column_privilege(w,'public.portal_customers','status_changed_at','UPDATE')
 OR NOT has_column_privilege(w,'public.portal_company_members','updated_at','UPDATE')
 OR NOT has_column_privilege(w,'public.portal_company_requests','updated_at','UPDATE')
 OR has_column_privilege(w,'public.users','role','UPDATE')
 OR has_column_privilege(w,'public.portal_company_requests','status','UPDATE') THEN
  RAISE EXCEPTION 'B3_WRONG_COLUMN_GRANTS';
 END IF;
 SELECT count(*) INTO n FROM (
  SELECT id,role,system_role,status,is_active,company_id FROM public.users
  WHERE lower(trim(email))=lower(trim('global@qa.invalid'))
    AND role='super_admin' AND system_role='super_admin'
    AND status='active' AND is_active IS TRUE
  LIMIT 2 FOR SHARE
 ) locked_owner;
 IF n<>1 THEN RAISE EXCEPTION 'B3_CANONICAL_SUPERADMIN_FOR_SHARE_DENIED';END IF;
 SELECT count(*) INTO n FROM (
  SELECT 1 AS approved
  FROM public.portal_company_requests approval
  JOIN public.portal_company_members member
    ON member.portal_customer_id=approval.portal_customer_id
   AND member.company_id=approval.matched_company_id AND member.is_active=true
  JOIN public.portal_customers reviewer
    ON reviewer.id=approval.reviewed_by
   AND reviewer.role='admin'
   AND (reviewer.account_status='active' OR reviewer.account_status IS NULL)
  JOIN public.portal_customers issuer
    ON issuer.id=approval.portal_customer_id
   AND issuer.role='admin'
   AND (issuer.account_status='active' OR issuer.account_status IS NULL)
  WHERE approval.portal_customer_id=10
    AND approval.matched_company_id=t
    AND approval.status='approved'
    AND approval.reviewed_by IS NOT NULL
    AND approval.reviewed_by<>10
    AND approval.reviewed_at IS NOT NULL
  LIMIT 1 FOR SHARE OF member,approval,reviewer,issuer
 ) locked_approval;
 IF n<>1 THEN RAISE EXCEPTION 'B3_COMPANY_REVIEWER_ISSUER_FOR_SHARE_DENIED'; END IF;
 BEGIN
  UPDATE public.users SET updated_at=clock_timestamp() WHERE id='global-admin';
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>0 THEN RAISE EXCEPTION 'B3_USER_WRITE_ALLOWED'; END IF;
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  UPDATE public.portal_customers SET status_changed_at=clock_timestamp() WHERE id=10;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>0 THEN RAISE EXCEPTION 'B3_PORTAL_ADMIN_WRITE_ALLOWED'; END IF;
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  UPDATE public.portal_company_members SET updated_at=clock_timestamp()
  WHERE portal_customer_id=10 AND company_id=t;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>0 THEN RAISE EXCEPTION 'B3_MEMBERSHIP_WRITE_ALLOWED'; END IF;
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  UPDATE public.portal_company_requests SET updated_at=clock_timestamp()
  WHERE portal_customer_id=10 AND matched_company_id=t AND status='approved';
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>0 THEN RAISE EXCEPTION 'B3_APPROVAL_WRITE_ALLOWED'; END IF;
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 RAISE NOTICE 'CST_INVOICE_B3_DIRECT_OWNER_AND_APPROVAL_ROWLOCK_NO_WRITE_PASS: % %',w,t;
END $qa$;
