-- PR102 review-only ROLLBACK CANDIDATE.
-- NOT EXECUTABLE WITHOUT SEPARATE RELEASE APPROVAL.
-- Do not run if the installation was never performed; never target PROD.
BEGIN;
DO $no_go$
BEGIN
  RAISE EXCEPTION 'PR102_ROLLBACK_REVIEW_ONLY_DO_NOT_APPLY';
END
$no_go$;
REVOKE EXECUTE ON FUNCTION
 finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)
 FROM bizportal_marketplace_finance_login_dev;
DROP FUNCTION
 finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text);
DROP POLICY pr102_parent_gr_update_dev ON public.mkt_po_goods_receipts;
DROP POLICY pr102_parent_gr_select_dev ON public.mkt_po_goods_receipts;
DROP POLICY pr103_parent_shipment_update_dev ON public.mkt_po_shipments;
DROP POLICY pr102_parent_shipment_select_dev ON public.mkt_po_shipments;
DROP POLICY pr102_parent_po_update_dev ON public.mkt_purchase_orders;
DROP POLICY pr102_parent_po_select_dev ON public.mkt_purchase_orders;
REVOKE UPDATE(status) ON public.mkt_purchase_orders
 FROM bizportal_finance_parent_lock_owner_dev;
REVOKE UPDATE(inspection_status) ON public.mkt_po_goods_receipts
 FROM bizportal_finance_parent_lock_owner_dev;
REVOKE UPDATE(shipment_status) ON public.mkt_po_shipments
 FROM bizportal_finance_parent_lock_owner_dev;
REVOKE SELECT ON public.mkt_purchase_orders, public.mkt_po_shipments, public.mkt_po_goods_receipts
 FROM bizportal_finance_parent_lock_owner_dev;
REVOKE USAGE ON SCHEMA public FROM bizportal_finance_parent_lock_owner_dev;
REVOKE USAGE ON SCHEMA finance_ops_private
 FROM bizportal_marketplace_finance_login_dev,bizportal_finance_parent_lock_owner_dev;
DROP SCHEMA finance_ops_private RESTRICT;
DROP ROLE bizportal_finance_parent_lock_owner_dev;
COMMIT;
