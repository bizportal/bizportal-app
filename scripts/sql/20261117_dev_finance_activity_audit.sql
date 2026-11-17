-- CST-DEV xssrfshdrtdfupgqwfdw only; pin project in the deployment transport.
-- Append-only Finance activity audit. No OTP/admin fallback, source grants,
-- SELECT/UPDATE/DELETE privilege or SECURITY DEFINER function is introduced.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='25s';
DO $preflight$
DECLARE actor name; baseline_count integer; baseline_hash text;
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'FINANCE_ACTIVITY_UNEXPECTED_DEPLOYMENT_IDENTITY';
  END IF;
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN
      ('activity_logs','mkt_purchase_orders','vendor_invoices','mkt_ap_preparations')
      AND c.relrowsecurity AND pg_get_userbyid(c.relowner)='postgres') <> 4 THEN
    RAISE EXCEPTION 'FINANCE_ACTIVITY_PARENT_RLS_OR_OWNER_DRIFT';
  END IF;
  SELECT count(*),md5(string_agg(policyname||'|'||permissive||'|'||array_to_string(roles,',')||'|'||cmd||'|'||
    coalesce(qual,'')||'|'||coalesce(with_check,''),E'\n' ORDER BY policyname))
    INTO baseline_count,baseline_hash FROM pg_policies
    WHERE schemaname='public' AND tablename='activity_logs';
  IF baseline_count <> 1 OR baseline_hash IS DISTINCT FROM '39c0a87df926797f5ca451168b4b28e6' THEN
    RAISE EXCEPTION 'FINANCE_ACTIVITY_EXISTING_POLICY_DRIFT';
  END IF;
  FOREACH actor IN ARRAY ARRAY['bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev']::name[] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=actor AND NOT rolsuper AND NOT rolbypassrls
      AND NOT rolinherit AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication) OR
      EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=actor)) THEN
      RAISE EXCEPTION 'FINANCE_ACTIVITY_ROLE_DRIFT %',actor;
    END IF;
    IF has_any_column_privilege(actor,'public.activity_logs','INSERT,SELECT,UPDATE') OR
      has_table_privilege(actor,'public.activity_logs','DELETE,TRUNCATE') OR
      has_sequence_privilege(actor,'public.activity_logs_id_seq','USAGE') THEN
      RAISE EXCEPTION 'FINANCE_ACTIVITY_GRANT_BASELINE_CHANGED %',actor;
    END IF;
    IF NOT has_table_privilege(actor,'public.mkt_purchase_orders','SELECT') OR
       NOT has_table_privilege(actor,'public.vendor_invoices','SELECT') OR
       NOT has_table_privilege(actor,'public.mkt_ap_preparations','SELECT') THEN
      RAISE EXCEPTION 'FINANCE_ACTIVITY_PARENT_READ_MISSING %',actor;
    END IF;
  END LOOP;
END
$preflight$;

GRANT INSERT (rfq_id,order_id,actor_type,actor_id,actor_name,action,description,
  old_value,new_value,ip_address,deduplication_key,mkt_rfq_id,mkt_vendor_quote_id,mkt_purchase_order_id)
  ON public.activity_logs TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
GRANT USAGE ON SEQUENCE public.activity_logs_id_seq
  TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;

DO $policies$
DECLARE proof text := $proof$
  current_user=session_user AND rfq_id IS NULL AND order_id IS NULL
  AND mkt_rfq_id IS NULL AND mkt_vendor_quote_id IS NULL
  AND jsonb_typeof(new_value)='object'
  AND EXISTS(
    SELECT 1 FROM public.mkt_purchase_orders po
    WHERE po.id=activity_logs.mkt_purchase_order_id
      AND po.company_id=CASE session_user
        WHEN 'bizportal_finance_cst_login_dev' THEN 1
        WHEN 'bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END
      AND (
        (action IN ('invoice_uploaded','invoice_ready_for_ap','invoice_submitted',
          'three_way_match_passed','three_way_match_failed')
          AND EXISTS(SELECT 1 FROM public.vendor_invoices invoice
            WHERE invoice.id::text=new_value->>'invoiceId'
              AND invoice.mkt_purchase_order_id=po.id AND invoice.company_id=po.company_id
              AND invoice.supplier_id=po.vendor_id
              AND (
                (action='invoice_uploaded' AND new_value->>'status'='draft'
                  AND invoice.mkt_goods_receipt_id::text=new_value->>'goodsReceiptId') OR
                (action='invoice_ready_for_ap' AND new_value->>'status'='ready_for_ap'
                  AND new_value->>'matchStatus'='passed') OR
                (action='invoice_submitted' AND new_value->>'status'='submitted'
                  AND new_value->>'matchStatus'='failed') OR
                (action='three_way_match_passed' AND new_value->>'status'='passed') OR
                (action='three_way_match_failed' AND new_value->>'status'='failed')
              ))
          AND CASE WHEN action IN ('three_way_match_passed','three_way_match_failed')
            THEN actor_type='system' AND actor_id IS NULL
            ELSE (actor_type='vendor' AND actor_id=po.vendor_id::text) OR actor_type='admin' END)
        OR
        (action IN ('mkt_ap_preparation_created','mkt_ap_finance_reviewed','mkt_ap_waiting_payment')
          AND actor_type='admin'
          AND EXISTS(SELECT 1 FROM public.mkt_ap_preparations ap
            JOIN public.vendor_invoices invoice ON invoice.id=ap.vendor_invoice_id
            WHERE ap.id::text=new_value->>'preparationId' AND ap.mkt_purchase_order_id=po.id
              AND ap.company_id=po.company_id AND ap.supplier_id=po.vendor_id
              AND invoice.company_id=po.company_id AND invoice.supplier_id=po.vendor_id
              AND invoice.mkt_purchase_order_id=po.id AND invoice.mkt_goods_receipt_id=ap.mkt_goods_receipt_id
              AND new_value->>'status'=CASE action
                WHEN 'mkt_ap_preparation_created' THEN 'ap_preparation'
                WHEN 'mkt_ap_finance_reviewed' THEN 'finance_review'
                WHEN 'mkt_ap_waiting_payment' THEN 'waiting_payment' END))
      )
  )
$proof$;
BEGIN
  EXECUTE format('CREATE POLICY finance_activity_insert_dev ON public.activity_logs FOR INSERT
    TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev WITH CHECK (%s)',proof);
  -- Restrictive ALL also blocks future broad permissive read/update/delete
  -- policies. INSERT has its own WITH CHECK and does not evaluate USING.
  EXECUTE format('CREATE POLICY finance_activity_guard_dev ON public.activity_logs AS RESTRICTIVE FOR ALL
    TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev USING (false) WITH CHECK (%s)',proof);
END
$policies$;
DO $postflight$
DECLARE actor name;
BEGIN
  FOREACH actor IN ARRAY ARRAY['bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev']::name[] LOOP
    IF has_any_column_privilege(actor,'public.activity_logs','SELECT,UPDATE') OR
      has_table_privilege(actor,'public.activity_logs','INSERT,DELETE,TRUNCATE') OR
      NOT has_any_column_privilege(actor,'public.activity_logs','INSERT') THEN
      RAISE EXCEPTION 'FINANCE_ACTIVITY_APPEND_ONLY_BOUNDARY_FAILED %',actor;
    END IF;
  END LOOP;
END
$postflight$;
COMMIT;
