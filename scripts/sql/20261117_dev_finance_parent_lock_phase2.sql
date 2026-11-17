-- CST-DEV reviewed phase 2: private session-user-bound parent row locks only.
-- Target project MUST be pinned by the deployment transport to xssrfshdrtdfupgqwfdw.
-- PostgreSQL database name alone is not a hosted-project identity check.
-- Requires the exact already-installed phase1 metadata below, NOLOGIN company roles.
-- No passwords, LOGIN activation, business rows, flags, GL, payment or messaging.
-- Original PR107/108 guard files remain independently blocked on live databases.
BEGIN;
SET LOCAL lock_timeout='800ms';
SET LOCAL statement_timeout='25000ms';
DO $phase2_baseline$
DECLARE n integer; fp text;
BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres'
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_DATABASE_IDENTITY_MISMATCH'; END IF;
 SELECT count(*) INTO n FROM pg_roles WHERE rolname IN
 ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev')
 AND NOT rolcanlogin AND NOT rolinherit AND NOT rolbypassrls AND NOT rolsuper
 AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND rolconnlimit=0;
 IF n<>2 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_COMPANY_STAGE_NOT_DORMANT'; END IF;
 SELECT count(*),md5(string_agg(tablename||'|'||policyname||'|'||cmd||'|'||
 coalesce(qual,'')||'|'||coalesce(with_check,''),E'\n' ORDER BY tablename,policyname,cmd))
 INTO n,fp FROM pg_policies WHERE schemaname='public' AND policyname LIKE 'pr50_finance_dev_%';
 IF n<>18 OR fp IS DISTINCT FROM '5ef6b3e6c9c7a41cd0fb94ebbb243c66'
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_LEGACY_PREDICATE_DRIFT'; END IF;
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public'
 AND policyname LIKE 'pr50_finance_dev_%' AND cardinality(roles)=3 AND
 roles @> ARRAY['bizportal_marketplace_finance_login_dev','bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev']::name[])<>18
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_LEGACY_ROLE_TARGET_DRIFT'; END IF;
 SELECT count(*),md5(string_agg(tablename||'|'||policyname||'|'||cmd||'|'||
 permissive||'|'||roles::text||'|'||coalesce(qual,'')||'|'||coalesce(with_check,''),
 E'\n' ORDER BY tablename,policyname,cmd)) INTO n,fp
 FROM pg_policies WHERE schemaname='public' AND policyname='pr107_company_role_restrictive_all';
 IF n<>11 OR fp IS DISTINCT FROM '5c1a4a2a782cf1d82e786061f5ef8e21'
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_COMPANY_GUARD_DRIFT'; END IF;
 IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname IN
 ('mkt_purchase_orders','mkt_purchase_order_lines','mkt_po_shipments','mkt_po_shipment_items',
 'mkt_po_goods_receipts','mkt_po_goods_receipt_items','vendor_invoices','vendor_invoice_lines',
 'mkt_ap_preparations','payment_requests','mkt_accounting_handoffs') AND c.relrowsecurity)<>11
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_TABLE_RLS_DRIFT'; END IF;
END $phase2_baseline$;
DO $preflight$
DECLARE guarded_count integer; structure_count integer;
BEGIN
  IF current_database()<>'postgres' OR current_user<>'postgres'
  THEN RAISE EXCEPTION 'PR108_UNKNOWN_DATABASE'; END IF;
  IF to_regnamespace('finance_ops_private') IS NOT NULL
    OR to_regrole('bizportal_finance_parent_lock_owner_dev') IS NOT NULL
    OR to_regprocedure('finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)') IS NOT NULL
  THEN RAISE EXCEPTION 'PR108_FUNCTION_ALREADY_PRESENT_OR_OWNER_DRIFT'; END IF;
  IF to_regrole('bizportal_finance_cst_login_dev') IS NULL OR to_regrole('bizportal_finance_diva_login_dev') IS NULL
  THEN RAISE EXCEPTION 'PR108_COMPANY_ROLE_MISSING'; END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname IN ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev')
      AND (rolcanlogin OR rolinherit OR rolsuper OR rolbypassrls))
  THEN RAISE EXCEPTION 'PR108_COMPANY_ROLES_ALREADY_AUTHENTICATING'; END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles r ON r.oid=m.member
    WHERE r.rolname IN ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev'))
  THEN RAISE EXCEPTION 'PR108_COMPANY_ROLE_MEMBERSHIP_DRIFT'; END IF;
  -- Read-only catalog fingerprints of the three real CST-DEV parent tables.
  -- This is intentionally a subset, not a claim of full schema parity.
  WITH expected(rel,col,type) AS (VALUES
    ('mkt_purchase_orders','id','integer'),
    ('mkt_purchase_orders','company_id','integer'),
    ('mkt_purchase_orders','vendor_id','integer'),
    ('mkt_purchase_orders','vendor_token','text'),
    ('mkt_purchase_orders','vendor_token_expires_at','timestamp without time zone'),
    ('mkt_po_shipments','id','integer'),
    ('mkt_po_shipments','po_id','integer'),
    ('mkt_po_shipments','shipment_status','text'),
    ('mkt_po_goods_receipts','id','integer'),
    ('mkt_po_goods_receipts','shipment_id','integer'),
    ('mkt_po_goods_receipts','inspection_status','text')
  )
  SELECT count(*)::integer INTO structure_count
  FROM expected e
    JOIN pg_catalog.pg_class c ON c.relname=e.rel AND c.relkind='r'
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname=e.col
      AND a.attnum>0 AND NOT a.attisdropped
  WHERE pg_catalog.format_type(a.atttypid,a.atttypmod)=e.type;
  IF structure_count<>11 THEN RAISE EXCEPTION 'PR108_PARENT_SCHEMA_FINGERPRINT_DRIFT %',structure_count; END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN
      ('mkt_purchase_orders','mkt_po_shipments','mkt_po_goods_receipts')
      AND NOT c.relrowsecurity)
  THEN RAISE EXCEPTION 'PR108_PARENT_TABLE_RLS_DISABLED'; END IF;
  SELECT count(*)::integer INTO guarded_count
  FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN (
    'mkt_purchase_orders','mkt_po_shipments','mkt_po_goods_receipts')
    AND p.polname='pr107_company_role_restrictive_all'
    AND p.polcmd='*' AND NOT p.polpermissive
    AND (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='bizportal_finance_cst_login_dev')=ANY(p.polroles)
    AND (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='bizportal_finance_diva_login_dev')=ANY(p.polroles);
  IF guarded_count<>3 THEN RAISE EXCEPTION 'PR108_PR107_PARENT_GUARDS_MISSING %',guarded_count; END IF;
END
$preflight$;

CREATE ROLE bizportal_finance_parent_lock_owner_dev NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 0;
-- Supabase postgres is non-superuser. SET membership is temporary and never inherited.
GRANT bizportal_finance_parent_lock_owner_dev TO postgres WITH SET TRUE, INHERIT FALSE;
CREATE SCHEMA finance_ops_private AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA finance_ops_private FROM PUBLIC;
GRANT USAGE ON SCHEMA finance_ops_private TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev,bizportal_finance_parent_lock_owner_dev;
GRANT CREATE ON SCHEMA finance_ops_private TO bizportal_finance_parent_lock_owner_dev;
GRANT USAGE ON SCHEMA public TO bizportal_finance_parent_lock_owner_dev;
GRANT SELECT ON public.mkt_purchase_orders,public.mkt_po_goods_receipts,public.mkt_po_shipments TO bizportal_finance_parent_lock_owner_dev;
GRANT UPDATE(status) ON public.mkt_purchase_orders TO bizportal_finance_parent_lock_owner_dev;
GRANT UPDATE(inspection_status) ON public.mkt_po_goods_receipts TO bizportal_finance_parent_lock_owner_dev;
GRANT UPDATE(shipment_status) ON public.mkt_po_shipments TO bizportal_finance_parent_lock_owner_dev;

CREATE POLICY pr108_definer_read ON public.mkt_purchase_orders
  FOR SELECT TO bizportal_finance_parent_lock_owner_dev
  USING (company_id=(CASE WHEN session_user='bizportal_finance_cst_login_dev' THEN 1 WHEN session_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END));
CREATE POLICY pr108_definer_lock ON public.mkt_purchase_orders
  FOR UPDATE TO bizportal_finance_parent_lock_owner_dev
  USING (company_id=(CASE WHEN session_user='bizportal_finance_cst_login_dev' THEN 1 WHEN session_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END))
  WITH CHECK (company_id=(CASE WHEN session_user='bizportal_finance_cst_login_dev' THEN 1 WHEN session_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END));

CREATE POLICY pr108_definer_read ON public.mkt_po_shipments
  FOR SELECT TO bizportal_finance_parent_lock_owner_dev
  USING (EXISTS (SELECT 1 FROM public.mkt_purchase_orders po WHERE po.id=mkt_po_shipments.po_id AND po.company_id=(CASE WHEN session_user='bizportal_finance_cst_login_dev' THEN 1 WHEN session_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END)));
CREATE POLICY pr108_definer_lock ON public.mkt_po_shipments
  FOR UPDATE TO bizportal_finance_parent_lock_owner_dev
  USING (EXISTS (SELECT 1 FROM public.mkt_purchase_orders po WHERE po.id=mkt_po_shipments.po_id AND po.company_id=(CASE WHEN session_user='bizportal_finance_cst_login_dev' THEN 1 WHEN session_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.mkt_purchase_orders po WHERE po.id=mkt_po_shipments.po_id AND po.company_id=(CASE WHEN session_user='bizportal_finance_cst_login_dev' THEN 1 WHEN session_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END)));

CREATE POLICY pr108_definer_read ON public.mkt_po_goods_receipts
  FOR SELECT TO bizportal_finance_parent_lock_owner_dev
  USING (EXISTS (SELECT 1 FROM public.mkt_po_shipments sh JOIN public.mkt_purchase_orders po ON po.id=sh.po_id WHERE sh.id=mkt_po_goods_receipts.shipment_id AND po.company_id=(CASE WHEN session_user='bizportal_finance_cst_login_dev' THEN 1 WHEN session_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END)));
CREATE POLICY pr108_definer_lock ON public.mkt_po_goods_receipts
  FOR UPDATE TO bizportal_finance_parent_lock_owner_dev
  USING (EXISTS (SELECT 1 FROM public.mkt_po_shipments sh JOIN public.mkt_purchase_orders po ON po.id=sh.po_id WHERE sh.id=mkt_po_goods_receipts.shipment_id AND po.company_id=(CASE WHEN session_user='bizportal_finance_cst_login_dev' THEN 1 WHEN session_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.mkt_po_shipments sh JOIN public.mkt_purchase_orders po ON po.id=sh.po_id WHERE sh.id=mkt_po_goods_receipts.shipment_id AND po.company_id=(CASE WHEN session_user='bizportal_finance_cst_login_dev' THEN 1 WHEN session_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END)));

CREATE FUNCTION finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(
    p_po_id integer,p_gr_id integer,p_supplier_id integer,p_vendor_token text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE v_company integer;
BEGIN
  -- This is the authenticated DB login, not the SECURITY DEFINER owner.
  -- A caller can change an ordinary GUC, but cannot forge session_user.
  v_company := (CASE WHEN session_user='bizportal_finance_cst_login_dev' THEN 1 WHEN session_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END);
  IF v_company IS NULL
    OR p_po_id IS NULL OR p_po_id<=0
    OR p_gr_id IS NULL OR p_gr_id<=0
    OR p_supplier_id IS NULL OR p_supplier_id<=0
    OR p_vendor_token IS NULL OR p_vendor_token !~ '^[0-9a-fA-F]{64}$'
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
$body$;
REVOKE ALL ON FUNCTION finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text) TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
ALTER FUNCTION finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text) OWNER TO bizportal_finance_parent_lock_owner_dev;
REVOKE CREATE ON SCHEMA finance_ops_private FROM bizportal_finance_parent_lock_owner_dev;
REVOKE bizportal_finance_parent_lock_owner_dev FROM postgres;

DO $verify$
DECLARE matched integer;
BEGIN
  SELECT count(*)::integer INTO matched FROM pg_catalog.pg_policy p
    JOIN pg_catalog.pg_class c ON c.oid=p.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND p.polname IN ('pr108_definer_read','pr108_definer_lock')
    AND c.relname IN ('mkt_purchase_orders','mkt_po_shipments','mkt_po_goods_receipts')
    AND (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='bizportal_finance_parent_lock_owner_dev')=ANY(p.polroles);
  IF matched<>6 THEN RAISE EXCEPTION 'PR108_OWNER_POLICIES_NOT_SIX %',matched; END IF;
  IF has_any_column_privilege('bizportal_finance_cst_login_dev','public.mkt_purchase_orders','UPDATE')
      OR has_any_column_privilege('bizportal_finance_cst_login_dev','public.mkt_po_goods_receipts','UPDATE')
      OR has_any_column_privilege('bizportal_finance_cst_login_dev','public.mkt_po_shipments','UPDATE')
      OR has_any_column_privilege('bizportal_finance_diva_login_dev','public.mkt_purchase_orders','UPDATE')
      OR has_any_column_privilege('bizportal_finance_diva_login_dev','public.mkt_po_goods_receipts','UPDATE')
      OR has_any_column_privilege('bizportal_finance_diva_login_dev','public.mkt_po_shipments','UPDATE')
  THEN RAISE EXCEPTION 'PR108_COMPANY_PARENT_UPDATE_LEAK'; END IF;
  IF has_function_privilege('bizportal_marketplace_finance_login_dev','finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)','EXECUTE')
    OR NOT has_function_privilege('bizportal_finance_cst_login_dev','finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)','EXECUTE')
    OR NOT has_function_privilege('bizportal_finance_diva_login_dev','finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)','EXECUTE')
  THEN RAISE EXCEPTION 'PR108_WRONG_EXECUTE_GRANTS'; END IF;
  IF has_schema_privilege('bizportal_marketplace_finance_login_dev','finance_ops_private','USAGE')
  THEN RAISE EXCEPTION 'PR108_LEGACY_LOGIN_PRIVATE_SCHEMA_LEAK'; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname='bizportal_finance_parent_lock_owner_dev' AND (rolcanlogin OR rolinherit OR rolsuper OR rolbypassrls))
  THEN RAISE EXCEPTION 'PR108_OWNER_ROLE_ATTRIBUTES_UNSAFE'; END IF;
END
$verify$;
DO $owner_custody$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_auth_members m WHERE
 m.roleid='bizportal_finance_parent_lock_owner_dev'::regrole AND
 (m.set_option OR m.inherit_option OR m.member<>'postgres'::regrole))
 OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member='bizportal_finance_parent_lock_owner_dev'::regrole)
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_OWNER_MEMBERSHIP_LEAK'; END IF;
 IF has_schema_privilege('bizportal_finance_parent_lock_owner_dev','finance_ops_private','CREATE')
 OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='bizportal_finance_parent_lock_owner_dev'
 AND (rolcanlogin OR rolinherit OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolconnlimit<>0))
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_OWNER_ATTRIBUTE_DRIFT'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 WHERE p.oid='finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)'::regprocedure
 AND a.grantee=0 AND a.privilege_type='EXECUTE')
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_PUBLIC_FUNCTION_EXECUTE'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE
 oid='finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)'::regprocedure
 AND proowner='bizportal_finance_parent_lock_owner_dev'::regrole AND prosecdef
 AND proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[])
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_FUNCTION_OWNER_OR_PATH_DRIFT'; END IF;
END $owner_custody$;
DO $phase2_baseline$
DECLARE n integer; fp text;
BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres'
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_DATABASE_IDENTITY_MISMATCH'; END IF;
 SELECT count(*) INTO n FROM pg_roles WHERE rolname IN
 ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev')
 AND NOT rolcanlogin AND NOT rolinherit AND NOT rolbypassrls AND NOT rolsuper
 AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND rolconnlimit=0;
 IF n<>2 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_COMPANY_STAGE_NOT_DORMANT'; END IF;
 SELECT count(*),md5(string_agg(tablename||'|'||policyname||'|'||cmd||'|'||
 coalesce(qual,'')||'|'||coalesce(with_check,''),E'\n' ORDER BY tablename,policyname,cmd))
 INTO n,fp FROM pg_policies WHERE schemaname='public' AND policyname LIKE 'pr50_finance_dev_%';
 IF n<>18 OR fp IS DISTINCT FROM '5ef6b3e6c9c7a41cd0fb94ebbb243c66'
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_LEGACY_PREDICATE_DRIFT'; END IF;
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public'
 AND policyname LIKE 'pr50_finance_dev_%' AND cardinality(roles)=3 AND
 roles @> ARRAY['bizportal_marketplace_finance_login_dev','bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev']::name[])<>18
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_LEGACY_ROLE_TARGET_DRIFT'; END IF;
 SELECT count(*),md5(string_agg(tablename||'|'||policyname||'|'||cmd||'|'||
 permissive||'|'||roles::text||'|'||coalesce(qual,'')||'|'||coalesce(with_check,''),
 E'\n' ORDER BY tablename,policyname,cmd)) INTO n,fp
 FROM pg_policies WHERE schemaname='public' AND policyname='pr107_company_role_restrictive_all';
 IF n<>11 OR fp IS DISTINCT FROM '5c1a4a2a782cf1d82e786061f5ef8e21'
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_COMPANY_GUARD_DRIFT'; END IF;
 IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname IN
 ('mkt_purchase_orders','mkt_purchase_order_lines','mkt_po_shipments','mkt_po_shipment_items',
 'mkt_po_goods_receipts','mkt_po_goods_receipt_items','vendor_invoices','vendor_invoice_lines',
 'mkt_ap_preparations','payment_requests','mkt_accounting_handoffs') AND c.relrowsecurity)<>11
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_TABLE_RLS_DRIFT'; END IF;
END $phase2_baseline$;
COMMIT;
