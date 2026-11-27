import { describe,it,expect,vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const mock=vi.hoisted(()=>({transaction:vi.fn(),post:vi.fn(),lock:vi.fn(async()=>{}),emit:vi.fn()}));
vi.mock("@workspace/db",()=>({db:{transaction:mock.transaction}}));
vi.mock("../lib/accounting.js",()=>({postEntryWithClient:mock.post}));
vi.mock("../lib/posting-engine/validators.js",()=>({createDefaultValidators:()=>[]}));
vi.mock("../lib/logger.js",()=>({logger:{warn:vi.fn(),error:vi.fn()}}));
vi.mock("../lib/ledgerImmutability.js",()=>({lockAccountingEntry:mock.lock}));
vi.mock("../lib/events/financialEventBus.js",()=>({emitJournalCreated:mock.emit}));
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
    expect(mock.post.mock.calls[0]?.[0]).toBe(tx);
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
    const section=outbox.slice(outbox.indexOf("// Write to financial_events (idempotent)"),outbox.indexOf("// Also emit to in-memory event bus"));
    expect(section).toContain("INSERT INTO financial_events");
    expect(section).not.toContain(".catch(");
    expect(outbox).toContain("SET status = 'pending', last_error");
  });
});
