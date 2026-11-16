-- PR108 ROLLBACK REVIEW-ONLY. Never apply directly to a real DB.
BEGIN;
DO $no_go$
BEGIN
  RAISE EXCEPTION 'PR108_SESSION_BOUND_DEFINER_ROLLBACK_REVIEW_ONLY_DO_NOT_APPLY';
END
$no_go$;

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
COMMIT;
