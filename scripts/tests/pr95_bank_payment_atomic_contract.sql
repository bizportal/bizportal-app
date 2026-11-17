-- PR #95 isolated finance writer invariants; NOT the legacy HTTP writer.
-- Run only on a disposable PostgreSQL 16 database. DDL is intentionally
-- destructive within pr95_atomic. Never run on CST-DEV or PROD.
BEGIN;
CREATE SCHEMA pr95_atomic;
CREATE TABLE pr95_atomic.invoices (
  id int PRIMARY KEY, company_id int NOT NULL, gross numeric(14,2) NOT NULL,
  paid numeric(14,2) NOT NULL DEFAULT 0
);
CREATE TABLE pr95_atomic.journals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id int NOT NULL, invoice_id int NOT NULL,
  idempotency_key text NOT NULL,
  gross numeric(14,2) NOT NULL, wht numeric(14,2) NOT NULL,
  UNIQUE(company_id,idempotency_key)
);
CREATE TABLE pr95_atomic.journal_lines (
  journal_id bigint NOT NULL REFERENCES pr95_atomic.journals(id),
  account text NOT NULL, debit numeric(14,2) NOT NULL DEFAULT 0,
  credit numeric(14,2) NOT NULL DEFAULT 0
);
CREATE TABLE pr95_atomic.disbursements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id int NOT NULL, invoice_id int NOT NULL,
  journal_id bigint NOT NULL UNIQUE REFERENCES pr95_atomic.journals(id),
  gross numeric(14,2) NOT NULL, wht numeric(14,2) NOT NULL
);
INSERT INTO pr95_atomic.invoices(id,company_id,gross)
VALUES (1,1,100),(2,2,100),(3,1,100),(4,1,100);
COMMIT;

CREATE OR REPLACE FUNCTION pr95_atomic.pay(
  p_company int, p_invoice int, p_key text, p_gross numeric,
  p_wht numeric, p_fail_after_journal boolean DEFAULT false,
  p_fail_after_disbursement boolean DEFAULT false
) RETURNS text LANGUAGE plpgsql AS $fn$
DECLARE v pr95_atomic.invoices%ROWTYPE; j bigint;
        previous pr95_atomic.journals%ROWTYPE;
BEGIN
  -- Lock invoice before replay lookup and available balance validation.
  SELECT * INTO v FROM pr95_atomic.invoices
   WHERE id=p_invoice AND company_id=p_company FOR UPDATE;
  IF NOT FOUND THEN RETURN 'FORBIDDEN'; END IF;
  SELECT * INTO previous FROM pr95_atomic.journals
    WHERE company_id=p_company AND idempotency_key=p_key;
  IF FOUND THEN
    IF previous.invoice_id=p_invoice
       AND previous.gross=p_gross AND previous.wht=p_wht
    THEN RETURN 'REPLAY'; END IF;
    RETURN 'IDEMPOTENCY_CONFLICT';
  END IF;
  IF p_gross<=0 OR p_wht<0 OR p_wht>=p_gross OR v.paid+p_gross>v.gross
  THEN RETURN 'INVALID_OR_OVERPAY'; END IF;

  INSERT INTO pr95_atomic.journals(company_id,invoice_id,idempotency_key,gross,wht)
  VALUES(p_company,p_invoice,p_key,p_gross,p_wht) RETURNING id INTO j;
  INSERT INTO pr95_atomic.journal_lines(journal_id,account,debit)
  VALUES(j,'AP',p_gross);
  IF p_wht>0 THEN
    INSERT INTO pr95_atomic.journal_lines(journal_id,account,credit)
    VALUES(j,'WHT_LIABILITY',p_wht);
  END IF;
  INSERT INTO pr95_atomic.journal_lines(journal_id,account,credit)
  VALUES(j,'BANK',p_gross-p_wht);

  IF p_fail_after_journal THEN RAISE EXCEPTION 'INJECT_AFTER_JOURNAL'; END IF;

  INSERT INTO pr95_atomic.disbursements(company_id,invoice_id,journal_id,gross,wht)
  VALUES(p_company,p_invoice,j,p_gross,p_wht);

  IF p_fail_after_disbursement THEN RAISE EXCEPTION 'INJECT_AFTER_DISBURSEMENT'; END IF;

  UPDATE pr95_atomic.invoices SET paid=paid+p_gross
   WHERE id=p_invoice AND company_id=p_company
     AND paid+p_gross<=gross;
  IF NOT FOUND THEN RAISE EXCEPTION 'CAS_BALANCE_FAILED'; END IF;
  RETURN 'CREATED';
END;$fn$;

DO $test$
DECLARE before_j bigint; before_disb bigint; before_paid numeric;
BEGIN
 IF pr95_atomic.pay(1,1,'A',60,10)<>'CREATED' THEN RAISE EXCEPTION 'initial'; END IF;
 IF pr95_atomic.pay(1,1,'A',60,10)<>'REPLAY' THEN RAISE EXCEPTION 'replay'; END IF;
 IF pr95_atomic.pay(1,1,'A',59,10)<>'IDEMPOTENCY_CONFLICT'
 THEN RAISE EXCEPTION 'same key changed amount'; END IF;
 IF pr95_atomic.pay(1,1,'A',60,9)<>'IDEMPOTENCY_CONFLICT'
 THEN RAISE EXCEPTION 'same key changed WHT'; END IF;
 IF pr95_atomic.pay(1,4,'A',60,10)<>'IDEMPOTENCY_CONFLICT'
 THEN RAISE EXCEPTION 'same key changed invoice'; END IF;
 IF pr95_atomic.pay(1,1,'B',50,0)<>'INVALID_OR_OVERPAY'
 THEN RAISE EXCEPTION 'overpay'; END IF;
 IF pr95_atomic.pay(1,2,'C',10,0)<>'FORBIDDEN'
 THEN RAISE EXCEPTION 'cross-company'; END IF;

 SELECT count(*) INTO before_j FROM pr95_atomic.journals;
 SELECT count(*) INTO before_disb FROM pr95_atomic.disbursements;
 SELECT paid INTO before_paid FROM pr95_atomic.invoices WHERE id=4;
 BEGIN
   PERFORM pr95_atomic.pay(1,4,'FAIL_J',30,5,true,false);
 EXCEPTION WHEN OTHERS THEN
   IF SQLERRM<>'INJECT_AFTER_JOURNAL' THEN RAISE; END IF;
 END;
 BEGIN
   PERFORM pr95_atomic.pay(1,4,'FAIL_D',30,5,false,true);
 EXCEPTION WHEN OTHERS THEN
   IF SQLERRM<>'INJECT_AFTER_DISBURSEMENT' THEN RAISE; END IF;
 END;
 IF (SELECT count(*) FROM pr95_atomic.journals)<>before_j OR
    (SELECT count(*) FROM pr95_atomic.disbursements)<>before_disb OR
    (SELECT paid FROM pr95_atomic.invoices WHERE id=4)<>before_paid
 THEN RAISE EXCEPTION 'partial rollback leaked'; END IF;

 IF EXISTS(
   SELECT 1 FROM pr95_atomic.journals j
   JOIN pr95_atomic.journal_lines l ON l.journal_id=j.id
   GROUP BY j.id HAVING sum(l.debit)<>sum(l.credit)
 ) THEN RAISE EXCEPTION 'unbalanced journal'; END IF;
 IF (SELECT count(*) FROM pr95_atomic.journals)<>1 OR
    (SELECT count(*) FROM pr95_atomic.disbursements)<>1 OR
    (SELECT paid FROM pr95_atomic.invoices WHERE id=1)<>60
 THEN RAISE EXCEPTION 'duplicate or mismatched payment'; END IF;
 RAISE NOTICE 'PASS: exact replay, mismatch conflict, overpay, tenant, WHT balance, rollback at two stages';
END;$test$;
-- Concurrent two-client replay is tested separately by opening two psql clients:
--   SELECT pr95_atomic.pay(1,3,'X',80,8);
--   SELECT pr95_atomic.pay(1,3,'Y',80,8);
-- Assert exactly one CREATED, one INVALID_OR_OVERPAY, paid=80, one journal.
