-- CST-DEV only. Preserve all audit rows and the original reader policy.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='25s';
DO $preflight$
DECLARE original_count integer; original_hash text;
BEGIN
  IF current_database()<>'postgres' OR current_user<>'postgres' THEN
    RAISE EXCEPTION 'FINANCE_ACTIVITY_UNEXPECTED_DEPLOYMENT_IDENTITY';
  END IF;
  SELECT count(*),md5(string_agg(policyname||'|'||permissive||'|'||array_to_string(roles,',')||'|'||cmd||'|'||
    coalesce(qual,'')||'|'||coalesce(with_check,''),E'\n' ORDER BY policyname))
    INTO original_count,original_hash FROM pg_policies WHERE schemaname='public' AND tablename='activity_logs'
      AND policyname NOT IN('finance_activity_insert_dev','finance_activity_guard_dev');
  IF original_count<>1 OR original_hash IS DISTINCT FROM '39c0a87df926797f5ca451168b4b28e6' OR
    (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='activity_logs'
      AND policyname IN('finance_activity_insert_dev','finance_activity_guard_dev'))<>2 THEN
    RAISE EXCEPTION 'FINANCE_ACTIVITY_ROLLBACK_POLICY_DRIFT';
  END IF;
END
$preflight$;
DROP POLICY finance_activity_insert_dev ON public.activity_logs;
DROP POLICY finance_activity_guard_dev ON public.activity_logs;
REVOKE INSERT (rfq_id,order_id,actor_type,actor_id,actor_name,action,description,
  old_value,new_value,ip_address,deduplication_key,mkt_rfq_id,mkt_vendor_quote_id,mkt_purchase_order_id)
  ON public.activity_logs FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
REVOKE USAGE ON SEQUENCE public.activity_logs_id_seq
  FROM bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
COMMIT;
