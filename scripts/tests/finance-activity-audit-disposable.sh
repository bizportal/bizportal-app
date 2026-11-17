#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PG="bizportal-finance-activity-audit-ci-${RANDOM}"
IMAGE="${FINANCE_AUDIT_PG_IMAGE:-postgres:16-alpine}"
case "$IMAGE" in postgres:16-alpine|postgres:17-alpine) ;; *) exit 4;; esac
docker image inspect "$IMAGE" >/dev/null
cleanup() { docker rm -f "$PG" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --rm --name "$PG" --network none --memory 300m \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,size=128m \
  -e POSTGRES_PASSWORD=synthetic-admin-only -e POSTGRES_HOST_AUTH_METHOD=scram-sha-256 \
  "$IMAGE" >/dev/null
admin() { docker exec -i -e PGPASSWORD=synthetic-admin-only "$PG" psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d postgres "$@"; }
# The entrypoint's temporary initialization server exposes only a Unix socket.
# An authenticated TCP query waits for the final server used by the test.
ready=0
for _ in $(seq 1 80); do
  if admin -tAc 'SELECT 1' >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.25
done
if [[ "$ready" != 1 ]]; then
  echo 'FINANCE_ACTIVITY_POSTGRES_STARTUP_TIMEOUT' >&2
  docker logs "$PG" >&2
  exit 5
fi
company() { docker exec -i -e PGPASSWORD=synthetic-company-only "$PG" psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$1" -d postgres; }
admin <<'SQL'
CREATE ROLE aicore_dev_runtime NOLOGIN;
CREATE ROLE bizportal_marketplace_reader_dev NOLOGIN;
CREATE ROLE bizportal_finance_cst_login_dev LOGIN PASSWORD 'synthetic-company-only' NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE bizportal_finance_diva_login_dev LOGIN PASSWORD 'synthetic-company-only' NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE TABLE public.mkt_rfqs(id integer PRIMARY KEY, company_id integer);
CREATE TABLE public.mkt_purchase_orders(id integer PRIMARY KEY,company_id integer,vendor_id integer,rfq_id integer);
CREATE TABLE public.vendor_invoices(id integer PRIMARY KEY,company_id integer,supplier_id integer,mkt_purchase_order_id integer,mkt_goods_receipt_id integer);
CREATE TABLE public.mkt_ap_preparations(id integer PRIMARY KEY,company_id integer,supplier_id integer,vendor_invoice_id integer,mkt_purchase_order_id integer,mkt_goods_receipt_id integer);
CREATE TABLE public.activity_logs(id serial PRIMARY KEY,rfq_id integer,order_id integer,actor_type text NOT NULL DEFAULT 'admin',
  actor_id text,actor_name text,action text NOT NULL,old_value jsonb,new_value jsonb,description text,ip_address text,
  created_at timestamptz NOT NULL DEFAULT now(),mkt_rfq_id integer,mkt_vendor_quote_id integer,mkt_purchase_order_id integer,deduplication_key text);
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY bizportal_dev_legacy_marketplace_related_read_v1 ON public.activity_logs
  FOR SELECT TO aicore_dev_runtime,bizportal_marketplace_reader_dev USING (
    (mkt_purchase_order_id IS NOT NULL) AND EXISTS(SELECT 1 FROM public.mkt_purchase_orders p
      JOIN public.mkt_rfqs r ON r.id=p.rfq_id WHERE p.id=activity_logs.mkt_purchase_order_id AND p.company_id IS NULL AND r.company_id IS NULL));
GRANT USAGE ON SCHEMA public TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
GRANT SELECT ON public.mkt_purchase_orders,public.vendor_invoices,public.mkt_ap_preparations
  TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
DO $fixture$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mkt_purchase_orders','vendor_invoices','mkt_ap_preparations'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY fixture_company_read ON public.%I FOR SELECT TO bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev
      USING (current_user=session_user AND company_id=CASE session_user WHEN ''bizportal_finance_cst_login_dev'' THEN 1 WHEN ''bizportal_finance_diva_login_dev'' THEN 3 END)',t);
  END LOOP;
END
$fixture$;
INSERT INTO public.mkt_purchase_orders VALUES(11,1,10,1),(31,3,35,3);
INSERT INTO public.vendor_invoices VALUES(14,1,10,11,13),(34,3,35,31,33);
INSERT INTO public.mkt_ap_preparations VALUES(16,1,10,14,11,13),(36,3,35,34,31,33);
SQL
admin < "$ROOT/scripts/sql/20261117_dev_finance_activity_audit.sql"
company bizportal_finance_cst_login_dev <<'SQL'
DO $identity$ BEGIN IF current_user<>'bizportal_finance_cst_login_dev' OR session_user<>current_user THEN RAISE EXCEPTION 'NOT_REAL_CST_LOGIN'; END IF; END $identity$;
INSERT INTO public.activity_logs(mkt_purchase_order_id,actor_type,actor_id,action,new_value) VALUES
 (11,'vendor','10','invoice_uploaded','{"invoiceId":14,"goodsReceiptId":13,"status":"draft"}'),
 (11,'vendor','10','invoice_ready_for_ap','{"invoiceId":14,"status":"ready_for_ap","matchStatus":"passed"}'),
 (11,'system',null,'three_way_match_passed','{"invoiceId":14,"status":"passed"}'),
 (11,'admin','synthetic','mkt_ap_preparation_created','{"preparationId":16,"status":"ap_preparation"}'),
 (11,'admin','synthetic','mkt_ap_finance_reviewed','{"preparationId":16,"status":"finance_review"}'),
 (11,'admin','synthetic','mkt_ap_waiting_payment','{"preparationId":16,"status":"waiting_payment"}');
SELECT set_config('app.marketplace_company_id','3',false);
DO $negative$
DECLARE statement text;
BEGIN
  FOREACH statement IN ARRAY ARRAY[
    $q$INSERT INTO public.activity_logs(mkt_purchase_order_id,actor_type,actor_id,action,new_value) VALUES(31,'vendor','35','invoice_uploaded','{"invoiceId":34,"goodsReceiptId":33,"status":"draft"}')$q$,
    $q$INSERT INTO public.activity_logs(mkt_purchase_order_id,actor_type,actor_id,action,new_value) VALUES(11,'vendor','10','invoice_uploaded','{"invoiceId":34,"goodsReceiptId":33,"status":"draft"}')$q$,
    $q$INSERT INTO public.activity_logs(mkt_purchase_order_id,actor_type,actor_id,action,new_value) VALUES(11,'vendor','99','invoice_uploaded','{"invoiceId":14,"goodsReceiptId":13,"status":"draft"}')$q$,
    $q$INSERT INTO public.activity_logs(mkt_purchase_order_id,actor_type,action,new_value) VALUES(11,'admin','user_promoted','{"preparationId":16,"status":"waiting_payment"}')$q$,
    $q$INSERT INTO public.activity_logs(mkt_purchase_order_id,actor_type,action,new_value) VALUES(11,'admin','mkt_ap_finance_reviewed','{"preparationId":36,"status":"finance_review"}')$q$,
    $q$INSERT INTO public.activity_logs(mkt_purchase_order_id,actor_type,action,new_value) VALUES(11,'admin','mkt_ap_finance_reviewed','{"preparationId":16,"status":"paid"}')$q$,
    $q$INSERT INTO public.activity_logs(order_id,mkt_purchase_order_id,actor_type,actor_id,action,new_value) VALUES(99,11,'vendor','10','invoice_uploaded','{"invoiceId":14,"goodsReceiptId":13,"status":"draft"}')$q$,
    $q$SELECT * FROM public.activity_logs$q$,
    $q$UPDATE public.activity_logs SET description='tamper'$q$,
    $q$DELETE FROM public.activity_logs$q$
  ] LOOP
    BEGIN EXECUTE statement; RAISE EXCEPTION 'NEGATIVE_AUDIT_UNEXPECTEDLY_ALLOWED';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  END LOOP;
END
$negative$;
SQL
company bizportal_finance_diva_login_dev <<'SQL'
DO $identity$ BEGIN IF current_user<>'bizportal_finance_diva_login_dev' OR session_user<>current_user THEN RAISE EXCEPTION 'NOT_REAL_DIVA_LOGIN'; END IF; END $identity$;
INSERT INTO public.activity_logs(mkt_purchase_order_id,actor_type,actor_id,action,new_value)
 VALUES(31,'vendor','35','invoice_uploaded','{"invoiceId":34,"goodsReceiptId":33,"status":"draft"}');
SQL
admin <<'SQL'
DO $verify$ BEGIN IF (SELECT count(*) FROM public.activity_logs)<>7 THEN RAISE EXCEPTION 'AUDIT_ROW_COUNT'; END IF; END $verify$;
-- Deliberately widen only this disposable fixture to prove the restrictive
-- boundary still denies reads/mutation and unproven inserts.
GRANT SELECT,UPDATE,DELETE ON public.activity_logs TO bizportal_finance_cst_login_dev;
CREATE POLICY fixture_overbroad ON public.activity_logs FOR ALL TO bizportal_finance_cst_login_dev USING(true) WITH CHECK(true);
SQL
company bizportal_finance_cst_login_dev <<'SQL'
DO $broad$
DECLARE affected integer;
BEGIN
  IF (SELECT count(*) FROM public.activity_logs)<>0 THEN RAISE EXCEPTION 'AUDIT_READ_BYPASS'; END IF;
  UPDATE public.activity_logs SET description='tamper'; GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>0 THEN RAISE EXCEPTION 'AUDIT_UPDATE_BYPASS'; END IF;
  DELETE FROM public.activity_logs; GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>0 THEN RAISE EXCEPTION 'AUDIT_DELETE_BYPASS'; END IF;
  BEGIN INSERT INTO public.activity_logs(mkt_purchase_order_id,actor_type,action,new_value) VALUES(11,'admin','user_promoted','{}');
    RAISE EXCEPTION 'AUDIT_INSERT_BYPASS'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END
$broad$;
SQL
admin <<'SQL'
REVOKE SELECT,UPDATE,DELETE ON public.activity_logs FROM bizportal_finance_cst_login_dev;
DROP POLICY fixture_overbroad ON public.activity_logs;
DO $spoof$
BEGIN
  SET LOCAL ROLE bizportal_finance_cst_login_dev;
  BEGIN INSERT INTO public.activity_logs(mkt_purchase_order_id,actor_type,actor_id,action,new_value)
    VALUES(11,'vendor','10','invoice_uploaded','{"invoiceId":14,"goodsReceiptId":13,"status":"draft"}');
    RAISE EXCEPTION 'SET_ROLE_AUDIT_BYPASS'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END
$spoof$;
SQL
admin < "$ROOT/scripts/sql/20261117_dev_finance_activity_audit_rollback.sql"
admin <<'SQL'
DO $rollback$
BEGIN
  IF (SELECT count(*) FROM public.activity_logs)<>7 OR
    (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='activity_logs')<>1 OR
    has_any_column_privilege('bizportal_finance_cst_login_dev','public.activity_logs','INSERT,SELECT,UPDATE') OR
    has_sequence_privilege('bizportal_finance_cst_login_dev','public.activity_logs_id_seq','USAGE') OR
    has_any_column_privilege('bizportal_finance_diva_login_dev','public.activity_logs','INSERT,SELECT,UPDATE') THEN
    RAISE EXCEPTION 'AUDIT_ROLLBACK_HISTORY_OR_GRANT_DRIFT';
  END IF;
END
$rollback$;
SQL
echo FINANCE_ACTIVITY_REAL_CST_DIVA_APPEND_ONLY_POLICY_AND_ROLLBACK_PASS
