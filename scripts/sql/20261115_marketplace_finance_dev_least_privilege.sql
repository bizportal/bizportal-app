-- PR #50 / CST-DEV only. Never run on PROD.
-- Review-only migration. A separate secret provisioning step is required for
-- BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV; no credential is in this file.
-- The backend must bind app.marketplace_company_id with set_config(..., true)
-- inside the SAME verified signed-admin Finance transaction.
-- No access to users, OTP, ledgers, payroll, or ordinary vendor AP is granted.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='bizportal_marketplace_finance_login_dev') THEN
    CREATE ROLE bizportal_marketplace_finance_login_dev
      LOGIN NOINHERIT NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO bizportal_marketplace_finance_login_dev;
GRANT SELECT ON
  public.mkt_purchase_orders,
  public.mkt_purchase_order_lines,
  public.mkt_po_shipments,
  public.mkt_po_shipment_items,
  public.mkt_po_goods_receipts,
  public.mkt_po_goods_receipt_items,
  public.vendor_invoices,
  public.vendor_invoice_lines,
  public.mkt_ap_preparations,
  public.mkt_accounting_handoffs,
  public.payment_requests
TO bizportal_marketplace_finance_login_dev;
GRANT UPDATE (status, updated_at, three_way_match_status, match_notes)
  ON public.vendor_invoices TO bizportal_marketplace_finance_login_dev;
GRANT UPDATE (
  preparation_number, status, updated_at, finance_reviewed_by, finance_reviewed_at,
  waiting_payment_at, payment_request_id, payment_handoff_at, payment_handoff_by
) ON public.mkt_ap_preparations TO bizportal_marketplace_finance_login_dev;
GRANT INSERT ON public.mkt_ap_preparations, public.payment_requests,
  public.mkt_accounting_handoffs TO bizportal_marketplace_finance_login_dev;
GRANT USAGE ON SEQUENCE public.mkt_ap_preparations_id_seq,
  public.payment_requests_id_seq, public.mkt_accounting_handoffs_id_seq
  TO bizportal_marketplace_finance_login_dev;

-- All policies are specifically for this new role. Existing reader policies
-- (including unassigned historical PO reads) remain completely unchanged.
CREATE POLICY pr50_finance_dev_po_read ON public.mkt_purchase_orders
 FOR SELECT TO bizportal_marketplace_finance_login_dev
 USING (company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer);
CREATE POLICY pr50_finance_dev_po_lines_read ON public.mkt_purchase_order_lines
 FOR SELECT TO bizportal_marketplace_finance_login_dev
 USING (EXISTS (
  SELECT 1 FROM public.mkt_purchase_orders po
  WHERE po.id = po_id AND
        po.company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer
 ));
CREATE POLICY pr50_finance_dev_shipments_read ON public.mkt_po_shipments
 FOR SELECT TO bizportal_marketplace_finance_login_dev
 USING (EXISTS (
  SELECT 1 FROM public.mkt_purchase_orders po
  WHERE po.id = po_id AND
        po.company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer
 ));
CREATE POLICY pr50_finance_dev_shipment_items_read ON public.mkt_po_shipment_items
 FOR SELECT TO bizportal_marketplace_finance_login_dev
 USING (EXISTS (
  SELECT 1 FROM public.mkt_po_shipments sh
  JOIN public.mkt_purchase_orders po ON po.id=sh.po_id
  WHERE sh.id = shipment_id AND
        po.company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer
 ));
CREATE POLICY pr50_finance_dev_receipts_read ON public.mkt_po_goods_receipts
 FOR SELECT TO bizportal_marketplace_finance_login_dev
 USING (EXISTS (
  SELECT 1 FROM public.mkt_po_shipments sh
  JOIN public.mkt_purchase_orders po ON po.id=sh.po_id
  WHERE sh.id = shipment_id AND
        po.company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer
 ));
CREATE POLICY pr50_finance_dev_receipt_items_read ON public.mkt_po_goods_receipt_items
 FOR SELECT TO bizportal_marketplace_finance_login_dev
 USING (EXISTS (
  SELECT 1 FROM public.mkt_po_goods_receipts gr
  JOIN public.mkt_po_shipments sh ON sh.id=gr.shipment_id
  JOIN public.mkt_purchase_orders po ON po.id=sh.po_id
  WHERE gr.id = goods_receipt_id AND
        po.company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer
 ));

-- Ordinary vendor invoices (unlinked to Marketplace PO) must remain invisible.
CREATE POLICY pr50_finance_dev_invoice_read ON public.vendor_invoices
 FOR SELECT TO bizportal_marketplace_finance_login_dev
 USING (company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer
        AND mkt_purchase_order_id IS NOT NULL);
CREATE POLICY pr50_finance_dev_invoice_update ON public.vendor_invoices
 FOR UPDATE TO bizportal_marketplace_finance_login_dev
 USING (company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer
        AND mkt_purchase_order_id IS NOT NULL)
 WITH CHECK (company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer
        AND mkt_purchase_order_id IS NOT NULL);
CREATE POLICY pr50_finance_dev_invoice_lines_read ON public.vendor_invoice_lines
 FOR SELECT TO bizportal_marketplace_finance_login_dev
 USING (EXISTS (
  SELECT 1 FROM public.vendor_invoices vi
  WHERE vi.id=invoice_id
    AND vi.company_id=nullif(current_setting('app.marketplace_company_id',true),'')::integer
    AND vi.mkt_purchase_order_id IS NOT NULL
 ));

CREATE POLICY pr50_finance_dev_ap_read ON public.mkt_ap_preparations
 FOR SELECT TO bizportal_marketplace_finance_login_dev
 USING (company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer);
CREATE POLICY pr50_finance_dev_ap_insert ON public.mkt_ap_preparations
 FOR INSERT TO bizportal_marketplace_finance_login_dev
 WITH CHECK (company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer
  AND EXISTS (SELECT 1 FROM public.vendor_invoices vi
              WHERE vi.id=vendor_invoice_id AND vi.company_id=company_id
                AND vi.mkt_purchase_order_id IS NOT NULL
                AND vi.three_way_match_status='passed'));
CREATE POLICY pr50_finance_dev_ap_update ON public.mkt_ap_preparations
 FOR UPDATE TO bizportal_marketplace_finance_login_dev
 USING (company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer)
 WITH CHECK (company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer);

CREATE POLICY pr50_finance_dev_payment_read ON public.payment_requests
 FOR SELECT TO bizportal_marketplace_finance_login_dev
 USING (company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer
        AND source_type='marketplace_ap');
CREATE POLICY pr50_finance_dev_payment_insert ON public.payment_requests
 FOR INSERT TO bizportal_marketplace_finance_login_dev
 WITH CHECK (company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer
        AND source_type='marketplace_ap' AND status='draft'
        AND mkt_ap_preparation_id IS NOT NULL AND journal_entry_id IS NULL
        AND EXISTS (SELECT 1 FROM public.mkt_ap_preparations ap
                    WHERE ap.id=mkt_ap_preparation_id AND ap.company_id=company_id));

CREATE POLICY pr50_finance_dev_handoff_read ON public.mkt_accounting_handoffs
 FOR SELECT TO bizportal_marketplace_finance_login_dev
 USING (company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer);
CREATE POLICY pr50_finance_dev_handoff_insert ON public.mkt_accounting_handoffs
 FOR INSERT TO bizportal_marketplace_finance_login_dev
 WITH CHECK (company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer
        AND accounting_status='draft_not_posted'
        AND EXISTS (SELECT 1 FROM public.mkt_ap_preparations ap
                    WHERE ap.id=ap_preparation_id AND ap.company_id=company_id)
        AND EXISTS (SELECT 1 FROM public.payment_requests pr
                    WHERE pr.id=payment_request_id AND pr.company_id=company_id
                      AND pr.source_type='marketplace_ap' AND pr.status='draft'));

-- Explicitly no DELETE grants or DELETE policies. The legacy Marketplace
-- reader login and its unassigned-PO read policy are deliberately untouched.
