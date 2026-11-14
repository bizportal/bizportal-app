-- PR #50 CST-DEV Finance AP/Accounting RLS rehearsal.
-- Synthetically creates RFQ to delivery under BEGIN/ROLLBACK.
-- Assumes supplier #9 and company #1 exist, and fixture IDs are unused.
-- Fully rollback; explicit IDs prevent sequence increments. No GL posting.
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


-- Test fixture: canonical 3-way matched invoice, set up by test admin only.
INSERT INTO public.vendor_invoices(
 id,invoice_number,vendor_invoice_ref,company_id,supplier_id,supplier_name,
 mkt_purchase_order_id,mkt_goods_receipt_id,status,invoice_date,currency,
 total_amount,tax_amount,grand_total,three_way_match_status
) VALUES (
 990015001,'PR50-ROLLBACK-MATCHED-VI-20261115','PR50-ROLLBACK-MATCHED-REF',
 1,9,'PR50 synthetic vendor',990015001,990015001,'ready_for_ap',now(),
 'IDR',100,0,100,'passed'
);
INSERT INTO public.vendor_invoice_lines(
 id,invoice_id,mkt_purchase_order_line_id,name,quantity,unit,unit_cost,subtotal,tax_amount
) VALUES (990015001,990015001,990015001,'PR50 synthetic match',1,'pcs',100,100,0);

GRANT bizportal_marketplace_finance_login_dev TO postgres WITH SET TRUE;
SET LOCAL ROLE bizportal_marketplace_finance_login_dev;
SET LOCAL app.marketplace_company_id='1';

-- Actual AP draft creation by restricted role, bound to the same company.
INSERT INTO public.mkt_ap_preparations(
 id,preparation_number,vendor_invoice_id,mkt_purchase_order_id,
 mkt_goods_receipt_id,company_id,supplier_id,supplier_name,
 invoice_number_snapshot,vendor_invoice_ref_snapshot,currency_snapshot,
 total_amount_snapshot,tax_amount_snapshot,grand_total_snapshot,status
) VALUES (
 990015001,'PR50-ROLLBACK-AP-20261115',990015001,990015001,
 990015001,1,9,'PR50 synthetic vendor',
 'PR50-ROLLBACK-MATCHED-VI-20261115','PR50-ROLLBACK-MATCHED-REF',
 'IDR',100,0,100,'ap_preparation'
);
UPDATE public.mkt_ap_preparations
 SET status='finance_review',finance_reviewed_by='pr50-synthetic-admin',
     finance_reviewed_at=now(),updated_at=now() WHERE id=990015001;
UPDATE public.mkt_ap_preparations
 SET status='waiting_payment',waiting_payment_at=now(),updated_at=now()
 WHERE id=990015001;

-- PAYMENT must remain draft. Attempt to insert a paid request must be denied.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.payment_requests(
     id,pay_req_number,company_id,supplier_id,supplier_name,status,
     total_amount,paid_amount,currency,source_type,source_id,
     mkt_ap_preparation_id,journal_entry_id
    ) VALUES (
      990015002,'PR50-DENIED-PAID',1,9,'PR50 synthetic vendor','paid',
      100,100,'IDR','marketplace_ap',990015001,990015001,NULL
    );
    RAISE EXCEPTION 'PR50_PAID_PAYMENT_WAS_NOT_DENIED';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

INSERT INTO public.payment_requests(
 id,pay_req_number,company_id,supplier_id,supplier_name,status,
 total_amount,paid_amount,currency,source_type,source_id,
 mkt_ap_preparation_id,journal_entry_id,idempotency_key,
 payload_fingerprint,mkt_lifecycle_status
) VALUES (
 990015001,'PR50-ROLLBACK-PAYREQ-20261115',1,9,'PR50 synthetic vendor',
 'draft',100,0,'IDR','marketplace_ap',990015001,990015001,
 NULL,'pr50-rollback-ap:990015001','pr50-synthetic-fingerprint','waiting_payment'
);

INSERT INTO public.mkt_accounting_handoffs(
 id,handoff_key,correlation_reference,payload_fingerprint,
 ap_preparation_id,vendor_invoice_id,mkt_purchase_order_id,mkt_goods_receipt_id,
 payment_request_id,company_id,supplier_id,currency,amount,
 approval_state,payment_lifecycle_state,status,accounting_status,payload
) VALUES (
 990015001,'pr50-rollback-handoff:990015001','PR50-ROLLBACK-CORR',
 'pr50-synthetic-fingerprint',990015001,990015001,990015001,990015001,
 990015001,1,9,'IDR',100,'finance_review','waiting_payment',
 'accepted','draft_not_posted','{"synthetic":true}'::jsonb
);
UPDATE public.mkt_ap_preparations
  SET payment_request_id=990015001,payment_handoff_at=now(),
      payment_handoff_by='pr50-synthetic-admin',updated_at=now()
WHERE id=990015001;

DO $$
BEGIN
 IF (SELECT count(*) FROM public.mkt_ap_preparations
     WHERE id=990015001 AND status='waiting_payment') <> 1
 OR (SELECT count(*) FROM public.payment_requests
     WHERE id=990015001 AND status='draft' AND journal_entry_id IS NULL) <> 1
 OR (SELECT count(*) FROM public.mkt_accounting_handoffs
     WHERE id=990015001 AND accounting_status='draft_not_posted') <> 1
 THEN RAISE EXCEPTION 'PR50_DRAFT_HANDOFF_INCOMPLETE'; END IF;
END $$;

-- The same objects must vanish from the wrong company's RLS perspective.
SET LOCAL app.marketplace_company_id='3';
DO $$
BEGIN
 IF (SELECT count(*) FROM public.mkt_ap_preparations WHERE id=990015001) <> 0
 OR (SELECT count(*) FROM public.payment_requests WHERE id=990015001) <> 0
 OR (SELECT count(*) FROM public.mkt_accounting_handoffs WHERE id=990015001) <> 0
 THEN RAISE EXCEPTION 'PR50_CROSS_TENANT_AP_OR_HANDOFF_LEAK'; END IF;
END $$;

SET LOCAL app.marketplace_company_id='1';
SELECT current_user::text as effective_role,
 row_security_active('public.mkt_ap_preparations'::regclass) as ap_rls,
 (SELECT count(*)::int FROM public.mkt_ap_preparations WHERE id=990015001) as ap_count,
 (SELECT count(*)::int FROM public.payment_requests WHERE id=990015001 AND status='draft') as draft_payment_count,
 (SELECT count(*)::int FROM public.mkt_accounting_handoffs WHERE id=990015001 AND accounting_status='draft_not_posted') as handoff_draft_count,
 (SELECT count(*)::int FROM public.payment_requests WHERE id=990015002) as disallowed_paid_rows,
 has_table_privilege(current_user,'public.accounting_entries','INSERT') as can_post_gl;
ROLLBACK;
