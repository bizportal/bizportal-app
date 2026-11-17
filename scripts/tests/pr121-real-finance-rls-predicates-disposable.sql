-- PR121 DISPOSABLE-ONLY: exact 18 legacy RLS predicate expressions as read from CST-DEV on 2026-11-17.
-- Original source preflight MD5: f69295cc7f66f8bc4645a6fc02e2f36e.
-- Additive test fixture only; NOT a Supabase migration. Never run on CST-DEV or PROD.
-- Apply only AFTER PR107/108 synthetic fixture and Drizzle column/type parity setup.
-- Existing original PR107/108 abort guards remain untouched.
BEGIN;
-- Convert the existing minimal CI fixture's status TEXT columns to the
-- enum types defined by the canonical Drizzle schema, solely in disposable PG.
-- The synthetic baseline's old AP status 'draft' is not a valid modern enum;
-- normalize this inert historical test row before the enum cast.
UPDATE public.mkt_ap_preparations SET status='ap_preparation' WHERE status='draft';
ALTER TABLE public.mkt_purchase_orders
  ALTER COLUMN status TYPE mkt_po_status USING status::mkt_po_status;
ALTER TABLE public.vendor_invoices
  ALTER COLUMN status TYPE vi_status USING status::vi_status;
ALTER TABLE public.mkt_ap_preparations
  ALTER COLUMN status TYPE mkt_ap_preparation_status USING status::mkt_ap_preparation_status;
ALTER TABLE public.payment_requests
  ALTER COLUMN status TYPE pay_req_status USING status::pay_req_status;

ALTER POLICY pr50_finance_dev_handoff_insert ON public.mkt_accounting_handoffs
  WITH CHECK (((company_id = (NULLIF(current_setting('app.marketplace_company_id'::text, true), ''::text))::integer) AND (accounting_status = 'draft_not_posted'::text) AND (EXISTS ( SELECT 1
   FROM mkt_ap_preparations ap
  WHERE ((ap.id = mkt_accounting_handoffs.ap_preparation_id) AND (ap.company_id = mkt_accounting_handoffs.company_id)))) AND (EXISTS ( SELECT 1
   FROM payment_requests pr
  WHERE ((pr.id = mkt_accounting_handoffs.payment_request_id) AND (pr.company_id = mkt_accounting_handoffs.company_id) AND (pr.source_type = 'marketplace_ap'::text) AND (pr.status = 'draft'::pay_req_status))))));
ALTER POLICY pr50_finance_dev_handoff_read ON public.mkt_accounting_handoffs
  USING ((company_id = (NULLIF(current_setting('app.marketplace_company_id'::text, true), ''::text))::integer));
ALTER POLICY pr50_finance_dev_ap_insert ON public.mkt_ap_preparations
  WITH CHECK (((company_id = (NULLIF(current_setting('app.marketplace_company_id'::text, true), ''::text))::integer) AND (status = 'ap_preparation'::mkt_ap_preparation_status) AND (EXISTS ( SELECT 1
   FROM vendor_invoices vi
  WHERE ((vi.id = mkt_ap_preparations.vendor_invoice_id) AND (vi.company_id = mkt_ap_preparations.company_id) AND (vi.mkt_purchase_order_id IS NOT NULL) AND (vi.three_way_match_status = 'passed'::text))))));
ALTER POLICY pr50_finance_dev_ap_read ON public.mkt_ap_preparations
  USING ((company_id = (NULLIF(current_setting('app.marketplace_company_id'::text, true), ''::text))::integer));
ALTER POLICY pr50_finance_dev_ap_update ON public.mkt_ap_preparations
  USING ((company_id = (NULLIF(current_setting('app.marketplace_company_id'::text, true), ''::text))::integer))
  WITH CHECK ((company_id = (NULLIF(current_setting('app.marketplace_company_id'::text, true), ''::text))::integer));
ALTER POLICY pr50_finance_dev_receipt_items_read ON public.mkt_po_goods_receipt_items
  USING ((EXISTS ( SELECT 1
   FROM ((mkt_po_goods_receipts gr
     JOIN mkt_po_shipments sh ON ((sh.id = gr.shipment_id)))
     JOIN mkt_purchase_orders po ON ((po.id = sh.po_id)))
  WHERE ((gr.id = mkt_po_goods_receipt_items.goods_receipt_id) AND (po.company_id = (NULLIF(current_setting('app.marketplace_company_id'::text, true), ''::text))::integer)))));
ALTER POLICY pr50_finance_dev_receipts_read ON public.mkt_po_goods_receipts
  USING ((EXISTS ( SELECT 1
   FROM (mkt_po_shipments sh
     JOIN mkt_purchase_orders po ON ((po.id = sh.po_id)))
  WHERE ((sh.id = mkt_po_goods_receipts.shipment_id) AND (po.company_id = (NULLIF(current_setting('app.marketplace_company_id'::text, true), ''::text))::integer)))));
ALTER POLICY pr50_finance_dev_shipment_items_read ON public.mkt_po_shipment_items
  USING ((EXISTS ( SELECT 1
   FROM (mkt_po_shipments sh
     JOIN mkt_purchase_orders po ON ((po.id = sh.po_id)))
  WHERE ((sh.id = mkt_po_shipment_items.shipment_id) AND (po.company_id = (NULLIF(current_setting('app.marketplace_company_id'::text, true), ''::text))::integer)))));
ALTER POLICY pr50_finance_dev_shipments_read ON public.mkt_po_shipments
  USING ((EXISTS ( SELECT 1
   FROM mkt_purchase_orders po
  WHERE ((po.id = mkt_po_shipments.po_id) AND (po.company_id = (NULLIF(current_setting('app.marketplace_company_id'::text, true), ''::text))::integer)))));
ALTER POLICY pr50_finance_dev_po_lines_read ON public.mkt_purchase_order_lines
  USING ((EXISTS ( SELECT 1
   FROM mkt_purchase_orders po
  WHERE ((po.id = mkt_purchase_order_lines.po_id) AND (po.company_id = (NULLIF(current_setting('app.marketplace_company_id'::text, true), ''::text))::integer)))));
ALTER POLICY pr50_finance_dev_po_read ON public.mkt_purchase_orders
  USING ((company_id = (NULLIF(current_setting('app.marketplace_company_id'::text, true), ''::text))::integer));
ALTER POLICY pr50_finance_dev_payment_insert ON public.payment_requests
  WITH CHECK (((company_id = (NULLIF(current_setting('app.marketplace_company_id'::text, true), ''::text))::integer) AND (source_type = 'marketplace_ap'::text) AND (status = 'draft'::pay_req_status) AND (mkt_ap_preparation_id IS NOT NULL) AND (journal_entry_id IS NULL) AND (EXISTS ( SELECT 1
   FROM mkt_ap_preparations ap
  WHERE ((ap.id = payment_requests.mkt_ap_preparation_id) AND (ap.company_id = payment_requests.company_id))))));
ALTER POLICY pr50_finance_dev_payment_read ON public.payment_requests
  USING (((company_id = (NULLIF(current_setting('app.marketplace_company_id'::text, true), ''::text))::integer) AND (source_type = 'marketplace_ap'::text)));
ALTER POLICY pr50_finance_dev_invoice_lines_read ON public.vendor_invoice_lines
  USING ((EXISTS ( SELECT 1
   FROM vendor_invoices vi
  WHERE ((vi.id = vendor_invoice_lines.invoice_id) AND (vi.company_id = (NULLIF(current_setting('app.marketplace_company_id'::text, true), ''::text))::integer) AND (vi.mkt_purchase_order_id IS NOT NULL)))));
ALTER POLICY pr50_finance_dev_vendor_invoice_lines_insert ON public.vendor_invoice_lines
  WITH CHECK (((invoice_id IS NOT NULL) AND (mkt_purchase_order_line_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM (vendor_invoices vi
     JOIN mkt_purchase_order_lines pol ON ((pol.po_id = vi.mkt_purchase_order_id)))
  WHERE ((vi.id = vendor_invoice_lines.invoice_id) AND (pol.id = vendor_invoice_lines.mkt_purchase_order_line_id) AND (vi.company_id = (NULLIF(current_setting('app.marketplace_company_id'::text, true), ''::text))::integer) AND (vi.mkt_purchase_order_id IS NOT NULL) AND (vi.status = 'draft'::vi_status))))));
ALTER POLICY pr50_finance_dev_invoice_read ON public.vendor_invoices
  USING (((company_id = (NULLIF(current_setting('app.marketplace_company_id'::text, true), ''::text))::integer) AND (mkt_purchase_order_id IS NOT NULL)));
ALTER POLICY pr50_finance_dev_invoice_update ON public.vendor_invoices
  USING (((company_id = (NULLIF(current_setting('app.marketplace_company_id'::text, true), ''::text))::integer) AND (mkt_purchase_order_id IS NOT NULL)))
  WITH CHECK (((company_id = (NULLIF(current_setting('app.marketplace_company_id'::text, true), ''::text))::integer) AND (mkt_purchase_order_id IS NOT NULL)));
ALTER POLICY pr50_finance_dev_vendor_invoice_insert ON public.vendor_invoices
  WITH CHECK (((company_id = (NULLIF(current_setting('app.marketplace_company_id'::text, true), ''::text))::integer) AND (mkt_purchase_order_id IS NOT NULL) AND (mkt_goods_receipt_id IS NOT NULL) AND (supplier_id IS NOT NULL) AND (status = 'draft'::vi_status) AND (three_way_match_status = 'unmatched'::text) AND (journal_entry_id IS NULL) AND (EXISTS ( SELECT 1
   FROM ((mkt_purchase_orders po
     JOIN mkt_po_shipments sh ON ((sh.po_id = po.id)))
     JOIN mkt_po_goods_receipts gr ON ((gr.shipment_id = sh.id)))
  WHERE ((po.id = vendor_invoices.mkt_purchase_order_id) AND (gr.id = vendor_invoices.mkt_goods_receipt_id) AND (po.vendor_id = vendor_invoices.supplier_id) AND (po.company_id = po.company_id) AND (po.company_id = (NULLIF(current_setting('app.marketplace_company_id'::text, true), ''::text))::integer) AND (sh.shipment_status = 'delivered'::text) AND (gr.inspection_status = 'passed'::text))))));
COMMIT;
