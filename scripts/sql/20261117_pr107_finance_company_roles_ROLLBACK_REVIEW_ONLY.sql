-- PR107 ROLLBACK REVIEW-ONLY. Guard forbids live execution.
BEGIN;
DO $no_go$
BEGIN
 RAISE EXCEPTION 'PR107_REVIEW_ONLY_ROLLBACK_DO_NOT_APPLY';
END
$no_go$;

DO $preflight$
DECLARE matched integer;
BEGIN
 SELECT count(*) INTO matched FROM pg_catalog.pg_policy p
 JOIN pg_catalog.pg_class c ON c.oid=p.polrelid
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND p.polname='pr107_company_role_restrictive_all' AND NOT p.polpermissive;
 IF matched<>11 THEN RAISE EXCEPTION 'PR107_ROLLBACK_GUARD_DRIFT %',matched; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev')
 AND rolcanlogin) THEN RAISE EXCEPTION 'PR107_ROLLBACK_REFUSE_LIVE_COMPANY_LOGIN'; END IF;
END $preflight$;

DROP POLICY pr107_company_role_restrictive_all ON public.mkt_purchase_orders;
DROP POLICY pr107_company_role_restrictive_all ON public.mkt_purchase_order_lines;
DROP POLICY pr107_company_role_restrictive_all ON public.mkt_po_shipments;
DROP POLICY pr107_company_role_restrictive_all ON public.mkt_po_shipment_items;
DROP POLICY pr107_company_role_restrictive_all ON public.mkt_po_goods_receipts;
DROP POLICY pr107_company_role_restrictive_all ON public.mkt_po_goods_receipt_items;
DROP POLICY pr107_company_role_restrictive_all ON public.vendor_invoices;
DROP POLICY pr107_company_role_restrictive_all ON public.vendor_invoice_lines;
DROP POLICY pr107_company_role_restrictive_all ON public.mkt_ap_preparations;
DROP POLICY pr107_company_role_restrictive_all ON public.payment_requests;
DROP POLICY pr107_company_role_restrictive_all ON public.mkt_accounting_handoffs;
-- Restore original exact policy targets; no original expressions changed.
ALTER POLICY pr50_finance_dev_handoff_insert ON public.mkt_accounting_handoffs TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_handoff_read ON public.mkt_accounting_handoffs TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_ap_insert ON public.mkt_ap_preparations TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_ap_read ON public.mkt_ap_preparations TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_ap_update ON public.mkt_ap_preparations TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_receipt_items_read ON public.mkt_po_goods_receipt_items TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_receipts_read ON public.mkt_po_goods_receipts TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_shipment_items_read ON public.mkt_po_shipment_items TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_shipments_read ON public.mkt_po_shipments TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_po_lines_read ON public.mkt_purchase_order_lines TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_po_read ON public.mkt_purchase_orders TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_payment_insert ON public.payment_requests TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_payment_read ON public.payment_requests TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_vendor_invoice_lines_insert ON public.vendor_invoice_lines TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_invoice_lines_read ON public.vendor_invoice_lines TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_vendor_invoice_insert ON public.vendor_invoices TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_invoice_read ON public.vendor_invoices TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_invoice_update ON public.vendor_invoices TO bizportal_marketplace_finance_login_dev;

REVOKE INSERT (invoice_number,vendor_invoice_ref,company_id,supplier_id,supplier_name,status,invoice_date,total_amount,tax_amount,grand_total,three_way_match_status,notes,created_by,mkt_purchase_order_id,mkt_goods_receipt_id,currency,attachment_object_path,attachment_file_name,attachment_content_type,attachment_size) ON public.vendor_invoices FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
REVOKE INSERT (invoice_id,name,quantity,unit,unit_cost,subtotal,tax_amount,notes,mkt_purchase_order_line_id) ON public.vendor_invoice_lines FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
REVOKE UPDATE (preparation_number,status,finance_reviewed_by,finance_reviewed_at,waiting_payment_at,updated_at,payment_request_id,payment_handoff_at,payment_handoff_by) ON public.mkt_ap_preparations FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
REVOKE UPDATE (status,three_way_match_status,match_notes,updated_at) ON public.vendor_invoices FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
REVOKE INSERT ON public.mkt_ap_preparations,public.payment_requests,public.mkt_accounting_handoffs FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
REVOKE SELECT ON public.mkt_purchase_orders,
  public.mkt_purchase_order_lines,
  public.mkt_po_shipments,
  public.mkt_po_shipment_items,
  public.mkt_po_goods_receipts,
  public.mkt_po_goods_receipt_items,
  public.vendor_invoices,
  public.vendor_invoice_lines,
  public.mkt_ap_preparations,
  public.payment_requests,
  public.mkt_accounting_handoffs FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
REVOKE USAGE ON SEQUENCE public.mkt_accounting_handoffs_id_seq,
  public.mkt_ap_preparations_id_seq,
  public.payment_requests_id_seq,
  public.vendor_invoice_lines_id_seq,
  public.vendor_invoices_id_seq FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
REVOKE USAGE ON SCHEMA public FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
DROP ROLE bizportal_finance_cst_login_dev;
DROP ROLE bizportal_finance_diva_login_dev;

DO $postflight$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev'))
   OR EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public'
       AND policyname='pr107_company_role_restrictive_all')
  THEN RAISE EXCEPTION 'PR107_ROLLBACK_RESIDUE'; END IF;
END $postflight$;
COMMIT;
