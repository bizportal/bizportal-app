-- CST-DEV phase 2 rollback. Reverses private owner/function and six policies,
-- retaining phase 0 dormant roles and phase 1 company restrictive RLS.
-- Refuses after any company LOGIN promotion, credential release, or drift.
BEGIN;
SET LOCAL lock_timeout='800ms';
SET LOCAL statement_timeout='25000ms';
DO $release_rollback_gate$
DECLARE n integer;
BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres'
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_ROLLBACK_WRONG_DATABASE_OR_ADMIN'; END IF;
 SELECT count(*) INTO n FROM pg_roles WHERE
   rolname IN ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev')
     AND NOT rolcanlogin AND NOT rolinherit AND NOT rolbypassrls AND NOT rolsuper;
 IF n<>2 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_ROLLBACK_COMPANY_LOGIN_ACTIVE'; END IF;
 SELECT count(*) INTO n FROM pg_policies WHERE schemaname='public'
   AND policyname IN ('pr108_definer_read','pr108_definer_lock');
 IF n<>6 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_ROLLBACK_OWNER_POLICY_DRIFT'; END IF;
 IF to_regprocedure('finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)') IS NULL
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_ROLLBACK_PRIVATE_FUNCTION_MISSING'; END IF;
END
$release_rollback_gate$;
DO $preflight$
BEGIN
  IF current_database() NOT IN ('postgres','cst_pr107_ci')
    OR to_regprocedure('finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)') IS NULL
    OR to_regrole('bizportal_finance_parent_lock_owner_dev') IS NULL
  THEN RAISE EXCEPTION 'PR108_ROLLBACK_TARGET_NOT_READY'; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname IN ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev') AND rolcanlogin)
  THEN RAISE EXCEPTION 'PR108_ROLLBACK_REFUSE_ACTIVE_COMPANY_LOGIN'; END IF;
END $preflight$;

REVOKE EXECUTE ON FUNCTION finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text) FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
DROP FUNCTION finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text);
DROP POLICY pr108_definer_lock ON public.mkt_purchase_orders;
DROP POLICY pr108_definer_read ON public.mkt_purchase_orders;
DROP POLICY pr108_definer_lock ON public.mkt_po_shipments;
DROP POLICY pr108_definer_read ON public.mkt_po_shipments;
DROP POLICY pr108_definer_lock ON public.mkt_po_goods_receipts;
DROP POLICY pr108_definer_read ON public.mkt_po_goods_receipts;
REVOKE UPDATE(status) ON public.mkt_purchase_orders FROM bizportal_finance_parent_lock_owner_dev;
REVOKE UPDATE(inspection_status) ON public.mkt_po_goods_receipts FROM bizportal_finance_parent_lock_owner_dev;
REVOKE UPDATE(shipment_status) ON public.mkt_po_shipments FROM bizportal_finance_parent_lock_owner_dev;
REVOKE SELECT ON public.mkt_purchase_orders,public.mkt_po_goods_receipts,public.mkt_po_shipments FROM bizportal_finance_parent_lock_owner_dev;
REVOKE USAGE ON SCHEMA public FROM bizportal_finance_parent_lock_owner_dev;
REVOKE USAGE ON SCHEMA finance_ops_private FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev,bizportal_finance_parent_lock_owner_dev;
DROP SCHEMA finance_ops_private RESTRICT;
DROP ROLE bizportal_finance_parent_lock_owner_dev;
DO $verify$
BEGIN
  IF to_regprocedure('finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)') IS NOT NULL
    OR to_regnamespace('finance_ops_private') IS NOT NULL
    OR to_regrole('bizportal_finance_parent_lock_owner_dev') IS NOT NULL
  THEN RAISE EXCEPTION 'PR108_ROLLBACK_LEAVES_OBJECTS'; END IF;
END $verify$;
DO $release_rollback_post$
BEGIN
 IF (SELECT count(*) FROM pg_roles WHERE rolname IN
   ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev')
   AND NOT rolcanlogin)<>2
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_ROLLBACK_DORMANT_ROLES_MISSING'; END IF;
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public'
   AND policyname='pr107_company_role_restrictive_all')<>11
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_ROLLBACK_PHASE1_SECURITY_MISSING'; END IF;
END
$release_rollback_post$;
COMMIT;
