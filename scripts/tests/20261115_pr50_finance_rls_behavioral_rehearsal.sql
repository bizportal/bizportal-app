-- PR #50 / CST-DEV ONLY — RLS behavioral rehearsal.
-- Every business fixture uses explicit high IDs, remains inside a transaction,
-- and is removed by ROLLBACK. No sequences, emails, journals, uploads or webhooks.
-- Requires existing (unchanged) synthetic FKs: supplier #9 and company #1.
-- Run only after verifying these fixture IDs are unused in CST-DEV.
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

-- One-time test-only role membership and ID-column grants; both rolled back.
GRANT bizportal_marketplace_finance_login_dev TO postgres WITH SET TRUE;
GRANT INSERT (id) ON public.vendor_invoices
  TO bizportal_marketplace_finance_login_dev;
GRANT INSERT (id) ON public.vendor_invoice_lines
  TO bizportal_marketplace_finance_login_dev;
SET LOCAL ROLE bizportal_marketplace_finance_login_dev;
SET LOCAL app.marketplace_company_id='1';

DO $$
DECLARE po_count integer; receipt_count integer;
BEGIN
  SELECT count(*) INTO po_count FROM public.mkt_purchase_orders
   WHERE id=990015001;
  SELECT count(*) INTO receipt_count FROM public.mkt_po_goods_receipts
   WHERE id=990015001;
  IF po_count <> 1 OR receipt_count <> 1 OR
     NOT row_security_active('public.vendor_invoices'::regclass) THEN
    RAISE EXCEPTION 'PR50_COMPANY1_READ_OR_RLS_FAILED';
  END IF;
END $$;

-- An actual RLS-positive INSERT by the restricted role.
INSERT INTO public.vendor_invoices(
  id,invoice_number,vendor_invoice_ref,company_id,supplier_id,supplier_name,
  mkt_purchase_order_id,mkt_goods_receipt_id,status,invoice_date,currency,
  total_amount,tax_amount,grand_total,three_way_match_status
) VALUES (
  990015001,'PR50-ROLLBACK-VI-20261115',
  'PR50-ROLLBACK-SUPPLIER-REF-20261115',
  1,9,'PR50 synthetic vendor',990015001,990015001,'draft',
  now(),'IDR',100,0,100,'unmatched'
);
INSERT INTO public.vendor_invoice_lines(
  id,invoice_id,mkt_purchase_order_line_id,name,quantity,unit,
  unit_cost,subtotal,tax_amount
) VALUES (990015001,990015001,990015001,'PR50 synthetic test item',1,
          'pcs',100,100,0);
DO $$
BEGIN
  IF (SELECT count(*) FROM public.vendor_invoices WHERE id=990015001) <> 1
    OR (SELECT count(*) FROM public.vendor_invoice_lines WHERE id=990015001) <> 1
  THEN RAISE EXCEPTION 'PR50_COMPANY1_INSERT_NOT_VISIBLE'; END IF;
END $$;

SET LOCAL app.marketplace_company_id='3';
DO $$
BEGIN
  IF (SELECT count(*) FROM public.mkt_purchase_orders WHERE id=990015001) <> 0
    OR (SELECT count(*) FROM public.vendor_invoices WHERE id=990015001) <> 0
    OR (SELECT count(*) FROM public.vendor_invoice_lines WHERE id=990015001) <> 0
  THEN RAISE EXCEPTION 'PR50_CROSS_COMPANY_READ_LEAK'; END IF;
END $$;

-- Cross-company WRITE attempt must fail the database policy with SQLSTATE 42501.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.vendor_invoices(
      id,invoice_number,vendor_invoice_ref,company_id,supplier_id,supplier_name,
      mkt_purchase_order_id,mkt_goods_receipt_id,status,invoice_date,currency,
      total_amount,tax_amount,grand_total,three_way_match_status
    ) VALUES (
      990015002,'PR50-DENIED-CROSS-COMPANY',
      'PR50-DENIED-CROSS-COMPANY-REF',1,9,'PR50 synthetic vendor',
      990015001,990015001,'draft',now(),'IDR',100,0,100,'unmatched'
    );
    RAISE EXCEPTION 'PR50_CROSS_COMPANY_WRITE_WAS_NOT_DENIED';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

SET LOCAL app.marketplace_company_id='1';
-- An invoice cannot be inserted directly into ready_for_ap, regardless of role.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.vendor_invoices(
      id,invoice_number,vendor_invoice_ref,company_id,supplier_id,supplier_name,
      mkt_purchase_order_id,mkt_goods_receipt_id,status,invoice_date,currency,
      total_amount,tax_amount,grand_total,three_way_match_status
    ) VALUES (
      990015002,'PR50-DENIED-NONDRAFT',
      'PR50-DENIED-NONDRAFT-REF',1,9,'PR50 synthetic vendor',
      990015001,990015001,'ready_for_ap',now(),'IDR',100,0,100,'passed'
    );
    RAISE EXCEPTION 'PR50_NON_DRAFT_WRITE_WAS_NOT_DENIED';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

SELECT current_user::text AS effective_role,
 row_security_active('public.vendor_invoices'::regclass) AS invoice_rls,
 (SELECT count(*)::int FROM public.mkt_purchase_orders WHERE id=990015001) AS visible_po,
 (SELECT count(*)::int FROM public.vendor_invoices WHERE id=990015001) AS inserted_invoice,
 (SELECT count(*)::int FROM public.vendor_invoice_lines WHERE id=990015001) AS inserted_line,
 has_table_privilege(current_user,'public.accounting_entries','INSERT') AS can_post_gl;
ROLLBACK;
