-- PR107 REVIEW-ONLY. This is intentionally NOT an installable migration.
-- CST-DEV only if separately approved; never PROD; never remove this guard in repo.
-- The unsafe, unapproved execution path is blocked before ANY role/policy change.
BEGIN;
DO $no_go$
BEGIN
  RAISE EXCEPTION 'PR107_REVIEW_ONLY_DO_NOT_APPLY_ANY_LIVE_DATABASE';
END
$no_go$;

DO $pr107$
DECLARE matched integer; total_policies integer; total_tables integer;
BEGIN
  IF current_database()<>'postgres' AND current_database()<>'cst_pr107_ci'
  THEN RAISE EXCEPTION 'PR107_UNEXPECTED_DATABASE'; END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname IN ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev'))
  THEN RAISE EXCEPTION 'PR107_ROLES_ALREADY_EXIST'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname='bizportal_marketplace_finance_login_dev' AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolinherit)
  THEN RAISE EXCEPTION 'PR107_ORIGINAL_FINANCE_ROLE_CHANGED'; END IF;
  WITH expected(t,p,c) AS (VALUES
      ('mkt_accounting_handoffs','pr50_finance_dev_handoff_insert','INSERT'),
      ('mkt_accounting_handoffs','pr50_finance_dev_handoff_read','SELECT'),
      ('mkt_ap_preparations','pr50_finance_dev_ap_insert','INSERT'),
      ('mkt_ap_preparations','pr50_finance_dev_ap_read','SELECT'),
      ('mkt_ap_preparations','pr50_finance_dev_ap_update','UPDATE'),
      ('mkt_po_goods_receipt_items','pr50_finance_dev_receipt_items_read','SELECT'),
      ('mkt_po_goods_receipts','pr50_finance_dev_receipts_read','SELECT'),
      ('mkt_po_shipment_items','pr50_finance_dev_shipment_items_read','SELECT'),
      ('mkt_po_shipments','pr50_finance_dev_shipments_read','SELECT'),
      ('mkt_purchase_order_lines','pr50_finance_dev_po_lines_read','SELECT'),
      ('mkt_purchase_orders','pr50_finance_dev_po_read','SELECT'),
      ('payment_requests','pr50_finance_dev_payment_insert','INSERT'),
      ('payment_requests','pr50_finance_dev_payment_read','SELECT'),
      ('vendor_invoice_lines','pr50_finance_dev_vendor_invoice_lines_insert','INSERT'),
      ('vendor_invoice_lines','pr50_finance_dev_invoice_lines_read','SELECT'),
      ('vendor_invoices','pr50_finance_dev_vendor_invoice_insert','INSERT'),
      ('vendor_invoices','pr50_finance_dev_invoice_read','SELECT'),
      ('vendor_invoices','pr50_finance_dev_invoice_update','UPDATE')
  )
  SELECT count(*) INTO matched
  FROM expected e JOIN pg_catalog.pg_policies actual
    ON actual.schemaname='public' AND actual.tablename=e.t AND actual.policyname=e.p AND actual.cmd=e.c
  WHERE actual.permissive='PERMISSIVE'
    AND actual.roles=ARRAY['bizportal_marketplace_finance_login_dev']::name[];
  SELECT count(*),count(DISTINCT tablename) INTO total_policies,total_tables
    FROM pg_catalog.pg_policies WHERE schemaname='public' AND 'bizportal_marketplace_finance_login_dev'=ANY(roles);
  IF matched<>18 OR total_policies<>18 OR total_tables<>11
  THEN RAISE EXCEPTION 'PR107_FINANCE_POLICY_BASELINE_DRIFT matched=%,count=%,tables=%',
    matched,total_policies,total_tables; END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY(ARRAY['mkt_purchase_orders','mkt_purchase_order_lines','mkt_po_shipments','mkt_po_shipment_items','mkt_po_goods_receipts','mkt_po_goods_receipt_items','vendor_invoices','vendor_invoice_lines','mkt_ap_preparations','payment_requests','mkt_accounting_handoffs'])
      AND NOT c.relrowsecurity)
  THEN RAISE EXCEPTION 'PR107_RLS_DISABLED_ON_BASELINE'; END IF;
  IF NOT has_table_privilege('bizportal_marketplace_finance_login_dev','public.mkt_purchase_orders','SELECT')
    OR has_any_column_privilege('bizportal_marketplace_finance_login_dev','public.mkt_purchase_orders','UPDATE')
    OR has_any_column_privilege('bizportal_marketplace_finance_login_dev','public.mkt_po_goods_receipts','UPDATE')
    OR has_any_column_privilege('bizportal_marketplace_finance_login_dev','public.mkt_po_shipments','UPDATE')
  THEN RAISE EXCEPTION 'PR107_FINANCE_PARENT_GRANT_BASELINE_CHANGED'; END IF;

  -- Ensure no current ACL drift: the new company roles must inherit only
  -- exactly the old Finance's reviewed narrow INSERT/UPDATE column sets.
  WITH expected(tab,priv,cols) AS (VALUES
    ('vendor_invoices','INSERT','attachment_content_type,attachment_file_name,attachment_object_path,attachment_size,company_id,created_by,currency,grand_total,invoice_date,invoice_number,mkt_goods_receipt_id,mkt_purchase_order_id,notes,status,supplier_id,supplier_name,tax_amount,three_way_match_status,total_amount,vendor_invoice_ref'),
    ('vendor_invoice_lines','INSERT','invoice_id,mkt_purchase_order_line_id,name,notes,quantity,subtotal,tax_amount,unit,unit_cost'),
    ('mkt_ap_preparations','UPDATE','finance_reviewed_at,finance_reviewed_by,payment_handoff_at,payment_handoff_by,payment_request_id,preparation_number,status,updated_at,waiting_payment_at'),
    ('vendor_invoices','UPDATE','match_notes,status,three_way_match_status,updated_at')
  ), actual AS (
    SELECT table_name,privilege_type,
      string_agg(quote_ident(column_name),',' ORDER BY column_name) AS cols
    FROM information_schema.column_privileges
    WHERE table_schema='public' AND grantee='bizportal_marketplace_finance_login_dev'
      AND privilege_type IN ('INSERT','UPDATE')
      AND table_name IN ('vendor_invoices','vendor_invoice_lines','mkt_ap_preparations')
    GROUP BY table_name,privilege_type
  )
  SELECT count(*) INTO matched FROM expected e JOIN actual a
    ON a.table_name=e.tab AND a.privilege_type=e.priv AND a.cols=e.cols;
  IF matched<>4
  THEN RAISE EXCEPTION 'PR107_NARROW_COLUMN_GRANT_BASELINE_DRIFT matched=%',matched; END IF;
  IF has_table_privilege('bizportal_marketplace_finance_login_dev','public.vendor_invoices','INSERT')
     OR has_table_privilege('bizportal_marketplace_finance_login_dev','public.vendor_invoice_lines','INSERT')
  THEN RAISE EXCEPTION 'PR107_UNEXPECTED_BROAD_VENDOR_INSERT_PRIVILEGE'; END IF;
  IF EXISTS(SELECT 1 FROM (VALUES ('mkt_accounting_handoffs_id_seq'),('mkt_ap_preparations_id_seq'),('payment_requests_id_seq'),('vendor_invoice_lines_id_seq'),('vendor_invoices_id_seq')) AS s(name)
    WHERE NOT has_sequence_privilege('bizportal_marketplace_finance_login_dev','public.'||s.name,'USAGE'))
  THEN RAISE EXCEPTION 'PR107_FINANCE_ID_SEQUENCE_PRIVILEGES_CHANGED'; END IF;
END
$pr107$;

-- Phase 1 deliberately creates NOLOGIN roles with no passwords. A separate
-- independently approved release would provision role LOGIN & secret custody.
CREATE ROLE bizportal_finance_cst_login_dev NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE bizportal_finance_diva_login_dev NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
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
COMMIT;
