-- CST-DEV Phase 1: reviewed NOLOGIN roles only. NO passwords/LOGIN/parent UPDATE.
-- Separate migration; original PR107/108 REVIEW_ONLY scripts remain guarded.
-- Policy expressions are preserved exactly; generic Finance role still operates as before.
BEGIN;
SET LOCAL lock_timeout='800ms';
SET LOCAL statement_timeout='25000ms';
DO $preflight$
DECLARE n integer; fp text;
BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres'
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE1_DATABASE_IDENTITY_MISMATCH'; END IF;
 SELECT count(*) INTO n FROM pg_roles
 WHERE rolname IN('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev')
   AND NOT rolcanlogin AND NOT rolinherit AND NOT rolbypassrls AND NOT rolsuper
   AND NOT rolcreaterole AND NOT rolcreatedb AND rolconnlimit=0;
 IF n<>2 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE1_PHASE0_NOT_READY'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
   WHERE r.rolname IN ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev'))
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE1_ROLE_MEMBERSHIP_DRIFT'; END IF;
 IF EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public'
   AND policyname='pr107_company_role_restrictive_all')
 OR to_regnamespace('finance_ops_private') IS NOT NULL
 OR EXISTS(SELECT 1 FROM information_schema.role_table_grants
   WHERE table_schema='public' AND grantee IN ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev'))
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE1_ALREADY_INSTALLED_OR_GRANT_DRIFT'; END IF;
 SELECT count(*),md5(string_agg(tablename||'|'||policyname||'|'||cmd||'|'||
     permissive||'|'||roles::text||'|'||coalesce(qual,'')||'|'||coalesce(with_check,''),
     E'\n' ORDER BY tablename,policyname,cmd))
 INTO n,fp FROM pg_policies
 WHERE schemaname='public' AND policyname LIKE 'pr50_finance_dev_%';
 IF n<>18 OR fp<>'f69295cc7f66f8bc4645a6fc02e2f36e'
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE1_LEGACY_POLICY_CHANGED'; END IF;
END
$preflight$;
GRANT USAGE ON SCHEMA public TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;

-- Copy only the exact previously verified Finance grants, never blanket UPDATE.
GRANT SELECT ON public.mkt_purchase_orders,
  public.mkt_purchase_order_lines,
  public.mkt_po_shipments,
  public.mkt_po_shipment_items,
  public.mkt_po_goods_receipts,
  public.mkt_po_goods_receipt_items,
  public.vendor_invoices,
  public.vendor_invoice_lines,
  public.mkt_ap_preparations,
  public.payment_requests,
  public.mkt_accounting_handoffs TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
GRANT INSERT ON public.mkt_ap_preparations,public.payment_requests,public.mkt_accounting_handoffs TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
GRANT INSERT (invoice_number,vendor_invoice_ref,company_id,supplier_id,supplier_name,status,invoice_date,total_amount,tax_amount,grand_total,three_way_match_status,notes,created_by,mkt_purchase_order_id,mkt_goods_receipt_id,currency,attachment_object_path,attachment_file_name,attachment_content_type,attachment_size) ON public.vendor_invoices TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
GRANT INSERT (invoice_id,name,quantity,unit,unit_cost,subtotal,tax_amount,notes,mkt_purchase_order_line_id) ON public.vendor_invoice_lines TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
GRANT UPDATE (preparation_number,status,finance_reviewed_by,finance_reviewed_at,waiting_payment_at,updated_at,payment_request_id,payment_handoff_at,payment_handoff_by) ON public.mkt_ap_preparations TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
GRANT UPDATE (status,three_way_match_status,match_notes,updated_at) ON public.vendor_invoices TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
GRANT USAGE ON SEQUENCE public.mkt_accounting_handoffs_id_seq,
  public.mkt_ap_preparations_id_seq,
  public.payment_requests_id_seq,
  public.vendor_invoice_lines_id_seq,
  public.vendor_invoices_id_seq TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;

-- The 18 existing permissive policies retain every original USING/WITH CHECK
-- expression; only the "TO" target role list is expanded (safe to rollback).
ALTER POLICY pr50_finance_dev_handoff_insert ON public.mkt_accounting_handoffs TO bizportal_marketplace_finance_login_dev,bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
ALTER POLICY pr50_finance_dev_handoff_read ON public.mkt_accounting_handoffs TO bizportal_marketplace_finance_login_dev,bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
ALTER POLICY pr50_finance_dev_ap_insert ON public.mkt_ap_preparations TO bizportal_marketplace_finance_login_dev,bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
ALTER POLICY pr50_finance_dev_ap_read ON public.mkt_ap_preparations TO bizportal_marketplace_finance_login_dev,bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
ALTER POLICY pr50_finance_dev_ap_update ON public.mkt_ap_preparations TO bizportal_marketplace_finance_login_dev,bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
ALTER POLICY pr50_finance_dev_receipt_items_read ON public.mkt_po_goods_receipt_items TO bizportal_marketplace_finance_login_dev,bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
ALTER POLICY pr50_finance_dev_receipts_read ON public.mkt_po_goods_receipts TO bizportal_marketplace_finance_login_dev,bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
ALTER POLICY pr50_finance_dev_shipment_items_read ON public.mkt_po_shipment_items TO bizportal_marketplace_finance_login_dev,bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
ALTER POLICY pr50_finance_dev_shipments_read ON public.mkt_po_shipments TO bizportal_marketplace_finance_login_dev,bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
ALTER POLICY pr50_finance_dev_po_lines_read ON public.mkt_purchase_order_lines TO bizportal_marketplace_finance_login_dev,bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
ALTER POLICY pr50_finance_dev_po_read ON public.mkt_purchase_orders TO bizportal_marketplace_finance_login_dev,bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
ALTER POLICY pr50_finance_dev_payment_insert ON public.payment_requests TO bizportal_marketplace_finance_login_dev,bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
ALTER POLICY pr50_finance_dev_payment_read ON public.payment_requests TO bizportal_marketplace_finance_login_dev,bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
ALTER POLICY pr50_finance_dev_vendor_invoice_lines_insert ON public.vendor_invoice_lines TO bizportal_marketplace_finance_login_dev,bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
ALTER POLICY pr50_finance_dev_invoice_lines_read ON public.vendor_invoice_lines TO bizportal_marketplace_finance_login_dev,bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
ALTER POLICY pr50_finance_dev_vendor_invoice_insert ON public.vendor_invoices TO bizportal_marketplace_finance_login_dev,bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
ALTER POLICY pr50_finance_dev_invoice_read ON public.vendor_invoices TO bizportal_marketplace_finance_login_dev,bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
ALTER POLICY pr50_finance_dev_invoice_update ON public.vendor_invoices TO bizportal_marketplace_finance_login_dev,bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;

-- An independent company identity can never be forged with an ordinary GUC.
-- PostgreSQL RLS restrictive FOR ALL guards every SELECT/INSERT/UPDATE action.
CREATE POLICY pr107_company_role_restrictive_all ON public.mkt_purchase_orders AS RESTRICTIVE FOR ALL
  TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev
  USING (company_id = (CASE WHEN current_user='bizportal_finance_cst_login_dev' THEN 1 WHEN current_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END))
  WITH CHECK (company_id = (CASE WHEN current_user='bizportal_finance_cst_login_dev' THEN 1 WHEN current_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END));
CREATE POLICY pr107_company_role_restrictive_all ON public.mkt_purchase_order_lines AS RESTRICTIVE FOR ALL
  TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev
  USING (EXISTS (SELECT 1 FROM public.mkt_purchase_orders po WHERE po.id=mkt_purchase_order_lines.po_id AND po.company_id=(CASE WHEN current_user='bizportal_finance_cst_login_dev' THEN 1 WHEN current_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.mkt_purchase_orders po WHERE po.id=mkt_purchase_order_lines.po_id AND po.company_id=(CASE WHEN current_user='bizportal_finance_cst_login_dev' THEN 1 WHEN current_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END)));
CREATE POLICY pr107_company_role_restrictive_all ON public.mkt_po_shipments AS RESTRICTIVE FOR ALL
  TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev
  USING (EXISTS (SELECT 1 FROM public.mkt_purchase_orders po WHERE po.id=mkt_po_shipments.po_id AND po.company_id=(CASE WHEN current_user='bizportal_finance_cst_login_dev' THEN 1 WHEN current_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.mkt_purchase_orders po WHERE po.id=mkt_po_shipments.po_id AND po.company_id=(CASE WHEN current_user='bizportal_finance_cst_login_dev' THEN 1 WHEN current_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END)));
CREATE POLICY pr107_company_role_restrictive_all ON public.mkt_po_shipment_items AS RESTRICTIVE FOR ALL
  TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev
  USING (EXISTS (SELECT 1 FROM public.mkt_po_shipments sh JOIN public.mkt_purchase_orders po ON po.id=sh.po_id WHERE sh.id=mkt_po_shipment_items.shipment_id AND po.company_id=(CASE WHEN current_user='bizportal_finance_cst_login_dev' THEN 1 WHEN current_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.mkt_po_shipments sh JOIN public.mkt_purchase_orders po ON po.id=sh.po_id WHERE sh.id=mkt_po_shipment_items.shipment_id AND po.company_id=(CASE WHEN current_user='bizportal_finance_cst_login_dev' THEN 1 WHEN current_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END)));
CREATE POLICY pr107_company_role_restrictive_all ON public.mkt_po_goods_receipts AS RESTRICTIVE FOR ALL
  TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev
  USING (EXISTS (SELECT 1 FROM public.mkt_po_shipments sh JOIN public.mkt_purchase_orders po ON po.id=sh.po_id WHERE sh.id=mkt_po_goods_receipts.shipment_id AND po.company_id=(CASE WHEN current_user='bizportal_finance_cst_login_dev' THEN 1 WHEN current_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.mkt_po_shipments sh JOIN public.mkt_purchase_orders po ON po.id=sh.po_id WHERE sh.id=mkt_po_goods_receipts.shipment_id AND po.company_id=(CASE WHEN current_user='bizportal_finance_cst_login_dev' THEN 1 WHEN current_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END)));
CREATE POLICY pr107_company_role_restrictive_all ON public.mkt_po_goods_receipt_items AS RESTRICTIVE FOR ALL
  TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev
  USING (EXISTS (SELECT 1 FROM public.mkt_po_goods_receipts gr JOIN public.mkt_po_shipments sh ON sh.id=gr.shipment_id JOIN public.mkt_purchase_orders po ON po.id=sh.po_id WHERE gr.id=mkt_po_goods_receipt_items.goods_receipt_id AND po.company_id=(CASE WHEN current_user='bizportal_finance_cst_login_dev' THEN 1 WHEN current_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.mkt_po_goods_receipts gr JOIN public.mkt_po_shipments sh ON sh.id=gr.shipment_id JOIN public.mkt_purchase_orders po ON po.id=sh.po_id WHERE gr.id=mkt_po_goods_receipt_items.goods_receipt_id AND po.company_id=(CASE WHEN current_user='bizportal_finance_cst_login_dev' THEN 1 WHEN current_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END)));
CREATE POLICY pr107_company_role_restrictive_all ON public.vendor_invoices AS RESTRICTIVE FOR ALL
  TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev
  USING (company_id = (CASE WHEN current_user='bizportal_finance_cst_login_dev' THEN 1 WHEN current_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END))
  WITH CHECK (company_id = (CASE WHEN current_user='bizportal_finance_cst_login_dev' THEN 1 WHEN current_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END));
CREATE POLICY pr107_company_role_restrictive_all ON public.vendor_invoice_lines AS RESTRICTIVE FOR ALL
  TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev
  USING (EXISTS (SELECT 1 FROM public.vendor_invoices vi WHERE vi.id=vendor_invoice_lines.invoice_id AND vi.company_id=(CASE WHEN current_user='bizportal_finance_cst_login_dev' THEN 1 WHEN current_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.vendor_invoices vi WHERE vi.id=vendor_invoice_lines.invoice_id AND vi.company_id=(CASE WHEN current_user='bizportal_finance_cst_login_dev' THEN 1 WHEN current_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END)));
CREATE POLICY pr107_company_role_restrictive_all ON public.mkt_ap_preparations AS RESTRICTIVE FOR ALL
  TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev
  USING (company_id = (CASE WHEN current_user='bizportal_finance_cst_login_dev' THEN 1 WHEN current_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END))
  WITH CHECK (company_id = (CASE WHEN current_user='bizportal_finance_cst_login_dev' THEN 1 WHEN current_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END));
CREATE POLICY pr107_company_role_restrictive_all ON public.payment_requests AS RESTRICTIVE FOR ALL
  TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev
  USING (company_id = (CASE WHEN current_user='bizportal_finance_cst_login_dev' THEN 1 WHEN current_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END))
  WITH CHECK (company_id = (CASE WHEN current_user='bizportal_finance_cst_login_dev' THEN 1 WHEN current_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END));
CREATE POLICY pr107_company_role_restrictive_all ON public.mkt_accounting_handoffs AS RESTRICTIVE FOR ALL
  TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev
  USING (company_id = (CASE WHEN current_user='bizportal_finance_cst_login_dev' THEN 1 WHEN current_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END))
  WITH CHECK (company_id = (CASE WHEN current_user='bizportal_finance_cst_login_dev' THEN 1 WHEN current_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END));

-- Post-flight: 11 role-restrictive guards each, no extra Finance parent UPDATE.
DO $verify$
DECLARE matched integer;
BEGIN
  SELECT count(*) INTO matched FROM pg_catalog.pg_policy p
  JOIN pg_catalog.pg_class c ON c.oid=p.polrelid
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND p.polname='pr107_company_role_restrictive_all'
    AND p.polcmd='*' AND NOT p.polpermissive
    AND (SELECT oid FROM pg_roles WHERE rolname='bizportal_finance_cst_login_dev')=ANY(p.polroles)
    AND (SELECT oid FROM pg_roles WHERE rolname='bizportal_finance_diva_login_dev')=ANY(p.polroles);
  IF matched<>11 THEN RAISE EXCEPTION 'PR107_GUARD_MISSING %',matched; END IF;
  IF has_any_column_privilege('bizportal_finance_cst_login_dev','public.mkt_purchase_orders','UPDATE')
    OR has_any_column_privilege('bizportal_finance_cst_login_dev','public.mkt_po_goods_receipts','UPDATE')
    OR has_any_column_privilege('bizportal_finance_cst_login_dev','public.mkt_po_shipments','UPDATE')
    OR has_any_column_privilege('bizportal_finance_diva_login_dev','public.mkt_purchase_orders','UPDATE')
    OR has_any_column_privilege('bizportal_finance_diva_login_dev','public.mkt_po_goods_receipts','UPDATE')
    OR has_any_column_privilege('bizportal_finance_diva_login_dev','public.mkt_po_shipments','UPDATE')
  THEN RAISE EXCEPTION 'PR107_PARENT_UPDATE_LEAK'; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev')
      AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit))
  THEN RAISE EXCEPTION 'PR107_ROLE_NOT_STAGED_SAFE'; END IF;
END $verify$;
DO $assert_business_unchanged$
DECLARE n integer; fp text;
BEGIN
 SELECT count(*), md5(string_agg(tablename||'|'||policyname||'|'||cmd||'|'||
    coalesce(qual,'')||'|'||coalesce(with_check,''),
    E'\n' ORDER BY tablename,policyname,cmd))
 INTO n,fp FROM pg_policies WHERE schemaname='public'
   AND policyname LIKE 'pr50_finance_dev_%';
 IF n<>18 OR fp<>'5ef6b3e6c9c7a41cd0fb94ebbb243c66'
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE1_BUSINESS_PREDICATE_DRIFT'; END IF;
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public'
    AND policyname LIKE 'pr50_finance_dev_%' AND
    cardinality(roles)=3 AND roles @> ARRAY['bizportal_marketplace_finance_login_dev',
      'bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev']::name[])<>18
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE1_ORIGINAL_ROLE_NOT_PRESERVED'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN
 ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev')
 AND (rolcanlogin OR rolinherit OR rolbypassrls OR rolsuper OR rolcreaterole OR rolcreatedb OR rolconnlimit<>0))
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE1_DORMANT_ROLE_CHANGED'; END IF;
END
$assert_business_unchanged$;
COMMIT;
