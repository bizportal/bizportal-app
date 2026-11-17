-- PR125 CST-DEV only. Accept existing Portal's 24-byte/48-hex and canonical 32-byte/64-hex PO tokens.
-- Exact one-line regex expansion; preserve observed session_user, PO->GR->Shipment locks
-- and extra post-lock token expiry recheck. Never rotate any existing PO tokens.
-- No PROD, no GCP change, no role/password/Finance Writer activation.
BEGIN;
SET LOCAL lock_timeout='800ms';
SET LOCAL statement_timeout='20000ms';
DO $gate$
DECLARE n integer; md text;
BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres'
 THEN RAISE EXCEPTION 'PR125_DEV_DB_ADMIN_UNVERIFIED'; END IF;
 IF to_regprocedure('finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)') IS NULL
 THEN RAISE EXCEPTION 'PR125_PRIVATE_FUNCTION_MISSING'; END IF;
 SELECT md5(prosrc) INTO md FROM pg_proc WHERE oid=to_regprocedure('finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)');
 IF md<> '06d261a1ec4908c31b681d7a0f1f26cd' THEN RAISE EXCEPTION 'PR125_FUNCTION_SOURCE_CHANGED'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)')
       AND prosecdef AND pg_get_userbyid(proowner)='bizportal_finance_parent_lock_owner_dev'
       AND proconfig @> ARRAY['search_path=pg_catalog, pg_temp']::text[])
 THEN RAISE EXCEPTION 'PR125_FUNCTION_IDENTITY_CONFIG_CHANGED'; END IF;
 SELECT count(*) INTO n FROM pg_roles WHERE
  rolname IN ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev')
  AND rolcanlogin AND NOT rolinherit AND NOT rolbypassrls AND NOT rolsuper
  AND rolconnlimit BETWEEN 1 AND 4;
 IF n<>2 THEN RAISE EXCEPTION 'PR125_COMPANY_ROLES_NOT_READIED'; END IF;
 SELECT count(*) INTO n FROM pg_policies WHERE schemaname='public'
  AND policyname='pr107_company_role_restrictive_all' AND permissive='RESTRICTIVE';
 IF n<>11 THEN RAISE EXCEPTION 'PR125_COMPANY_RLS_NOT_READY'; END IF;
 SELECT count(*) INTO n FROM pg_policies WHERE schemaname='public'
  AND policyname IN ('pr108_definer_read','pr108_definer_lock');
 IF n<>6 THEN RAISE EXCEPTION 'PR125_PRIVATE_OWNER_RLS_NOT_READY'; END IF;
 IF has_schema_privilege('anon','finance_ops_private','USAGE')
 OR has_schema_privilege('authenticated','finance_ops_private','USAGE')
 OR has_schema_privilege('bizportal_marketplace_finance_login_dev','finance_ops_private','USAGE')
 THEN RAISE EXCEPTION 'PR125_PRIVATE_SCHEMA_LEAK'; END IF;
END $gate$;
-- Scoped owner transfer / replacement only: no Finance role change or parent DML.
GRANT CREATE ON SCHEMA finance_ops_private TO bizportal_finance_parent_lock_owner_dev;
GRANT bizportal_finance_parent_lock_owner_dev TO postgres WITH SET TRUE;
SET LOCAL ROLE bizportal_finance_parent_lock_owner_dev;
CREATE OR REPLACE FUNCTION finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(
    p_po_id integer,p_gr_id integer,p_supplier_id integer,p_vendor_token text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $pr125_body$
DECLARE v_company integer;
BEGIN
  -- This is the authenticated DB login, not the SECURITY DEFINER owner.
  -- A caller can change an ordinary GUC, but cannot forge session_user.
  v_company := (CASE WHEN session_user='bizportal_finance_cst_login_dev' THEN 1 WHEN session_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END);
  IF v_company IS NULL
    OR p_po_id IS NULL OR p_po_id<=0
    OR p_gr_id IS NULL OR p_gr_id<=0
    OR p_supplier_id IS NULL OR p_supplier_id<=0
    OR p_vendor_token IS NULL OR p_vendor_token !~ '^([0-9a-fA-F]{48}|[0-9a-fA-F]{64})$'
  THEN RETURN FALSE; END IF;

  -- The row locks are held until the outer canonical Invoice transaction
  -- commits/rolls back. Fixed PO -> Goods Receipt -> Shipment order.
  PERFORM 1 FROM public.mkt_purchase_orders po
    WHERE po.id=p_po_id AND po.company_id=v_company
      AND po.vendor_id=p_supplier_id
      AND po.vendor_token=p_vendor_token
      AND (po.vendor_token_expires_at IS NULL OR
           po.vendor_token_expires_at > (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC'))
    FOR UPDATE OF po;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  PERFORM 1 FROM public.mkt_po_goods_receipts gr
    INNER JOIN public.mkt_po_shipments sh ON sh.id=gr.shipment_id
    WHERE gr.id=p_gr_id AND sh.po_id=p_po_id
    FOR UPDATE OF gr;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  PERFORM 1 FROM public.mkt_po_shipments sh
    INNER JOIN public.mkt_po_goods_receipts gr ON gr.shipment_id=sh.id
    WHERE gr.id=p_gr_id AND sh.po_id=p_po_id
    FOR UPDATE OF sh;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  -- Waiting for a PO, GR or Shipment lock can outlast a token that was valid
  -- when the first SELECT started. Revalidate with wall-clock time AFTER all
  -- locks are held; the caller must not create an invoice with an expired token.
  PERFORM 1 FROM public.mkt_purchase_orders po
    WHERE po.id=p_po_id AND po.company_id=v_company
      AND po.vendor_id=p_supplier_id AND po.vendor_token=p_vendor_token
      AND (po.vendor_token_expires_at IS NULL OR
           po.vendor_token_expires_at > (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC'));
  RETURN FOUND;
END
$pr125_body$;
RESET ROLE;
REVOKE bizportal_finance_parent_lock_owner_dev FROM postgres GRANTED BY postgres;
REVOKE CREATE ON SCHEMA finance_ops_private FROM bizportal_finance_parent_lock_owner_dev;
DO $verify$
DECLARE md text; n integer;
BEGIN
 SELECT md5(prosrc) INTO md FROM pg_proc WHERE oid=to_regprocedure('finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)');
 IF md<> 'f74ae1995c4ec52505b06624c6010950' THEN RAISE EXCEPTION 'PR125_TOKEN_REGEX_POSTCHECK_FAILED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)')
 AND prosecdef AND pg_get_userbyid(proowner)='bizportal_finance_parent_lock_owner_dev'
 AND proconfig @> ARRAY['search_path=pg_catalog, pg_temp']::text[])
 THEN RAISE EXCEPTION 'PR125_OWNER_SECURITY_DEF_CHANGED'; END IF;
 IF has_function_privilege('anon','finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)','EXECUTE')
 OR has_function_privilege('authenticated','finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)','EXECUTE')
 OR has_function_privilege('bizportal_marketplace_finance_login_dev','finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)','EXECUTE')
 OR NOT has_function_privilege('bizportal_finance_cst_login_dev','finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)','EXECUTE')
 OR NOT has_function_privilege('bizportal_finance_diva_login_dev','finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)','EXECUTE')
 THEN RAISE EXCEPTION 'PR125_PRIVATE_FUNCTION_EXECUTE_GRANTS_CHANGED'; END IF;
 IF has_schema_privilege('bizportal_finance_parent_lock_owner_dev','finance_ops_private','CREATE')
 THEN RAISE EXCEPTION 'PR125_PRIVATE_OWNER_CREATE_GRANT_LEFTOVER'; END IF;
 SELECT count(*) INTO n FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid
 JOIN pg_roles u ON u.oid=m.member WHERE
 r.rolname='bizportal_finance_parent_lock_owner_dev' AND u.rolname='postgres'
 AND m.set_option;
 IF n<>0 THEN RAISE EXCEPTION 'PR125_TEMPORARY_ROLE_SET_NOT_REVOKED'; END IF;
END $verify$;
COMMIT;
