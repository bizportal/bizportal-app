-- CST-DEV Phase 1 rollback only. Leaves original Phase 0 NOLOGIN roles intact.
-- Restores original 18 policy targets and revokes exactly PR107 Finance ACL.
-- Do not run after PR108 owner/function stage, after LOGIN or after later grants.
BEGIN;
SET LOCAL lock_timeout='800ms';
SET LOCAL statement_timeout='25000ms';
DO $preflight$
DECLARE n integer;
BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres'
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE1_ROLLBACK_WRONG_ADMIN'; END IF;
 SELECT count(*) INTO n FROM pg_roles WHERE rolname IN
  ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev')
  AND NOT rolcanlogin AND NOT rolinherit AND NOT rolbypassrls AND NOT rolsuper
  AND NOT rolcreaterole AND NOT rolcreatedb AND rolconnlimit=0;
 IF n<>2 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE1_ROLLBACK_ROLE_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
 WHERE r.rolname IN('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev'))
 OR to_regnamespace('finance_ops_private') IS NOT NULL
 OR to_regrole('bizportal_finance_parent_lock_owner_dev') IS NOT NULL
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE1_ROLLBACK_STAGE_ADVANCED'; END IF;
 SELECT count(*) INTO n FROM pg_policies WHERE schemaname='public'
   AND policyname='pr107_company_role_restrictive_all'
   AND permissive='RESTRICTIVE'
   AND roles=ARRAY['bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev']::name[];
 IF n<>11 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE1_ROLLBACK_RLS_DRIFT'; END IF;
 SELECT count(*) INTO n FROM pg_policies WHERE schemaname='public'
   AND policyname LIKE 'pr50_finance_dev_%'
   AND roles=ARRAY['bizportal_marketplace_finance_login_dev',
      'bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev']::name[];
 IF n<>18 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE1_ROLLBACK_TARGET_DRIFT'; END IF;
END
$preflight$;
DROP POLICY pr107_company_role_restrictive_all ON public.mkt_purchase_orders;
DROP POLICY pr107_company_role_restrictive_all ON public.mkt_purchase_order_lines;
DROP POLICY pr107_company_role_restrictive_all ON public.mkt_po_shipments;
DROP POLICY pr107_company_role_restrictive_all ON public.mkt_po_shipment_items;
DROP POLICY pr107_company_role_restrictive_all ON public.mkt_po_goods_receipts;
DROP POLICY pr107_company_role_restrictive_all ON public.mkt_po_goods_receipt_items;
DROP POLICY pr107_company_role_restrictive_all ON public.vendor_invoices;
DROP POLICY pr107_company_role_restrictive_all ON public.vendor_invoice_lines;
DROP POLICY pr107_company_role_restrictive_all ON public.mkt_ap_preparations;
DROP POLICY pr107_company_role_restrictive_all ON public.payment_requests;
DROP POLICY pr107_company_role_restrictive_all ON public.mkt_accounting_handoffs;
-- Restore original exact policy targets; no original expressions changed.
ALTER POLICY pr50_finance_dev_handoff_insert ON public.mkt_accounting_handoffs TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_handoff_read ON public.mkt_accounting_handoffs TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_ap_insert ON public.mkt_ap_preparations TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_ap_read ON public.mkt_ap_preparations TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_ap_update ON public.mkt_ap_preparations TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_receipt_items_read ON public.mkt_po_goods_receipt_items TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_receipts_read ON public.mkt_po_goods_receipts TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_shipment_items_read ON public.mkt_po_shipment_items TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_shipments_read ON public.mkt_po_shipments TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_po_lines_read ON public.mkt_purchase_order_lines TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_po_read ON public.mkt_purchase_orders TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_payment_insert ON public.payment_requests TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_payment_read ON public.payment_requests TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_vendor_invoice_lines_insert ON public.vendor_invoice_lines TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_invoice_lines_read ON public.vendor_invoice_lines TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_vendor_invoice_insert ON public.vendor_invoices TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_invoice_read ON public.vendor_invoices TO bizportal_marketplace_finance_login_dev;
ALTER POLICY pr50_finance_dev_invoice_update ON public.vendor_invoices TO bizportal_marketplace_finance_login_dev;

REVOKE INSERT (invoice_number,vendor_invoice_ref,company_id,supplier_id,supplier_name,status,invoice_date,total_amount,tax_amount,grand_total,three_way_match_status,notes,created_by,mkt_purchase_order_id,mkt_goods_receipt_id,currency,attachment_object_path,attachment_file_name,attachment_content_type,attachment_size) ON public.vendor_invoices FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
REVOKE INSERT (invoice_id,name,quantity,unit,unit_cost,subtotal,tax_amount,notes,mkt_purchase_order_line_id) ON public.vendor_invoice_lines FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
REVOKE UPDATE (preparation_number,status,finance_reviewed_by,finance_reviewed_at,waiting_payment_at,updated_at,payment_request_id,payment_handoff_at,payment_handoff_by) ON public.mkt_ap_preparations FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
REVOKE UPDATE (status,three_way_match_status,match_notes,updated_at) ON public.vendor_invoices FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
REVOKE INSERT ON public.mkt_ap_preparations,public.payment_requests,public.mkt_accounting_handoffs FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
REVOKE SELECT ON public.mkt_purchase_orders,
  public.mkt_purchase_order_lines,
  public.mkt_po_shipments,
  public.mkt_po_shipment_items,
  public.mkt_po_goods_receipts,
  public.mkt_po_goods_receipt_items,
  public.vendor_invoices,
  public.vendor_invoice_lines,
  public.mkt_ap_preparations,
  public.payment_requests,
  public.mkt_accounting_handoffs FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
REVOKE USAGE ON SEQUENCE public.mkt_accounting_handoffs_id_seq,
  public.mkt_ap_preparations_id_seq,
  public.payment_requests_id_seq,
  public.vendor_invoice_lines_id_seq,
  public.vendor_invoices_id_seq FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
REVOKE USAGE ON SCHEMA public FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
DO $postflight$
DECLARE n integer; fp text;
BEGIN
 SELECT count(*),md5(string_agg(tablename||'|'||policyname||'|'||cmd||'|'||
    permissive||'|'||roles::text||'|'||coalesce(qual,'')||'|'||coalesce(with_check,''),
    E'\n' ORDER BY tablename,policyname,cmd)) INTO n,fp
 FROM pg_policies WHERE schemaname='public' AND policyname LIKE 'pr50_finance_dev_%';
 IF n<>18 OR fp<>'f69295cc7f66f8bc4645a6fc02e2f36e'
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE1_ROLLBACK_BASELINE_CHANGED'; END IF;
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public'
      AND policyname='pr107_company_role_restrictive_all')<>0
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE1_ROLLBACK_RESTRICTIVE_LEFTOVER'; END IF;
 IF (SELECT count(*) FROM pg_roles WHERE rolname IN
     ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev')
      AND NOT rolcanlogin AND NOT rolinherit AND NOT rolbypassrls AND rolconnlimit=0)<>2
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE1_ROLLBACK_DORMANT_ROLES_MISSING'; END IF;
 IF EXISTS(SELECT 1 FROM information_schema.role_table_grants
    WHERE grantee IN('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev')
      AND table_schema='public')
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE1_ROLLBACK_GRANTS_REMAIN'; END IF;
END $postflight$;
COMMIT;
