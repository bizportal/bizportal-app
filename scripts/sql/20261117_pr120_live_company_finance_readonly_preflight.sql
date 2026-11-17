-- CST-DEV FINANCE security readiness preflight. SELECT ONLY.
-- Run through the explicitly selected Supabase CST-DEV project
-- xssrfshdrtdfupgqwfdw. No credentials, DDL, DML, role SET or app writes.
-- This gate must PASS before separately reviewed PR107/108 role/RLS rollout.
-- Baseline fingerprint pins actual 18 Finance policy expressions + targets;
-- any intervening DDL by another worker requires a fresh review, not bypass.
WITH expected_tables(tablename) AS (VALUES
 ('mkt_purchase_orders'),('mkt_purchase_order_lines'),
 ('mkt_po_shipments'),('mkt_po_shipment_items'),
 ('mkt_po_goods_receipts'),('mkt_po_goods_receipt_items'),
 ('vendor_invoices'),('vendor_invoice_lines'),
 ('mkt_ap_preparations'),('payment_requests'),
 ('mkt_accounting_handoffs')
), actual_tables AS (
 SELECT c.relname,c.relrowsecurity,c.relnamespace
 FROM pg_catalog.pg_class c
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname IN (SELECT tablename FROM expected_tables)
   AND c.relkind='r'
), legacy AS (
 SELECT tablename,policyname,cmd,permissive,roles::text AS roles,
        COALESCE(qual,'') AS qual,COALESCE(with_check,'') AS with_check
 FROM pg_catalog.pg_policies
 WHERE schemaname='public' AND policyname LIKE 'pr50_finance_dev_%'
), actual_column_grants AS (
 SELECT table_name,privilege_type,
        string_agg(quote_ident(column_name),',' ORDER BY column_name) AS cols
 FROM information_schema.column_privileges
 WHERE table_schema='public'
   AND grantee='bizportal_marketplace_finance_login_dev'
   AND privilege_type IN ('INSERT','UPDATE')
   AND table_name IN ('vendor_invoices','vendor_invoice_lines','mkt_ap_preparations')
 GROUP BY table_name,privilege_type
), expected_column_grants(tab,priv,cols) AS (VALUES
 ('vendor_invoices','INSERT','attachment_content_type,attachment_file_name,attachment_object_path,attachment_size,company_id,created_by,currency,grand_total,invoice_date,invoice_number,mkt_goods_receipt_id,mkt_purchase_order_id,notes,status,supplier_id,supplier_name,tax_amount,three_way_match_status,total_amount,vendor_invoice_ref'),
 ('vendor_invoice_lines','INSERT','invoice_id,mkt_purchase_order_line_id,name,notes,quantity,subtotal,tax_amount,unit,unit_cost'),
 ('mkt_ap_preparations','UPDATE','finance_reviewed_at,finance_reviewed_by,payment_handoff_at,payment_handoff_by,payment_request_id,preparation_number,status,updated_at,waiting_payment_at'),
 ('vendor_invoices','UPDATE','match_notes,status,three_way_match_status,updated_at')
), details AS (
 SELECT
  (SELECT COUNT(*) FROM expected_tables et JOIN actual_tables a ON a.relname=et.tablename AND a.relrowsecurity) AS secured_table_count,
  (SELECT COUNT(*) FROM legacy) AS legacy_policy_count,
  (SELECT COUNT(*) FROM legacy WHERE permissive='PERMISSIVE'
      AND roles=ARRAY['bizportal_marketplace_finance_login_dev']::name[]::text) AS original_role_policy_count,
  (SELECT md5(string_agg(tablename||'|'||policyname||'|'||cmd||'|'||permissive||'|'||roles||'|'||qual||'|'||with_check,E'\n' ORDER BY tablename,policyname,cmd))
    FROM legacy) AS policy_fingerprint,
  (SELECT COUNT(*) FROM expected_column_grants e
    JOIN actual_column_grants a ON a.table_name=e.tab AND a.privilege_type=e.priv AND a.cols=e.cols) AS exact_column_grant_count,
  (SELECT COUNT(*) FROM pg_catalog.pg_roles
    WHERE rolname='bizportal_marketplace_finance_login_dev'
      AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolinherit) AS existing_finance_login_count,
  (SELECT COUNT(*) FROM pg_catalog.pg_roles
    WHERE rolname IN ('bizportal_finance_cst_login_dev',
                      'bizportal_finance_diva_login_dev',
                      'bizportal_finance_parent_lock_owner_dev')) AS proposed_role_count,
  (SELECT COUNT(*) FROM pg_catalog.pg_policies
    WHERE schemaname='public' AND policyname='pr107_company_role_restrictive_all') AS new_restrictive_count,
  (SELECT COUNT(*) FROM pg_catalog.pg_policies
    WHERE schemaname='public' AND policyname IN ('pr108_definer_read','pr108_definer_lock')) AS new_lock_policy_count,
  (SELECT COUNT(*) FROM pg_catalog.pg_namespace WHERE nspname='finance_ops_private') AS private_schema_count
)
SELECT secured_table_count,legacy_policy_count,original_role_policy_count,
       policy_fingerprint,exact_column_grant_count,existing_finance_login_count,
       proposed_role_count,new_restrictive_count,new_lock_policy_count,private_schema_count,
       (current_database()='postgres'
         AND secured_table_count=11 AND legacy_policy_count=18
         AND original_role_policy_count=18
         AND policy_fingerprint='f69295cc7f66f8bc4645a6fc02e2f36e'
         AND exact_column_grant_count=4 AND existing_finance_login_count=1
         AND proposed_role_count=0 AND new_restrictive_count=0
         AND new_lock_policy_count=0 AND private_schema_count=0) AS preflight_pass
FROM details;
