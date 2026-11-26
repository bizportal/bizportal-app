import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import { disposableCashPgAdapter } from "../lib/cash-ledger-postgres-disposable";
import { postCashJournal, type CashMovement } from "../lib/cash-ledger-posting";

const url = process.env.CASH_QA_PG_URL;
const suite = url ? describe : describe.skip;
const scope = { companyId: 1, configId: 5, accountId: 18,
  accountType: "cash" as const, cashCoaId: 101, counterpartyCoaId: 202 };
const movement: CashMovement = { rowNumber: 1, date: "2026-11-26",
  direction: "IN", amount: "112.78", sourceFingerprint: "a".repeat(64) };

suite("disposable PostgreSQL cash journal adapter (never business DB)", () => {
  let pool: any;
  let adapter: ReturnType<typeof disposableCashPgAdapter>;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { Pool } = require("pg");
    pool = new Pool({ connectionString:url, max: 4, connectionTimeoutMillis: 3000 });
    await pool.query("CREATE SCHEMA cash_qa");
    await pool.query(`CREATE TABLE cash_qa.accounting_entries(
      id bigserial primary key, source_key text not null unique, tx_date date not null,
      total_debit numeric(16,2) not null, total_credit numeric(16,2) not null,
      check(total_debit=total_credit AND total_debit>0))`);
    await pool.query(`CREATE TABLE cash_qa.accounting_entry_lines(
      entry_id bigint not null references cash_qa.accounting_entries(id),
      line_number integer not null, account_id integer not null,
      debit numeric(16,2) not null, credit numeric(16,2) not null,
      primary key(entry_id,line_number), check(debit>=0 AND credit>=0),
      check((debit>0 AND credit=0) OR (credit>0 AND debit=0)))`);
    await pool.query(`CREATE TABLE cash_qa.cash_sources(
      source_key text primary key, fingerprint text not null,
      journal_id bigint not null unique references cash_qa.accounting_entries(id))`);
    adapter = disposableCashPgAdapter(pool);
  });
  afterAll(async () => {
    if (pool) { await pool.query("DROP SCHEMA IF EXISTS cash_qa CASCADE"); await pool.end(); }
  });
  it("posts 374 synthetic cash movements atomically with balanced headers and lines", async () => {
    for (let n=1;n<=374;n++) await postCashJournal(adapter,scope,{...movement,rowNumber:n});
    const r = await pool.query(`SELECT
      (SELECT count(*) FROM cash_qa.cash_sources)::integer AS sources,
      (SELECT count(*) FROM cash_qa.accounting_entries)::integer AS entries,
      (SELECT count(*) FROM cash_qa.accounting_entry_lines)::integer AS lines,
      (SELECT count(*) FROM cash_qa.accounting_entries e WHERE NOT EXISTS (
        SELECT 1 FROM cash_qa.accounting_entry_lines l WHERE l.entry_id=e.id
        GROUP BY l.entry_id HAVING count(*)=2 AND sum(l.debit)=sum(l.credit)
          AND sum(l.debit)=e.total_debit))::integer AS unbalanced`);
    expect(r.rows[0]).toMatchObject({sources:374,entries:374,lines:748,unbalanced:0});
  }, 45000);
  it("replays 374 rows without inserts and rejects changed fingerprint", async () => {
    for(let n=1;n<=374;n++) {
      expect((await postCashJournal(adapter,scope,{...movement,rowNumber:n})).replay).toBe(true);
    }
    await expect(postCashJournal(adapter,scope,{...movement,sourceFingerprint:"b".repeat(64)}))
      .rejects.toThrow("CASH_SOURCE_CHANGED_REVIEW_REQUIRED");
    const r = await pool.query("SELECT count(*)::integer AS n FROM cash_qa.accounting_entries");
    expect(r.rows[0].n).toBe(374);
  }, 45000);
  it("rolls back failed accounting line and prevents orphan source/header", async () => {
    await pool.query(`CREATE FUNCTION cash_qa.fail_line() RETURNS trigger LANGUAGE plpgsql AS
      $$BEGIN IF NEW.account_id=999 THEN RAISE EXCEPTION 'INJECTED_LINE_FAILURE'; END IF; RETURN NEW; END$$`);
    await pool.query(`CREATE TRIGGER reject_999 BEFORE INSERT ON cash_qa.accounting_entry_lines
      FOR EACH ROW EXECUTE FUNCTION cash_qa.fail_line()`);
    await expect(postCashJournal(adapter,{...scope,cashCoaId:999},{...movement,rowNumber:375}))
      .rejects.toThrow("INJECTED_LINE_FAILURE");
    const r=await pool.query(`SELECT
      (SELECT count(*) FROM cash_qa.accounting_entries)::integer AS entries,
      (SELECT count(*) FROM cash_qa.cash_sources)::integer AS sources`);
    expect(r.rows[0]).toMatchObject({entries:374,sources:374});
  });
  it("prevents simultaneous duplicate posting using source-key lock", async () => {
    const m={...movement,rowNumber:376};
    const results=await Promise.all([postCashJournal(adapter,scope,m),postCashJournal(adapter,scope,m)]);
    expect(results.filter(x=>x.replay)).toHaveLength(1);
    expect(results.filter(x=>!x.replay)).toHaveLength(1);
  });
});
