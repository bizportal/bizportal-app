import { describe,it,expect,vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const mock=vi.hoisted(()=>({transaction:vi.fn(),release:vi.fn(),post:vi.fn(),lock:vi.fn(async()=>{}),emit:vi.fn(),spot:vi.fn()}));
vi.mock("@workspace/db",()=>({db:{},pool:{connect:async()=>({release:mock.release})}}));
vi.mock("drizzle-orm/node-postgres",()=>({drizzle:()=>({transaction:mock.transaction})}));
vi.mock("../lib/accounting.js",()=>({postEntryWithClient:mock.post}));
vi.mock("../lib/posting-engine/validators.js",()=>({createDefaultValidators:()=>[]}));
vi.mock("../lib/logger.js",()=>({logger:{warn:vi.fn(),error:vi.fn()}}));
vi.mock("../lib/ledgerImmutability.js",()=>({lockAccountingEntry:mock.lock}));
vi.mock("../lib/events/financialEventBus.js",()=>({emitJournalCreated:mock.emit}));
vi.mock("../lib/jobs/ledgerConsistencyCheck.js",()=>({scheduleSpotCheck:mock.spot}));
import { CanonicalPostingEngine } from "../lib/posting-engine/CanonicalPostingEngine";
import type { PostingRequest,DbClient } from "../lib/posting-engine/types";
const request:PostingRequest={companyId:1,source:"manual",sourceId:55,journalId:6,journalCode:"CSH",date:new Date("2026-11-27T12:00:00Z"),lines:[{accountId:75839,debit:10000,credit:0},{accountId:902,debit:0,credit:10000}]};
describe("original Accounting engine regression",()=>{
  it("root posting errors escape transaction callback so partial journals roll back",async()=>{
    const tx={};mock.transaction.mockReset();mock.post.mockReset();
    let rolledBack=false;
    mock.transaction.mockImplementation(async(work:(t:unknown)=>Promise<unknown>)=>{
      try{return await work(tx);}catch(e){rolledBack=true;throw e;}
    });
    mock.post.mockRejectedValueOnce(Error("injected line failure"));
    const result=await new CanonicalPostingEngine([]).post(request);
    expect(result).toMatchObject({ok:false,errorCode:"TRANSACTION_FAILED"});
    expect(rolledBack).toBe(true);
    expect(mock.post.mock.calls[0]?.[4]).toBe(true);
    expect(mock.spot).not.toHaveBeenCalled();
    expect(mock.post.mock.calls[0]?.[0]).toBe(tx);
    expect(mock.release).toHaveBeenCalled();
  });
  it("root commit failure never schedules consistency or publishes events",async()=>{
    mock.transaction.mockReset();mock.post.mockReset();mock.spot.mockClear();mock.emit.mockClear();
    mock.post.mockResolvedValueOnce({id:88,status:"posted"});
    mock.transaction.mockImplementation(async(work:(t:unknown)=>Promise<unknown>)=>{
      await work({});throw Error("injected commit failure");
    });
    expect(await new CanonicalPostingEngine([]).post(request)).toMatchObject({ok:false,errorCode:"TRANSACTION_FAILED"});
    expect(mock.spot).not.toHaveBeenCalled();expect(mock.emit).not.toHaveBeenCalled();
  });
  it("root posting requests durable audit and schedules spot check only after commit",async()=>{
    mock.transaction.mockReset();mock.post.mockReset();mock.spot.mockClear();mock.emit.mockClear();
    mock.post.mockResolvedValueOnce({id:89,status:"posted"});
    mock.transaction.mockImplementation(async(work:(t:unknown)=>Promise<unknown>)=>{
      const result=await work({});
      expect(mock.spot).not.toHaveBeenCalled();
      return result;
    });
    expect(await new CanonicalPostingEngine([]).post(request)).toEqual({ok:true,entryId:89});
    expect(mock.post.mock.calls[0]?.[4]).toBe(true);
    await vi.waitFor(()=>expect(mock.spot).toHaveBeenCalledWith(89));
    expect(mock.emit).not.toHaveBeenCalled();
  });
  it("caller-owned transaction is not replaced by a second root transaction",async()=>{
    mock.transaction.mockClear();mock.post.mockReset();mock.post.mockResolvedValueOnce({id:77});
    const tx={} as DbClient;
    expect(await new CanonicalPostingEngine([]).post(request,tx)).toEqual({ok:true,entryId:77});
    expect(mock.transaction).not.toHaveBeenCalled();
    expect(mock.post.mock.calls[0]?.[0]).toBe(tx);
  });
});
const accounting=readFileSync(resolve(process.cwd(),"src/lib/accounting.ts"),"utf8");
const outbox=readFileSync(resolve(process.cwd(),"src/lib/accounting/outboxProcessor.ts"),"utf8");
describe("source-level guards for original accounting (not PostgreSQL E2E)",()=>{
  it("qualifies the globally unique journal number with company",()=>{
    const section=accounting.slice(accounting.indexOf("async function _nextEntryNumber"),accounting.indexOf("async function _postEntryCore"));
    expect(section).toContain("const prefix = `${basePrefix}-C${cid}`;");
    expect(section).toContain("ON CONFLICT (journal_prefix, company_id, year)");
  });
  it("includes prior snapshot accounts when the month has no activity",()=>{
    const section=accounting.slice(accounting.indexOf("export async function createLedgerSnapshot"),accounting.indexOf("export async function closeFinancialPeriod"));
    expect(section).not.toContain("if (activities.length === 0) return []");
    expect(section).toContain("prevSnaps.filter(row => !activeIds.has(Number(row.account_id)))");
    expect(section).toContain("for (const row of allActivities)");
    expect(section).toContain("period_debit: 0, period_credit: 0, entry_count: 0");
  });
  it("does not swallow financial event insert failure before acknowledging outbox",()=>{
    const section=outbox.slice(outbox.indexOf("INSERT INTO financial_events"),outbox.indexOf("const ack=await delivery.execute"));
    expect(section).toContain("INSERT INTO financial_events");
    expect(section).not.toContain(".catch(");
    expect(outbox).toContain("SET status = 'pending', last_error");
  });
  it("persists checksum, audit and outbox on the transaction client before promotion",()=>{
    const section=accounting.slice(accounting.indexOf("async function persistAtomicPostingAudit"),accounting.indexOf("export async function postEntryWithClient"));
    expect(section).toContain("status='draft'");
    expect(section).toContain("INSERT INTO ledger_events");
    expect(section).toContain("INSERT INTO financial_outbox_events");
    expect(section).not.toContain("db.execute");
    expect(section).not.toContain(".catch(");
    expect(accounting.indexOf("await persistAtomicPostingAudit(client, input, entry);")).toBeLessThan(accounting.indexOf("// Promote entry from 'draft' to target status"));
  });

});
