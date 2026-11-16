-- PR102 review-only DRAFT: NOT AN AUTHORIZED MIGRATION.
-- Target, if separately authorized: Supabase CST-DEV ONLY. NEVER PROD.
-- The intentional guard below aborts all execution. Do not remove it during
-- review or CI. A release engineer must create an official migration from
-- this design, independently approve the exact database target and rollback,
-- and prove signed HTTPS service integration BEFORE enabling any feature flag.
BEGIN;
DO $no_go$
BEGIN
  RAISE EXCEPTION 'PR102_REVIEW_ONLY_DO_NOT_APPLY_TO_ANY_LIVE_DATABASE';
END
$no_go$;

-- PRECONDITIONS (unreachable while the guard remains):
DO $preflight$
DECLARE policies integer;
BEGIN
  IF current_database() <> 'postgres' THEN
    RAISE EXCEPTION 'UNEXPECTED_DATABASE';
  END IF;
  IF to_regnamespace('finance_ops_private') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_roles
                WHERE rolname='bizportal_finance_parent_lock_owner_dev') THEN
    RAISE EXCEPTION 'PRIVATE_SCHEMA_OR_ROLE_ALREADY_EXISTS';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
      WHERE rolname='bizportal_marketplace_finance_login_dev'
        AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'EXPECTED_RESTRICTED_FINANCE_ROLE_NOT_PRESENT';
  END IF;
  IF has_any_column_privilege('bizportal_marketplace_finance_login_dev','public.mkt_purchase_orders','UPDATE')
    OR has_any_column_privilege('bizportal_marketplace_finance_login_dev','public.mkt_po_goods_receipts','UPDATE') THEN
    RAISE EXCEPTION 'FINANCE_PARENT_UPDATE_BASELINE_CHANGED';
  END IF;
  SELECT count(*) INTO policies
    FROM pg_policies
    WHERE schemaname='public'
      AND 'bizportal_marketplace_finance_login_dev' = ANY(roles);
  IF policies <> 18 THEN
    RAISE EXCEPTION 'FINANCE_RLS_BASELINE_DRIFT: % policies',policies;
  END IF;
  IF EXISTS(
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public'
        AND c.relname IN ('mkt_purchase_orders','mkt_po_goods_receipts','mkt_po_shipments')
        AND NOT c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'PARENT_RLS_REQUIRED';
  END IF;
END
$preflight$;

CREATE ROLE bizportal_finance_parent_lock_owner_dev
  NOLOGIN NOINHERIT NOBYPASSRLS;
CREATE SCHEMA finance_ops_private AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA finance_ops_private FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA finance_ops_private
  TO bizportal_finance_parent_lock_owner_dev,
     bizportal_marketplace_finance_login_dev;
GRANT CREATE ON SCHEMA finance_ops_private
  TO bizportal_finance_parent_lock_owner_dev;
GRANT USAGE ON SCHEMA public
  TO bizportal_finance_parent_lock_owner_dev;
GRANT SELECT ON public.mkt_purchase_orders,
                public.mkt_po_shipments,
                public.mkt_po_goods_receipts
  TO bizportal_finance_parent_lock_owner_dev;
-- Narrow owner-only grants authorize row locks. Finance login receives NONE.
GRANT UPDATE(status) ON public.mkt_purchase_orders
  TO bizportal_finance_parent_lock_owner_dev;
GRANT UPDATE(inspection_status) ON public.mkt_po_goods_receipts
  TO bizportal_finance_parent_lock_owner_dev;

CREATE POLICY pr102_parent_po_select_dev ON public.mkt_purchase_orders
  FOR SELECT TO bizportal_finance_parent_lock_owner_dev
  USING(company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer);
CREATE POLICY pr102_parent_po_update_dev ON public.mkt_purchase_orders
  FOR UPDATE TO bizportal_finance_parent_lock_owner_dev
  USING(company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer)
  WITH CHECK(company_id = nullif(current_setting('app.marketplace_company_id',true),'')::integer);
CREATE POLICY pr102_parent_shipment_select_dev ON public.mkt_po_shipments
  FOR SELECT TO bizportal_finance_parent_lock_owner_dev
  USING(EXISTS(
    SELECT 1 FROM public.mkt_purchase_orders po
    WHERE po.id=mkt_po_shipments.po_id
      AND po.company_id=nullif(current_setting('app.marketplace_company_id',true),'')::integer
  ));
CREATE POLICY pr102_parent_gr_select_dev ON public.mkt_po_goods_receipts
  FOR SELECT TO bizportal_finance_parent_lock_owner_dev
  USING(EXISTS(
    SELECT 1 FROM public.mkt_po_shipments sh
    JOIN public.mkt_purchase_orders po ON po.id=sh.po_id
    WHERE sh.id=mkt_po_goods_receipts.shipment_id
      AND po.company_id=nullif(current_setting('app.marketplace_company_id',true),'')::integer
  ));
CREATE POLICY pr102_parent_gr_update_dev ON public.mkt_po_goods_receipts
  FOR UPDATE TO bizportal_finance_parent_lock_owner_dev
  USING(EXISTS(
    SELECT 1 FROM public.mkt_po_shipments sh
    JOIN public.mkt_purchase_orders po ON po.id=sh.po_id
    WHERE sh.id=mkt_po_goods_receipts.shipment_id
      AND po.company_id=nullif(current_setting('app.marketplace_company_id',true),'')::integer
  ))
  WITH CHECK(EXISTS(
    SELECT 1 FROM public.mkt_po_shipments sh
    JOIN public.mkt_purchase_orders po ON po.id=sh.po_id
    WHERE sh.id=mkt_po_goods_receipts.shipment_id
      AND po.company_id=nullif(current_setting('app.marketplace_company_id',true),'')::integer
  ));

-- The function body below must be kept identical to the disposable proof
-- source: scripts/tests/pr102-vendor-parent-lock-function.ts.
CREATE FUNCTION finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(
  p_po_id integer,p_gr_id integer,p_supplier_id integer,p_vendor_token text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp
AS $body$
DECLARE v_scope text; v_company integer;
BEGIN
  v_scope := pg_catalog.current_setting('app.marketplace_company_id',true);
  IF v_scope IS NULL OR v_scope !~ '^[1-9][0-9]{0,8}$' THEN RETURN FALSE; END IF;
  v_company := v_scope::integer;
  IF p_po_id IS NULL OR p_po_id<=0 OR p_gr_id IS NULL OR p_gr_id<=0
    OR p_supplier_id IS NULL OR p_supplier_id<=0 OR p_vendor_token IS NULL
    OR p_vendor_token !~ '^[0-9a-fA-F]{64}$' THEN RETURN FALSE; END IF;
  PERFORM 1 FROM public.mkt_purchase_orders po
    WHERE po.id=p_po_id AND po.company_id=v_company
      AND po.vendor_id=p_supplier_id AND po.vendor_token=p_vendor_token
      AND (po.vendor_token_expires_at IS NULL
           OR po.vendor_token_expires_at > (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC'))
    FOR UPDATE OF po;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  PERFORM 1 FROM public.mkt_po_goods_receipts gr
    JOIN public.mkt_po_shipments sh ON sh.id=gr.shipment_id
    WHERE gr.id=p_gr_id AND sh.po_id=p_po_id
    FOR UPDATE OF gr;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  RETURN TRUE;
END
$body$;
-- Revoke default PUBLIC privileges BEFORE this transaction commits.
REVOKE ALL ON FUNCTION
  finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)
  FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION
  finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)
  OWNER TO bizportal_finance_parent_lock_owner_dev;
REVOKE CREATE ON SCHEMA finance_ops_private
  FROM bizportal_finance_parent_lock_owner_dev;
GRANT EXECUTE ON FUNCTION
  finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)
  TO bizportal_marketplace_finance_login_dev;

DO $postflight$
BEGIN
  IF has_schema_privilege('anon','finance_ops_private','USAGE')
    OR has_schema_privilege('authenticated','finance_ops_private','USAGE')
    OR has_function_privilege('anon','finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)','EXECUTE')
    OR has_function_privilege('authenticated','finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)','EXECUTE')
    OR has_any_column_privilege('bizportal_marketplace_finance_login_dev','public.mkt_purchase_orders','UPDATE')
    OR has_any_column_privilege('bizportal_marketplace_finance_login_dev','public.mkt_po_goods_receipts','UPDATE')
  THEN
    RAISE EXCEPTION 'PR102_PRIVATE_FUNCTION_SECURITY_POSTFLIGHT_FAILED';
  END IF;
END
$postflight$;
COMMIT;
