-- CST-DEV only. Additional, narrowly scoped vendor-token invoice creation.
-- Existing finance reader/AP policies remain unchanged. No role passwords.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles
                 WHERE rolname='bizportal_marketplace_finance_login_dev'
                   AND rolcanlogin AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'PR50_FINANCE_ROLE_NOT_READY';
  END IF;
END $$;

GRANT INSERT (
  invoice_number, vendor_invoice_ref, company_id, supplier_id, supplier_name,
  mkt_purchase_order_id, mkt_goods_receipt_id, status, invoice_date, currency,
  total_amount, tax_amount, grand_total, three_way_match_status, notes,
  attachment_object_path, attachment_file_name, attachment_content_type,
  attachment_size, created_by
) ON public.vendor_invoices TO bizportal_marketplace_finance_login_dev;

GRANT INSERT (
  invoice_id, mkt_purchase_order_line_id, name, quantity, unit, unit_cost,
  subtotal, tax_amount, notes
) ON public.vendor_invoice_lines TO bizportal_marketplace_finance_login_dev;

GRANT USAGE ON SEQUENCE public.vendor_invoices_id_seq,
  public.vendor_invoice_lines_id_seq
TO bizportal_marketplace_finance_login_dev;

CREATE POLICY pr50_finance_dev_vendor_invoice_insert ON public.vendor_invoices
  FOR INSERT TO bizportal_marketplace_finance_login_dev
  WITH CHECK (
    company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer
    AND mkt_purchase_order_id IS NOT NULL
    AND mkt_goods_receipt_id IS NOT NULL
    AND supplier_id IS NOT NULL
    AND status = 'draft'
    AND three_way_match_status = 'unmatched'
    AND journal_entry_id IS NULL
    AND EXISTS (
      SELECT 1 FROM public.mkt_purchase_orders po
      JOIN public.mkt_po_shipments sh ON sh.po_id = po.id
      JOIN public.mkt_po_goods_receipts gr ON gr.shipment_id = sh.id
      WHERE po.id = mkt_purchase_order_id
        AND gr.id = mkt_goods_receipt_id
        AND po.vendor_id = supplier_id
        AND po.company_id = company_id
        AND po.company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer
        AND sh.shipment_status = 'delivered'
        AND gr.inspection_status = 'passed'
    )
  );

CREATE POLICY pr50_finance_dev_vendor_invoice_lines_insert ON public.vendor_invoice_lines
  FOR INSERT TO bizportal_marketplace_finance_login_dev
  WITH CHECK (
    invoice_id IS NOT NULL AND mkt_purchase_order_line_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.vendor_invoices vi
      JOIN public.mkt_purchase_order_lines pol
        ON pol.po_id = vi.mkt_purchase_order_id
      WHERE vi.id = invoice_id
        AND pol.id = mkt_purchase_order_line_id
        AND vi.company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer
        AND vi.mkt_purchase_order_id IS NOT NULL
        AND vi.status = 'draft'
    )
  );
