-- PR #50 CST-DEV ONLY. Two-company reciprocal positive and negative RLS test.
-- Must be submitted in full, atomic BEGIN-to-ROLLBACK. No business rows persist.
BEGIN;
SET LOCAL lock_timeout='1500ms';
SET LOCAL statement_timeout='18000ms';
-- Strict preflight: fail closed unless the CST-DEV Finance sandbox is
-- present and the fixed synthetic IDs are all free. Never run on PROD.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='bizportal_marketplace_finance_login_dev'
                 AND rolbypassrls IS FALSE)
     OR (SELECT count(*) FROM pg_policies
         WHERE schemaname='public' AND policyname LIKE 'pr50_finance_dev_%') <> 18
     OR NOT EXISTS (SELECT 1 FROM public.companies WHERE id=1)
     OR NOT EXISTS (SELECT 1 FROM public.suppliers WHERE id=9)
     OR EXISTS (SELECT 1 FROM public.mkt_rfqs WHERE id=990015001)
     OR EXISTS (SELECT 1 FROM public.mkt_vendor_quotes WHERE id=990015001)
     OR EXISTS (SELECT 1 FROM public.mkt_purchase_orders WHERE id=990015001)
     OR EXISTS (SELECT 1 FROM public.mkt_ap_preparations WHERE id=990015001)
     OR EXISTS (SELECT 1 FROM public.vendor_invoices WHERE id IN (990015001,990015002))
     OR EXISTS (SELECT 1 FROM public.payment_requests WHERE id IN (990015001,990015002))
     OR EXISTS (SELECT 1 FROM public.mkt_accounting_handoffs WHERE id=990015001)
  THEN RAISE EXCEPTION 'PR50_FINANCE_RLS_TEST_PRECONDITION_FAILED'; END IF;
END $$;


INSERT INTO public.mkt_rfqs(id,rfq_number,buyer_name,buyer_email,company_id,status)
VALUES (990015001,'PR50-ROLLBACK-RFQ-20261115','PR50 synthetic buyer',
        'pr50-test@example.invalid',1,'awarded');
INSERT INTO public.mkt_vendor_quotes(id,rfq_id,vendor_id,token,status)
VALUES (990015001,990015001,9,'pr50-rollback-quote-token-20261115','selected');
INSERT INTO public.mkt_purchase_orders(
  id,po_number,rfq_id,quote_id,company_id,vendor_id,status,
  total_amount,tax_amount,grand_total,currency_snapshot
) VALUES (
  990015001,'PR50-ROLLBACK-PO-20261115',990015001,990015001,1,9,
  'confirmed',100,0,100,'IDR'
);
INSERT INTO public.mkt_purchase_order_lines(id,po_id,item_name,qty,unit_price,subtotal,unit)
VALUES (990015001,990015001,'PR50 synthetic test item',1,100,100,'pcs');
INSERT INTO public.mkt_po_shipments(id,po_id,shipment_number,shipment_status)
VALUES (990015001,990015001,'PR50-ROLLBACK-SHIP-20261115','delivered');
INSERT INTO public.mkt_po_shipment_items(id,shipment_id,po_line_id,line_number,qty)
VALUES (990015001,990015001,990015001,1,1);
INSERT INTO public.mkt_po_goods_receipts(
  id,shipment_id,receipt_number,receipt_type,inspection_status
) VALUES (990015001,990015001,'PR50-ROLLBACK-GR-20261115','full','passed');
INSERT INTO public.mkt_po_goods_receipt_items(
  id,goods_receipt_id,shipment_item_id,received_qty,accepted_qty
) VALUES (990015001,990015001,990015001,1,1);


-- Second tenant: company 3, supplier 35, entirely synthetic records.
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id=3 AND is_active)
 OR NOT EXISTS (SELECT 1 FROM public.suppliers WHERE id=35 AND company_id=3)
 OR EXISTS (SELECT 1 FROM public.mkt_rfqs WHERE id=990015003)
 OR EXISTS (SELECT 1 FROM public.mkt_vendor_quotes WHERE id=990015003)
 OR EXISTS (SELECT 1 FROM public.mkt_purchase_orders WHERE id=990015003)
 OR EXISTS (SELECT 1 FROM public.vendor_invoices WHERE id=990015003)
 THEN RAISE EXCEPTION 'PR50_C3_FIXTURE_PRECONDITION_FAILED'; END IF;
END $$;
INSERT INTO public.mkt_rfqs(id,rfq_number,buyer_name,buyer_email,company_id,status)
VALUES (990015003,'PR50-ROLLBACK-RFQ-C3','PR50 synthetic buyer c3','pr50-c3@example.invalid',3,'awarded');
INSERT INTO public.mkt_vendor_quotes(id,rfq_id,vendor_id,token,status)
VALUES (990015003,990015003,35,'pr50-rollback-quote-token-c3','selected');
INSERT INTO public.mkt_purchase_orders(
 id,po_number,rfq_id,quote_id,company_id,vendor_id,status,total_amount,tax_amount,grand_total,currency_snapshot
) VALUES (
 990015003,'PR50-ROLLBACK-PO-C3',990015003,990015003,3,35,'confirmed',200,0,200,'IDR'
);
INSERT INTO public.mkt_purchase_order_lines(id,po_id,item_name,qty,unit_price,subtotal,unit)
VALUES (990015003,990015003,'PR50 synthetic c3 item',1,200,200,'pcs');
INSERT INTO public.mkt_po_shipments(id,po_id,shipment_number,shipment_status)
VALUES (990015003,990015003,'PR50-ROLLBACK-SHIP-C3','delivered');
INSERT INTO public.mkt_po_shipment_items(id,shipment_id,po_line_id,line_number,qty)
VALUES (990015003,990015003,990015003,1,1);
INSERT INTO public.mkt_po_goods_receipts(id,shipment_id,receipt_number,receipt_type,inspection_status)
VALUES (990015003,990015003,'PR50-ROLLBACK-GR-C3','full','passed');
INSERT INTO public.mkt_po_goods_receipt_items(id,goods_receipt_id,shipment_item_id,received_qty,accepted_qty)
VALUES (990015003,990015003,990015003,1,1);

GRANT bizportal_marketplace_finance_login_dev TO postgres WITH SET TRUE;
GRANT INSERT (id) ON public.vendor_invoices
 TO bizportal_marketplace_finance_login_dev;
SET LOCAL ROLE bizportal_marketplace_finance_login_dev;

SET LOCAL app.marketplace_company_id='1';
INSERT INTO public.vendor_invoices(
 id,invoice_number,vendor_invoice_ref,company_id,supplier_id,supplier_name,
 mkt_purchase_order_id,mkt_goods_receipt_id,status,invoice_date,currency,
 total_amount,tax_amount,grand_total,three_way_match_status
) VALUES (
 990015001,'PR50-ROLLBACK-C1-INV','PR50-ROLLBACK-C1-REF',1,9,'PR50 synthetic C1',
 990015001,990015001,'draft',now(),'IDR',100,0,100,'unmatched'
);
DO $$
BEGIN
 IF (SELECT count(*) FROM public.vendor_invoices WHERE id=990015001)<>1
 OR (SELECT count(*) FROM public.vendor_invoices WHERE id=990015003)<>0
 THEN RAISE EXCEPTION 'PR50_C1_SCOPE_FAILED'; END IF;
END $$;

SET LOCAL app.marketplace_company_id='3';
INSERT INTO public.vendor_invoices(
 id,invoice_number,vendor_invoice_ref,company_id,supplier_id,supplier_name,
 mkt_purchase_order_id,mkt_goods_receipt_id,status,invoice_date,currency,
 total_amount,tax_amount,grand_total,three_way_match_status
) VALUES (
 990015003,'PR50-ROLLBACK-C3-INV','PR50-ROLLBACK-C3-REF',3,35,'PR50 synthetic C3',
 990015003,990015003,'draft',now(),'IDR',200,0,200,'unmatched'
);
DO $$
BEGIN
 IF (SELECT count(*) FROM public.vendor_invoices WHERE id=990015003)<>1
 OR (SELECT count(*) FROM public.vendor_invoices WHERE id=990015001)<>0
 OR (SELECT count(*) FROM public.mkt_purchase_orders WHERE id=990015003)<>1
 OR (SELECT count(*) FROM public.mkt_purchase_orders WHERE id=990015001)<>0
 THEN RAISE EXCEPTION 'PR50_C3_SCOPE_FAILED'; END IF;
END $$;

SET LOCAL app.marketplace_company_id='1';
DO $$
BEGIN
 IF (SELECT count(*) FROM public.vendor_invoices WHERE id=990015001)<>1
 OR (SELECT count(*) FROM public.vendor_invoices WHERE id=990015003)<>0
 OR (SELECT count(*) FROM public.mkt_purchase_orders WHERE id=990015001)<>1
 OR (SELECT count(*) FROM public.mkt_purchase_orders WHERE id=990015003)<>0
 THEN RAISE EXCEPTION 'PR50_RECIPROCAL_TENANT_LEAK'; END IF;
END $$;
SELECT current_user AS role_in_use,
 (SELECT count(*)::int FROM public.vendor_invoices WHERE id=990015001) AS visible_own_invoice,
 (SELECT count(*)::int FROM public.vendor_invoices WHERE id=990015003) AS hidden_other_invoice,
 (SELECT count(*)::int FROM public.mkt_purchase_orders WHERE id=990015001) AS visible_own_po,
 (SELECT count(*)::int FROM public.mkt_purchase_orders WHERE id=990015003) AS hidden_other_po,
 row_security_active('public.vendor_invoices'::regclass) AS invoice_rls;
ROLLBACK;
