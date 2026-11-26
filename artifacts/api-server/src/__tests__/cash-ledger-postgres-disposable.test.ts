import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import { disposableCashPgAdapter } from "../lib/cash-ledger-postgres-disposable";
import { postCashJournal, prepareCashJournal, reverseCashJournalLines, type CashMovement } from "../lib/cash-ledger-posting";

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
  it("QA-only future Account18 cash: IN/OUT, replay, concurrency, rollback and reversal",async()=>{
    // Account18/COA75839 are verified identifiers; Config9001 and contra902
    // are disposable QA fixtures, never historic Config5 or approved live COAs.
    const futureScope={companyId:1,configId:9001,accountId:18,
      accountType:"cash" as const,cashCoaId:75839,counterpartyCoaId:902};
    const inRow={rowNumber:1,date:"2026-11-27",direction:"IN" as const,
      amount:"150000.25",sourceFingerprint:"a".repeat(64)};
    const outRow={rowNumber:2,date:"2026-11-27",direction:"OUT" as const,
      amount:"45000.75",sourceFingerprint:"b".repeat(64)};
    const first=await postCashJournal(adapter,futureScope,inRow);
    const second=await postCashJournal(adapter,futureScope,outRow);
    expect(first.replay).toBe(false);
    expect(second.replay).toBe(false);
    const q=await pool.query(`SELECT e.id,e.total_debit::text td,e.total_credit::text tc,
      array_agg(l.account_id ORDER BY l.line_number) coas,
      array_agg(l.debit::text ORDER BY l.line_number) dr,
      array_agg(l.credit::text ORDER BY l.line_number) cr
      FROM cash_qa.accounting_entries e
      JOIN cash_qa.accounting_entry_lines l ON l.entry_id=e.id
      WHERE e.id=ANY($1::bigint[]) GROUP BY e.id ORDER BY e.id`,[[first.id,second.id]]);
    expect(q.rows).toHaveLength(2);
    expect(q.rows[0]).toMatchObject({td:"150000.25",tc:"150000.25",
      coas:[75839,902],dr:["150000.25","0.00"],cr:["0.00","150000.25"]});
    expect(q.rows[1]).toMatchObject({td:"45000.75",tc:"45000.75",
      coas:[75839,902],dr:["0.00","45000.75"],cr:["45000.75","0.00"]});
    expect((await postCashJournal(adapter,futureScope,inRow)).replay).toBe(true);
    await expect(postCashJournal(adapter,futureScope,
      {...inRow,sourceFingerprint:"c".repeat(64)}))
      .rejects.toThrow("CASH_SOURCE_CHANGED_REVIEW_REQUIRED");
    const concurrent={...inRow,rowNumber:3,sourceFingerprint:"d".repeat(64)};
    const results=await Promise.all([
      postCashJournal(adapter,futureScope,concurrent),
      postCashJournal(adapter,futureScope,concurrent)]);
    expect(results.filter(x=>x.replay)).toHaveLength(1);
    expect(results.filter(x=>!x.replay)).toHaveLength(1);
    const before=(await pool.query("SELECT count(*)::int n FROM cash_qa.cash_sources")).rows[0].n;
    // Earlier suite test installs a QA-only trigger rejecting account 999.
    await expect(postCashJournal(adapter,{...futureScope,counterpartyCoaId:999},
      {...outRow,rowNumber:4,sourceFingerprint:"e".repeat(64)}))
      .rejects.toThrow("INJECTED_LINE_FAILURE");
    expect((await pool.query("SELECT count(*)::int n FROM cash_qa.cash_sources")).rows[0].n).toBe(before);
    expect((await pool.query("SELECT count(*)::int n FROM cash_qa.accounting_entries")).rows[0].n).toBe(before);
    const original=prepareCashJournal(futureScope,outRow);
    const reversed=reverseCashJournalLines(original.lines);
    expect(original.lines[0].creditCents).toBe(4500075n);
    expect(reversed[0].debitCents).toBe(4500075n);
    expect(reversed.reduce((acc,line)=>acc+line.debitCents-line.creditCents,0n)).toBe(0n);
  });

});
