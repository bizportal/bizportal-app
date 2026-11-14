-- CST-DEV ONLY. Manual guarded rollback for PR #50 dedicated Finance role.
-- Deliberately not auto-run. Does not drop tables, change data, or touch
-- legacy Marketplace reader, Payroll, OTP, or any production database.
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies
      WHERE schemaname='public' AND policyname LIKE 'pr50_finance_dev_%') != 16
  THEN RAISE EXCEPTION 'PR50_FINANCE_POLICY_DRIFT: refuse rollback'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity
             WHERE usename='bizportal_marketplace_finance_login_dev'
             AND pid <> pg_backend_pid())
  THEN RAISE EXCEPTION 'PR50_FINANCE_ACTIVE_CONNECTION: refuse rollback'; END IF;
END $$;

DROP POLICY pr50_finance_dev_po_read ON public.mkt_purchase_orders;
DROP POLICY pr50_finance_dev_po_lines_read ON public.mkt_purchase_order_lines;
DROP POLICY pr50_finance_dev_shipments_read ON public.mkt_po_shipments;
DROP POLICY pr50_finance_dev_shipment_items_read ON public.mkt_po_shipment_items;
DROP POLICY pr50_finance_dev_receipts_read ON public.mkt_po_goods_receipts;
DROP POLICY pr50_finance_dev_receipt_items_read ON public.mkt_po_goods_receipt_items;
DROP POLICY pr50_finance_dev_invoice_read ON public.vendor_invoices;
DROP POLICY pr50_finance_dev_invoice_update ON public.vendor_invoices;
DROP POLICY pr50_finance_dev_invoice_lines_read ON public.vendor_invoice_lines;
DROP POLICY pr50_finance_dev_ap_read ON public.mkt_ap_preparations;
DROP POLICY pr50_finance_dev_ap_insert ON public.mkt_ap_preparations;
DROP POLICY pr50_finance_dev_ap_update ON public.mkt_ap_preparations;
DROP POLICY pr50_finance_dev_payment_read ON public.payment_requests;
DROP POLICY pr50_finance_dev_payment_insert ON public.payment_requests;
DROP POLICY pr50_finance_dev_handoff_read ON public.mkt_accounting_handoffs;
DROP POLICY pr50_finance_dev_handoff_insert ON public.mkt_accounting_handoffs;

REVOKE ALL PRIVILEGES ON
  public.mkt_purchase_orders, public.mkt_purchase_order_lines,
  public.mkt_po_shipments, public.mkt_po_shipment_items,
  public.mkt_po_goods_receipts, public.mkt_po_goods_receipt_items,
  public.vendor_invoices, public.vendor_invoice_lines,
  public.mkt_ap_preparations, public.payment_requests,
  public.mkt_accounting_handoffs
FROM bizportal_marketplace_finance_login_dev;
REVOKE ALL PRIVILEGES ON SEQUENCE
  public.mkt_ap_preparations_id_seq, public.payment_requests_id_seq,
  public.mkt_accounting_handoffs_id_seq
FROM bizportal_marketplace_finance_login_dev;
REVOKE USAGE ON SCHEMA public FROM bizportal_marketplace_finance_login_dev;

-- RESTRICT semantics: fail rather than remove any additional dependencies.
DROP ROLE bizportal_marketplace_finance_login_dev;
