-- PR106: synthetic catalog gate verifies the SAME pg_policy/pg_auth_members
-- pattern used by marketplace-finance-dev.ts. No live DB or credentials.
BEGIN;
CREATE ROLE ci_pr106_cst LOGIN NOINHERIT NOBYPASSRLS;
CREATE ROLE ci_pr106_diva LOGIN NOINHERIT NOBYPASSRLS;
CREATE ROLE ci_pr106_dummy NOLOGIN NOINHERIT NOBYPASSRLS;
GRANT ci_pr106_cst,ci_pr106_diva TO postgres WITH SET TRUE;

DO $setup$
DECLARE name text;
BEGIN
 FOREACH name IN ARRAY ARRAY[
   'mkt_purchase_orders','mkt_purchase_order_lines',
   'mkt_po_shipments','mkt_po_shipment_items',
   'mkt_po_goods_receipts','mkt_po_goods_receipt_items',
   'vendor_invoices','vendor_invoice_lines',
   'mkt_ap_preparations','payment_requests','mkt_accounting_handoffs'
 ] LOOP
   EXECUTE format('CREATE TABLE public.%I (id integer PRIMARY KEY, company_id integer NOT NULL)',name);
   EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',name);
   EXECUTE format('GRANT SELECT ON public.%I TO ci_pr106_cst,ci_pr106_diva',name);
   EXECUTE format(
    'CREATE POLICY ci_permissive ON public.%I FOR SELECT TO ci_pr106_cst,ci_pr106_diva USING(true)',name);
   EXECUTE format(
    'CREATE POLICY ci_role_guard ON public.%I AS RESTRICTIVE FOR ALL TO ci_pr106_cst,ci_pr106_diva USING ((current_user=''ci_pr106_cst'' AND company_id=1) OR (current_user=''ci_pr106_diva'' AND company_id=3)) WITH CHECK ((current_user=''ci_pr106_cst'' AND company_id=1) OR (current_user=''ci_pr106_diva'' AND company_id=3))',name);
 END LOOP;
END $setup$;

GRANT USAGE ON SCHEMA public TO ci_pr106_cst,ci_pr106_diva;
SET LOCAL ROLE ci_pr106_cst;
DO $verify$
DECLARE guard_count integer; isolated boolean; role_memberships integer;
BEGIN
 SELECT count(DISTINCT c.relname)::integer,
        coalesce((SELECT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolbypassrls
                  FROM pg_catalog.pg_roles WHERE rolname=current_user),false),
        (SELECT count(*)::integer FROM pg_catalog.pg_auth_members m
         WHERE m.member=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user))
 INTO guard_count,isolated,role_memberships
 FROM pg_catalog.pg_policy p
 JOIN pg_catalog.pg_class c ON c.oid=p.polrelid
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relrowsecurity
 AND NOT p.polpermissive AND p.polcmd='*'
 AND (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)=ANY(p.polroles)
 AND c.relname IN (
   'mkt_purchase_orders','mkt_purchase_order_lines',
   'mkt_po_shipments','mkt_po_shipment_items',
   'mkt_po_goods_receipts','mkt_po_goods_receipt_items',
   'vendor_invoices','vendor_invoice_lines',
   'mkt_ap_preparations','payment_requests','mkt_accounting_handoffs'
 );
 IF guard_count<>11 OR NOT isolated OR role_memberships<>0
 THEN RAISE EXCEPTION 'CATALOG_COMPANY_GUARD_POSITIVE_FAILED count=%, isolation=%, member=%',guard_count,isolated,role_memberships;
 END IF;
END $verify$;
SELECT 'PR106_ELEVEN_RESTRICTIVE_RLS_GUARDS_PASS';
RESET ROLE;

-- Drop one restrictive policy (leave the permissive one). Readiness must fail
-- even though row_security_active remains true on all eleven tables.
DROP POLICY ci_role_guard ON public.mkt_po_goods_receipt_items;
SET LOCAL ROLE ci_pr106_cst;
DO $verify$
DECLARE guard_count integer;
BEGIN
 SELECT count(DISTINCT c.relname)::integer INTO guard_count
 FROM pg_catalog.pg_policy p
 JOIN pg_catalog.pg_class c ON c.oid=p.polrelid
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relrowsecurity
 AND NOT p.polpermissive AND p.polcmd='*'
 AND (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)=ANY(p.polroles)
 AND c.relname IN (
   'mkt_purchase_orders','mkt_purchase_order_lines',
   'mkt_po_shipments','mkt_po_shipment_items',
   'mkt_po_goods_receipts','mkt_po_goods_receipt_items',
   'vendor_invoices','vendor_invoice_lines',
   'mkt_ap_preparations','payment_requests','mkt_accounting_handoffs'
 );
 IF guard_count<>10 THEN RAISE EXCEPTION 'CATALOG_MISSING_POLICY_NOT_DETECTED count=%',guard_count; END IF;
END $verify$;
SELECT 'PR106_MISSING_RESTRICTIVE_POLICY_DETECTED_PASS';
RESET ROLE;

-- Simulate unexpected role membership. Verify the same introspection query
-- catches it even when company policy is otherwise configured.
GRANT ci_pr106_dummy TO ci_pr106_cst;
SET LOCAL ROLE ci_pr106_cst;
DO $verify$
DECLARE memberships integer;
BEGIN
 SELECT count(*)::integer INTO memberships FROM pg_catalog.pg_auth_members m
 WHERE m.member=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user);
 IF memberships<>1 THEN RAISE EXCEPTION 'CATALOG_MEMBERSHIP_NOT_DETECTED %',memberships; END IF;
END $verify$;
SELECT 'PR106_UNEXPECTED_ROLE_MEMBERSHIP_DETECTED_PASS';
RESET ROLE;
ROLLBACK;
SELECT CASE WHEN to_regclass('public.mkt_purchase_orders') IS NULL
 AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN('ci_pr106_cst','ci_pr106_diva','ci_pr106_dummy'))
 THEN 'PR106_CATALOG_RLS_NO_RESIDUE_ROLLBACK_PASS'
 ELSE 'PR106_CATALOG_RLS_RESIDUE_ERROR' END;
