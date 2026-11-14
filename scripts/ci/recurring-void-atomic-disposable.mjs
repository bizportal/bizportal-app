/**
 * Disposable, SYNTHETIC transaction-design proof, not a production migration.
 * Deliberately refuses any address except the local GitHub Actions PG fixture.
 * Tests a future company-scoped v2 function; does not invoke the legacy 3-arg writer.
 */
import assert from "node:assert/strict";
import pg from "pg";
const { Pool } = pg;
const url = process.env.RECURRING_VOID_DISPOSABLE_URL ?? "";
let u;
try { u = new URL(url); } catch { throw Error("DISPOSABLE_URL_REQUIRED"); }
if (u.protocol !== "postgresql:" || u.hostname !== "127.0.0.1" ||
    u.port !== "65432" || u.pathname !== "/void_ci" || u.username !== "postgres") {
  throw Error("REFUSE_NON_DISPOSABLE_DB");
}
const pool = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 5000 });
const sql = `
CREATE SCHEMA ci_void;
CREATE TABLE ci_void.payments (
  id integer PRIMARY KEY,
  company_id integer NOT NULL,
  status text NOT NULL,
  amount integer NOT NULL CHECK (amount > 0)
);
CREATE TABLE ci_void.journals (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer NOT NULL,
  payment_id integer NOT NULL REFERENCES ci_void.payments(id),
  kind text NOT NULL CHECK (kind IN ('original','reversal')),
  reversal_of integer REFERENCES ci_void.journals(id),
  debit_amount integer NOT NULL CHECK (debit_amount >= 0),
  credit_amount integer NOT NULL CHECK (credit_amount >= 0),
  CONSTRAINT balanced CHECK (debit_amount=credit_amount)
);
CREATE UNIQUE INDEX ci_void_one_reversal ON ci_void.journals(reversal_of)
  WHERE kind='reversal';
CREATE TABLE ci_void.audits (
  payment_id integer PRIMARY KEY REFERENCES ci_void.payments(id),
  company_id integer NOT NULL,
  original_journal_id integer NOT NULL REFERENCES ci_void.journals(id),
  reversal_journal_id integer NOT NULL REFERENCES ci_void.journals(id),
  actor text NOT NULL,
  reason text NOT NULL
);
CREATE TABLE ci_void.fail_switch (enabled boolean NOT NULL);
INSERT INTO ci_void.fail_switch VALUES (false);
CREATE FUNCTION ci_void.reject_test_audit() RETURNS trigger
LANGUAGE plpgsql AS $t$
BEGIN
  IF EXISTS (SELECT 1 FROM ci_void.fail_switch WHERE enabled) THEN
    RAISE EXCEPTION 'SYNTHETIC_AUDIT_FAIL';
  END IF;
  RETURN NEW;
END $t$;
CREATE TRIGGER ci_void_audit_fail BEFORE INSERT ON ci_void.audits
  FOR EACH ROW EXECUTE FUNCTION ci_void.reject_test_audit();

-- Every decisive query is inside the function's own transaction.
-- Company scope is checked under a payment row lock (no separate HTTP precheck).
CREATE FUNCTION ci_void.void_payment_v2(
 p_payment integer, p_company integer, p_actor text, p_reason text
) RETURNS integer LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO pg_catalog, ci_void AS $fn$
DECLARE p ci_void.payments%ROWTYPE;
DECLARE existing integer;
DECLARE source_journal ci_void.journals%ROWTYPE;
DECLARE reversal integer;
BEGIN
 IF p_company IS NULL OR p_company < 1 OR btrim(p_actor)='' OR length(btrim(p_reason))<10
 THEN RAISE EXCEPTION 'INVALID_REVERSAL_REQUEST'; END IF;
 SELECT * INTO p FROM ci_void.payments
 WHERE id=p_payment AND company_id=p_company FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_NOT_IN_COMPANY'; END IF;
 SELECT a.reversal_journal_id INTO existing FROM ci_void.audits a
 WHERE a.payment_id=p_payment AND a.company_id=p_company;
 IF FOUND THEN RETURN existing; END IF;
 IF p.status <> 'confirmed' THEN RAISE EXCEPTION 'PAYMENT_NOT_CONFIRMED'; END IF;
 SELECT * INTO source_journal FROM ci_void.journals
 WHERE payment_id=p_payment AND company_id=p_company AND kind='original' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_JOURNAL_MISSING'; END IF;
 INSERT INTO ci_void.journals(company_id,payment_id,kind,reversal_of,debit_amount,credit_amount)
 VALUES(p_company,p_payment,'reversal',source_journal.id,
        source_journal.credit_amount,source_journal.debit_amount) RETURNING id INTO reversal;
 UPDATE ci_void.payments SET status='rejected'
 WHERE id=p_payment AND company_id=p_company;
 INSERT INTO ci_void.audits(payment_id,company_id,original_journal_id,reversal_journal_id,actor,reason)
 VALUES(p_payment,p_company,source_journal.id,reversal,btrim(p_actor),btrim(p_reason));
 RETURN reversal;
END $fn$;
INSERT INTO ci_void.payments VALUES
 (101,900001,'confirmed',1000),(202,900002,'confirmed',2000),
 (303,900001,'confirmed',3000);
INSERT INTO ci_void.journals(company_id,payment_id,kind,reversal_of,debit_amount,credit_amount)
 VALUES (900001,101,'original',NULL,1000,1000),
        (900002,202,'original',NULL,2000,2000),
        (900001,303,'original',NULL,3000,3000);
`;
const one = async (sql, params=[]) => (await pool.query(sql,params)).rows;
async function expectReject(promise, fragment) {
  await assert.rejects(promise, e => String(e.message).includes(fragment));
}
const call = (payment, company) =>
  pool.query("SELECT ci_void.void_payment_v2($1,$2,'ci-owner','approved synthetic reversal') AS reversal", [payment,company]);
try {
 await pool.query(sql);
 await expectReject(call(202,900001), "PAYMENT_NOT_IN_COMPANY");
 assert.equal((await one("SELECT status FROM ci_void.payments WHERE id=202"))[0].status,"confirmed");
 assert.equal((await one("SELECT count(*)::int n FROM ci_void.audits"))[0].n,0);
 console.log("PASS cross-company atomic reject with zero writes");
 const first = await call(101,900001);
 const firstId = first.rows[0].reversal;
 assert.ok(Number.isInteger(firstId));
 const repeat = await call(101,900001);
 assert.equal(repeat.rows[0].reversal,firstId);
 const [a,b] = await Promise.all([call(101,900001),call(101,900001)]);
 assert.deepEqual([a.rows[0].reversal,b.rows[0].reversal],[firstId,firstId]);
 assert.equal((await one("SELECT count(*)::int n FROM ci_void.audits WHERE payment_id=101"))[0].n,1);
 assert.equal((await one("SELECT count(*)::int n FROM ci_void.journals WHERE payment_id=101 AND kind='reversal'"))[0].n,1);
 console.log("PASS idempotency under sequential and concurrent duplicate calls");
 const journal = (await one(`SELECT j.kind,j.debit_amount,j.credit_amount,
   o.debit_amount AS original_debit,o.credit_amount AS original_credit
   FROM ci_void.journals j JOIN ci_void.journals o ON o.id=j.reversal_of
   WHERE j.payment_id=101 AND j.kind='reversal'`))[0];
 assert.equal(journal.debit_amount,journal.original_credit);
 assert.equal(journal.credit_amount,journal.original_debit);
 assert.equal(journal.debit_amount,journal.credit_amount);
 console.log("PASS synthetic reversal journal balance");
 await pool.query("UPDATE ci_void.fail_switch SET enabled=true");
 await expectReject(call(303,900001),"SYNTHETIC_AUDIT_FAIL");
 const state = (await one(`SELECT status,
   (SELECT count(*)::int FROM ci_void.journals WHERE payment_id=303 AND kind='reversal') AS reversals,
   (SELECT count(*)::int FROM ci_void.audits WHERE payment_id=303) AS audits
   FROM ci_void.payments WHERE id=303`))[0];
 assert.deepEqual(state,{status:"confirmed",reversals:0,audits:0});
 console.log("PASS atomic rollback after audit insert failure");
 await pool.query("UPDATE ci_void.fail_switch SET enabled=false");
 await expectReject(call(999,900001),"PAYMENT_NOT_IN_COMPANY");
 console.log("PASS missing payment no-op");
 console.log("DISPOSABLE_ATOMIC_PROTOTYPE_PASS 5 checks");
} finally {
 await pool.end();
}
