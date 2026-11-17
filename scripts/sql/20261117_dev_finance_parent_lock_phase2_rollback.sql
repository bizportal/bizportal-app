-- CST-DEV phase2 rollback. Preserve phase1 company NOLOGIN roles/RLS/grants.
-- Transport must independently pin project xssrfshdrtdfupgqwfdw.
-- Refuses active company logins/sessions and any changed private function.
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
DO $rollback_preflight$
BEGIN
 IF to_regrole('bizportal_finance_parent_lock_owner_dev') IS NULL OR
 to_regnamespace('finance_ops_private') IS NULL OR
 to_regprocedure('finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)') IS NULL
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_ROLLBACK_NOT_INSTALLED'; END IF;
 IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename IN
 ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev'))
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_ROLLBACK_COMPANY_SESSION_ACTIVE'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE
 oid='finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)'::regprocedure
 AND proowner='bizportal_finance_parent_lock_owner_dev'::regrole AND prosecdef
 AND proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
 AND md5(prosrc)='06d261a1ec4908c31b681d7a0f1f26cd')
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_ROLLBACK_FUNCTION_DRIFT'; END IF;
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public'
 AND tablename IN ('mkt_purchase_orders','mkt_po_goods_receipts','mkt_po_shipments')
 AND policyname IN ('pr108_definer_read','pr108_definer_lock')
 AND roles=ARRAY['bizportal_finance_parent_lock_owner_dev']::name[])<>6
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_ROLLBACK_OWNER_POLICY_DRIFT'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='bizportal_finance_parent_lock_owner_dev'
 AND (rolcanlogin OR rolinherit OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolconnlimit<>0))
 OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE member='bizportal_finance_parent_lock_owner_dev'::regrole)
 OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE roleid='bizportal_finance_parent_lock_owner_dev'::regrole
 AND (m.set_option OR m.inherit_option OR m.member<>'postgres'::regrole))
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_ROLLBACK_OWNER_PRIVILEGE_DRIFT'; END IF;
END $rollback_preflight$;
GRANT bizportal_finance_parent_lock_owner_dev TO postgres WITH SET TRUE, INHERIT FALSE;
SET LOCAL ROLE bizportal_finance_parent_lock_owner_dev;
REVOKE EXECUTE ON FUNCTION finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text) FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
DROP FUNCTION finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text);
RESET ROLE;
DROP POLICY pr108_definer_lock ON public.mkt_purchase_orders;
DROP POLICY pr108_definer_read ON public.mkt_purchase_orders;
DROP POLICY pr108_definer_lock ON public.mkt_po_shipments;
DROP POLICY pr108_definer_read ON public.mkt_po_shipments;
DROP POLICY pr108_definer_lock ON public.mkt_po_goods_receipts;
DROP POLICY pr108_definer_read ON public.mkt_po_goods_receipts;
REVOKE UPDATE(status) ON public.mkt_purchase_orders FROM bizportal_finance_parent_lock_owner_dev;
REVOKE UPDATE(inspection_status) ON public.mkt_po_goods_receipts FROM bizportal_finance_parent_lock_owner_dev;
REVOKE UPDATE(shipment_status) ON public.mkt_po_shipments FROM bizportal_finance_parent_lock_owner_dev;
REVOKE SELECT ON public.mkt_purchase_orders,public.mkt_po_goods_receipts,public.mkt_po_shipments FROM bizportal_finance_parent_lock_owner_dev;
REVOKE USAGE ON SCHEMA public FROM bizportal_finance_parent_lock_owner_dev;
REVOKE USAGE ON SCHEMA finance_ops_private FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev,bizportal_finance_parent_lock_owner_dev;
DROP SCHEMA finance_ops_private RESTRICT;
REVOKE bizportal_finance_parent_lock_owner_dev FROM postgres;
DROP ROLE bizportal_finance_parent_lock_owner_dev;
DO $postflight$
BEGIN
 IF to_regnamespace('finance_ops_private') IS NOT NULL OR
 to_regrole('bizportal_finance_parent_lock_owner_dev') IS NOT NULL OR
 EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public'
 AND policyname IN ('pr108_definer_read','pr108_definer_lock'))
 THEN RAISE EXCEPTION 'DEV_FINANCE_PHASE2_ROLLBACK_RESIDUE'; END IF;
END $postflight$;
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
