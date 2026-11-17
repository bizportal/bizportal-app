-- Disposable PostgreSQL QA only. Never apply to shared DEV or PROD.
-- Use the root-private Unix socket of fleet-finance-dsv-qa-*; no network/ports.
-- Paired with scripts/test-fleet-source-lock-rls-postgres.mjs.
DO $qa$
BEGIN
  IF current_database() <> 'postgres' OR inet_server_addr() IS NOT NULL THEN
    RAISE EXCEPTION 'This fixture requires the disposable local postgres database';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='bizportal_fleet_finance_login_dev') THEN
    CREATE ROLE bizportal_fleet_finance_login_dev LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$qa$;
GRANT CONNECT ON DATABASE postgres TO bizportal_fleet_finance_login_dev;
CREATE SCHEMA qa_fleet_lock;
CREATE TABLE qa_fleet_lock.fleet_cash_payments(
  id integer PRIMARY KEY,
  company_id integer NOT NULL,
  amount numeric(18,2) NOT NULL
);
INSERT INTO qa_fleet_lock.fleet_cash_payments VALUES(1,1,1.00),(3,3,3.00);
ALTER TABLE qa_fleet_lock.fleet_cash_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE qa_fleet_lock.fleet_cash_payments FORCE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA qa_fleet_lock TO bizportal_fleet_finance_login_dev;
GRANT SELECT,UPDATE(id) ON qa_fleet_lock.fleet_cash_payments TO bizportal_fleet_finance_login_dev;
CREATE POLICY qa_source_select ON qa_fleet_lock.fleet_cash_payments
  FOR SELECT TO bizportal_fleet_finance_login_dev USING(company_id=1);
CREATE POLICY qa_source_lock ON qa_fleet_lock.fleet_cash_payments
  FOR UPDATE TO bizportal_fleet_finance_login_dev USING(company_id=1) WITH CHECK(false);
CREATE POLICY qa_source_identity_boundary ON qa_fleet_lock.fleet_cash_payments
  AS RESTRICTIVE FOR ALL TO bizportal_fleet_finance_login_dev
  USING(company_id=1 AND current_user='bizportal_fleet_finance_login_dev' AND session_user='bizportal_fleet_finance_login_dev')
  WITH CHECK(company_id=1 AND current_user='bizportal_fleet_finance_login_dev' AND session_user='bizportal_fleet_finance_login_dev');
-- This restrictive UPDATE check is essential: permissive checks are OR-combined.
CREATE POLICY qa_source_lock_no_mutation ON qa_fleet_lock.fleet_cash_payments
  AS RESTRICTIVE FOR UPDATE TO bizportal_fleet_finance_login_dev USING(true) WITH CHECK(false);
-- Simulate another pre-existing permissive policy without weakening the boundary.
CREATE POLICY qa_existing_permissive_update ON qa_fleet_lock.fleet_cash_payments
  FOR UPDATE TO PUBLIC USING(true) WITH CHECK(true);
