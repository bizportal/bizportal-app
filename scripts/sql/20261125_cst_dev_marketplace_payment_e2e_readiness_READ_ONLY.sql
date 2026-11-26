-- CST-DEV only (xssrfshdrtdfupgqwfdw): no INSERT/UPDATE/DELETE/DDL.
-- Use as the authoritative read-only readiness probe before any financial E2E.
-- Zero eligible invoices is NOT a test failure: it identifies the missing
-- prerequisite. Do not fabricate vendor invoices to force PASS.
with base as (
 select
   (select count(*) from public.mkt_purchase_orders po where po.company_id=1) po_count,
   (select count(*) from public.mkt_po_shipments sh
      join public.mkt_purchase_orders po on po.id=sh.po_id
      where po.company_id=1 and sh.shipment_status='delivered') delivered_shipments,
   (select count(*) from public.mkt_po_goods_receipts gr
      join public.mkt_po_shipments sh on sh.id=gr.shipment_id
      join public.mkt_purchase_orders po on po.id=sh.po_id
      where po.company_id=1 and sh.shipment_status='delivered'
        and gr.inspection_status='passed') accepted_receipts,
   (select count(*) from public.vendor_invoices vi where vi.company_id=1) invoices,
   (select count(*) from public.vendor_invoices vi
      where vi.company_id=1 and vi.mkt_purchase_order_id is not null
        and vi.mkt_goods_receipt_id is not null) po_gr_linked_invoices,
   (select count(*) from public.vendor_invoices vi
      join public.mkt_purchase_orders po on po.id=vi.mkt_purchase_order_id
      join public.mkt_po_goods_receipts gr on gr.id=vi.mkt_goods_receipt_id
      join public.mkt_po_shipments sh on sh.id=gr.shipment_id
      where vi.company_id=1 and po.company_id=1 and sh.po_id=po.id
        and sh.shipment_status='delivered' and gr.inspection_status='passed'
        and vi.status='ready_for_ap' and vi.three_way_match_status='passed') eligible_invoices,
   (select count(*) from public.mkt_ap_preparations ap where ap.company_id=1) ap_preparations,
   (select count(*) from public.payment_requests pr where pr.company_id=1
      and pr.source_type='marketplace_ap') marketplace_payment_requests,
   (select count(*) from public.mkt_accounting_handoffs h where h.company_id=1) handoffs,
   (select count(*) from public.mkt_payment_approval_audit_dev a where a.company_id=1) approvals,
   (select count(*) from public.bank_mutations b where b.company_id=1
      and b.direction='OUT' and b.status='posted'
      and b.accounting_posted=true and b.reconciliation_status='reconciled'
      and b.journal_entry_id is not null
      and (b.import_batch_id is not null or b.import_row_id is not null)) eligible_posted_bank_rows
)
select *,case
 when eligible_invoices=0 then 'BLOCKED_NO_CANONICAL_MATCHED_VENDOR_INVOICE'
 when ap_preparations=0 then 'BLOCKED_NO_AP_PREPARATION'
 when marketplace_payment_requests=0 then 'BLOCKED_NO_PAYMENT_REQUEST'
 when approvals=0 then 'BLOCKED_NO_SIGNED_APPROVAL'
 when eligible_posted_bank_rows=0 then 'BLOCKED_NO_CANONICAL_POSTED_BANK_EVIDENCE'
 else 'PREFLIGHT_CANDIDATE_ONLY_NOT_E2E_PASS'
 end readiness from base;
