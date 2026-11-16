-- PR107 SYNTHETIC fixture: intentionally weaker permissive original RLS
-- to prove the new restrictive role guard cannot be bypassed. It is NOT
-- a real CST-DEV data clone. pg_catalog action names mirror live metadata.
CREATE ROLE bizportal_marketplace_finance_login_dev LOGIN NOINHERIT NOBYPASSRLS;
CREATE TABLE public.mkt_purchase_orders (
  id integer PRIMARY KEY,
  company_id integer,
  vendor_id integer,
  status text,
  vendor_token text,
  vendor_token_expires_at timestamp
);
CREATE TABLE public.mkt_purchase_order_lines (
  id integer PRIMARY KEY,
  po_id integer
);
CREATE TABLE public.mkt_po_shipments (
  id integer PRIMARY KEY,
  po_id integer,
  shipment_status text
);
CREATE TABLE public.mkt_po_shipment_items (
  id integer PRIMARY KEY,
  shipment_id integer
);
CREATE TABLE public.mkt_po_goods_receipts (
  id integer PRIMARY KEY,
  shipment_id integer,
  inspection_status text
);
CREATE TABLE public.mkt_po_goods_receipt_items (
  id integer PRIMARY KEY,
  goods_receipt_id integer
);
CREATE TABLE public.vendor_invoices (
  id serial PRIMARY KEY,
  company_id integer,
  mkt_purchase_order_id integer,
  invoice_number text,
  vendor_invoice_ref text,
  supplier_id integer,
  supplier_name text,
  status text,
  invoice_date text,
  total_amount text,
  tax_amount text,
  grand_total text,
  three_way_match_status text,
  notes text,
  created_by text,
  mkt_goods_receipt_id integer,
  currency text,
  attachment_object_path text,
  attachment_file_name text,
  attachment_content_type text,
  attachment_size text,
  match_notes text,
  updated_at text
);
CREATE TABLE public.vendor_invoice_lines (
  id serial PRIMARY KEY,
  invoice_id integer,
  name text,
  quantity text,
  unit text,
  unit_cost text,
  subtotal text,
  tax_amount text,
  notes text,
  mkt_purchase_order_line_id integer
);
CREATE TABLE public.mkt_ap_preparations (
  id serial PRIMARY KEY,
  company_id integer,
  preparation_number text,
  status text,
  finance_reviewed_by text,
  finance_reviewed_at text,
  waiting_payment_at text,
  updated_at text,
  payment_request_id integer,
  payment_handoff_at text,
  payment_handoff_by text
);
CREATE TABLE public.payment_requests (
  id serial PRIMARY KEY,
  company_id integer
);
CREATE TABLE public.mkt_accounting_handoffs (
  id serial PRIMARY KEY,
  company_id integer
);
ALTER TABLE public.mkt_purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_purchase_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_po_shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_po_shipment_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_po_goods_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_po_goods_receipt_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_ap_preparations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_accounting_handoffs ENABLE ROW LEVEL SECURITY;
-- Sequence created by serial: mkt_accounting_handoffs_id_seq
-- Sequence created by serial: mkt_ap_preparations_id_seq
-- Sequence created by serial: payment_requests_id_seq
-- Sequence created by serial: vendor_invoice_lines_id_seq
-- Sequence created by serial: vendor_invoices_id_seq
INSERT INTO public.mkt_purchase_orders (id,company_id,vendor_id,status,vendor_token) VALUES (11,1,10,'confirmed','ci-cst'),(31,3,35,'confirmed','ci-diva');
INSERT INTO public.mkt_purchase_order_lines (id,po_id) VALUES (21,11),(41,31);
INSERT INTO public.mkt_po_shipments (id,po_id,shipment_status) VALUES (12,11,'delivered'),(32,31,'delivered');
INSERT INTO public.mkt_po_shipment_items (id,shipment_id) VALUES (22,12),(42,32);
INSERT INTO public.mkt_po_goods_receipts (id,shipment_id,inspection_status) VALUES (13,12,'passed'),(33,32,'passed');
INSERT INTO public.mkt_po_goods_receipt_items (id,goods_receipt_id) VALUES (23,13),(43,33);
INSERT INTO public.vendor_invoices (id,company_id,mkt_purchase_order_id,vendor_invoice_ref) VALUES (14,1,11,'ci-cst'),(34,3,31,'ci-diva');
INSERT INTO public.vendor_invoice_lines (id,invoice_id) VALUES (15,14),(35,34);
INSERT INTO public.mkt_ap_preparations (id,company_id,status) VALUES (16,1,'draft'),(36,3,'draft');
INSERT INTO public.payment_requests (id,company_id) VALUES (17,1),(37,3);
INSERT INTO public.mkt_accounting_handoffs (id,company_id) VALUES (18,1),(38,3);
GRANT USAGE ON SCHEMA public TO bizportal_marketplace_finance_login_dev;
GRANT SELECT ON public.mkt_purchase_orders,public.mkt_purchase_order_lines,public.mkt_po_shipments,public.mkt_po_shipment_items,public.mkt_po_goods_receipts,public.mkt_po_goods_receipt_items,public.vendor_invoices,public.vendor_invoice_lines,public.mkt_ap_preparations,public.payment_requests,public.mkt_accounting_handoffs TO bizportal_marketplace_finance_login_dev;
GRANT INSERT ON public.mkt_ap_preparations,public.payment_requests,public.mkt_accounting_handoffs TO bizportal_marketplace_finance_login_dev;
GRANT INSERT (invoice_number,vendor_invoice_ref,company_id,supplier_id,supplier_name,status,invoice_date,total_amount,tax_amount,grand_total,three_way_match_status,notes,created_by,mkt_purchase_order_id,mkt_goods_receipt_id,currency,attachment_object_path,attachment_file_name,attachment_content_type,attachment_size) ON public.vendor_invoices TO bizportal_marketplace_finance_login_dev;
GRANT INSERT (invoice_id,name,quantity,unit,unit_cost,subtotal,tax_amount,notes,mkt_purchase_order_line_id) ON public.vendor_invoice_lines TO bizportal_marketplace_finance_login_dev;
GRANT UPDATE (preparation_number,status,finance_reviewed_by,finance_reviewed_at,waiting_payment_at,updated_at,payment_request_id,payment_handoff_at,payment_handoff_by) ON public.mkt_ap_preparations TO bizportal_marketplace_finance_login_dev;
GRANT UPDATE (status,three_way_match_status,match_notes,updated_at) ON public.vendor_invoices TO bizportal_marketplace_finance_login_dev;
GRANT USAGE ON SEQUENCE public.mkt_accounting_handoffs_id_seq,public.mkt_ap_preparations_id_seq,public.payment_requests_id_seq,public.vendor_invoice_lines_id_seq,public.vendor_invoices_id_seq TO bizportal_marketplace_finance_login_dev;
CREATE POLICY pr50_finance_dev_handoff_insert ON public.mkt_accounting_handoffs FOR INSERT TO bizportal_marketplace_finance_login_dev WITH CHECK (true);
CREATE POLICY pr50_finance_dev_handoff_read ON public.mkt_accounting_handoffs FOR SELECT TO bizportal_marketplace_finance_login_dev USING (true);
CREATE POLICY pr50_finance_dev_ap_insert ON public.mkt_ap_preparations FOR INSERT TO bizportal_marketplace_finance_login_dev WITH CHECK (true);
CREATE POLICY pr50_finance_dev_ap_read ON public.mkt_ap_preparations FOR SELECT TO bizportal_marketplace_finance_login_dev USING (true);
CREATE POLICY pr50_finance_dev_ap_update ON public.mkt_ap_preparations FOR UPDATE TO bizportal_marketplace_finance_login_dev USING (true) WITH CHECK (true);
CREATE POLICY pr50_finance_dev_receipt_items_read ON public.mkt_po_goods_receipt_items FOR SELECT TO bizportal_marketplace_finance_login_dev USING (true);
CREATE POLICY pr50_finance_dev_receipts_read ON public.mkt_po_goods_receipts FOR SELECT TO bizportal_marketplace_finance_login_dev USING (true);
CREATE POLICY pr50_finance_dev_shipment_items_read ON public.mkt_po_shipment_items FOR SELECT TO bizportal_marketplace_finance_login_dev USING (true);
CREATE POLICY pr50_finance_dev_shipments_read ON public.mkt_po_shipments FOR SELECT TO bizportal_marketplace_finance_login_dev USING (true);
CREATE POLICY pr50_finance_dev_po_lines_read ON public.mkt_purchase_order_lines FOR SELECT TO bizportal_marketplace_finance_login_dev USING (true);
CREATE POLICY pr50_finance_dev_po_read ON public.mkt_purchase_orders FOR SELECT TO bizportal_marketplace_finance_login_dev USING (true);
CREATE POLICY pr50_finance_dev_payment_insert ON public.payment_requests FOR INSERT TO bizportal_marketplace_finance_login_dev WITH CHECK (true);
CREATE POLICY pr50_finance_dev_payment_read ON public.payment_requests FOR SELECT TO bizportal_marketplace_finance_login_dev USING (true);
CREATE POLICY pr50_finance_dev_vendor_invoice_lines_insert ON public.vendor_invoice_lines FOR INSERT TO bizportal_marketplace_finance_login_dev WITH CHECK (true);
CREATE POLICY pr50_finance_dev_invoice_lines_read ON public.vendor_invoice_lines FOR SELECT TO bizportal_marketplace_finance_login_dev USING (true);
CREATE POLICY pr50_finance_dev_vendor_invoice_insert ON public.vendor_invoices FOR INSERT TO bizportal_marketplace_finance_login_dev WITH CHECK (true);
CREATE POLICY pr50_finance_dev_invoice_read ON public.vendor_invoices FOR SELECT TO bizportal_marketplace_finance_login_dev USING (true);
CREATE POLICY pr50_finance_dev_invoice_update ON public.vendor_invoices FOR UPDATE TO bizportal_marketplace_finance_login_dev USING (true) WITH CHECK (true);
