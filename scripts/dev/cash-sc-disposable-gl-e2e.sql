-- CST-DEV only / issue #218. Re-runnable, disposable test. NEVER execute on PROD.
-- 374 SYNTHETIC rows; no references to actual Google Sheets values.
-- The sole objects created are TEMP tables. Explicit ROLLBACK is mandatory.
BEGIN;
CREATE TEMP TABLE cash_sc_source_e2e_221 (
  company_id int NOT NULL CHECK(company_id=1),
  account_id int NOT NULL CHECK(account_id=18),
  source_row int NOT NULL,
  fingerprint text NOT NULL,
  direction text NOT NULL CHECK(direction IN ('IN','OUT')),
  amount numeric(18,2) NOT NULL CHECK(amount>0),
  PRIMARY KEY(company_id,account_id,source_row)
) ON COMMIT DROP;
CREATE TEMP TABLE cash_sc_gl_e2e_221 (
  company_id int NOT NULL CHECK(company_id=1),
  account_id int NOT NULL CHECK(account_id=18),
  source_row int NOT NULL,
  side text NOT NULL CHECK(side IN ('DR','CR')),
  amount numeric(18,2) NOT NULL CHECK(amount>0),
  PRIMARY KEY(company_id,account_id,source_row,side)
) ON COMMIT DROP;
INSERT INTO cash_sc_source_e2e_221
SELECT 1,18,n,md5('E2E-SYNTHETIC-'||n),
 CASE WHEN n%2=0 THEN 'IN' ELSE 'OUT' END, (n::numeric/100)::numeric(18,2)
FROM generate_series(3,376) AS n;
INSERT INTO cash_sc_gl_e2e_221
SELECT company_id,account_id,source_row,'DR',amount FROM cash_sc_source_e2e_221
UNION ALL SELECT company_id,account_id,source_row,'CR',amount FROM cash_sc_source_e2e_221;
DO $test$
DECLARE replay_count int; source_count int; gl_count int; unbalanced int;
BEGIN
 WITH replay AS (
   INSERT INTO cash_sc_source_e2e_221
   SELECT 1,18,n,md5('E2E-SYNTHETIC-'||n),
   CASE WHEN n%2=0 THEN 'IN' ELSE 'OUT' END, (n::numeric/100)::numeric(18,2)
   FROM generate_series(3,376) n
   ON CONFLICT DO NOTHING RETURNING 1
 ) SELECT count(*) INTO replay_count FROM replay;
 SELECT count(*) INTO source_count FROM cash_sc_source_e2e_221;
 SELECT count(*) INTO gl_count FROM cash_sc_gl_e2e_221;
 SELECT count(*) INTO unbalanced
 FROM (SELECT source_row FROM cash_sc_gl_e2e_221
       GROUP BY source_row HAVING sum(CASE WHEN side='DR' THEN amount ELSE -amount END)<>0) bad;
 IF replay_count<>0 OR source_count<>374 OR gl_count<>748 OR unbalanced<>0 THEN
  RAISE EXCEPTION 'CASH_DISPOSABLE_E2E_FAILED: replay %, sources %, GL %, unbalanced %',
    replay_count,source_count,gl_count,unbalanced;
 END IF;
END $test$;
SAVEPOINT deliberate_negative_case;
UPDATE cash_sc_gl_e2e_221 SET amount=amount+0.01 WHERE source_row=262 AND side='CR';
DO $test$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM cash_sc_gl_e2e_221 WHERE source_row=262
   GROUP BY source_row HAVING sum(CASE WHEN side='DR' THEN amount ELSE -amount END)<>0
 ) THEN RAISE EXCEPTION 'NEGATIVE_GL_IMBALANCE_NOT_DETECTED'; END IF;
END $test$;
ROLLBACK TO SAVEPOINT deliberate_negative_case;
DO $test$
BEGIN
 IF EXISTS (
   SELECT 1 FROM cash_sc_gl_e2e_221
   GROUP BY source_row HAVING sum(CASE WHEN side='DR' THEN amount ELSE -amount END)<>0
 ) THEN RAISE EXCEPTION 'ROLLBACK_TO_SAVEPOINT_FAILED'; END IF;
END $test$;
ROLLBACK;
-- Final read-only assertion: there are no surviving temporary objects.
SELECT to_regclass('pg_temp.cash_sc_source_e2e_221') IS NULL AS source_rolled_back,
       to_regclass('pg_temp.cash_sc_gl_e2e_221') IS NULL AS gl_rolled_back;
