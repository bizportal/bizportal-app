import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
const m=vi.hoisted(()=>({
  postCore:vi.fn(),warn:vi.fn(),error:vi.fn(),globalDb:{execute:vi.fn()},
}));
vi.mock("@workspace/db",()=>({db:m.globalDb,chartOfAccountsTable:{}}));
vi.mock("../accounting.js",()=>({postEntryWithClient:m.postCore}));
vi.mock("../logger.js",()=>({logger:{warn:m.warn,error:m.error}}));
import {CanonicalPostingEngine} from "./CanonicalPostingEngine";
import type {PostingRequest} from "./types";

const FLAGS=[
  "APP_ENV","CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV",
  "CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV","CUSTOMER_PORTAL_TAX_ATOMIC_POST_DEV",
];
const old=Object.fromEntries(FLAGS.map(k=>[k,process.env[k]]));
const original=()=>({
  companyId:1,journalId:5,journalCode:"SAL",date:new Date("2026-11-18"),
  source:"sales_invoice",sourceId:91,ref:"INV-QA-91",createdById:"qa-super-admin",
  lines:[
    {accountId:501,debit:111,credit:0},
    {accountId:502,debit:0,credit:100},
    {accountId:503,debit:0,credit:11},
  ],
  taxes:[{taxType:"PPN_OUT",baseAmount:100,taxAmount:11,rate:11,glAccountId:503}],
}) as PostingRequest;
const client=()=>({
  execute:vi.fn().mockResolvedValueOnce({rows:[]})
    .mockResolvedValueOnce({rows:[{id:701}]}),
});
const engine=()=>new CanonicalPostingEngine([]);
beforeEach(()=>{
  vi.clearAllMocks();
  process.env.APP_ENV="development";
  process.env.CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV="true";
  process.env.CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV="true";
  process.env.CUSTOMER_PORTAL_TAX_ATOMIC_POST_DEV="true";
  m.postCore.mockResolvedValue({id:77,status:"posted"});
});
afterEach(()=>{
  for(const flag of FLAGS){
    if(old[flag]===undefined)delete process.env[flag];
    else process.env[flag]=old[flag];
  }
});
describe("canonical owner scoped DEV PPN_OUT on original same transaction client",()=>{
  it("runs original GL owner then records exactly one PPN tax metadata in caller transaction",async()=>{
    const txn=client();
    const result=await engine().post(original(),txn as any);
    expect(result).toEqual({ok:true,entryId:77});
    expect(m.postCore).toHaveBeenCalledTimes(1);
    expect(m.postCore.mock.calls[0][0]).toBe(txn);
    expect(m.postCore.mock.calls[0][1].lines).toHaveLength(3);
    expect(txn.execute).toHaveBeenCalledTimes(2);
    const statements=txn.execute.mock.calls.map(([query])=>JSON.stringify(query));
    expect(statements[0]).toContain("gl_tax_lines");
    expect(statements[1]).toContain("gl_tax_lines");
    expect(statements[1]).toContain("PPN_OUT");
    expect(statements[1]).toContain("sales_invoice");
    expect(m.globalDb.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["tax flag OFF",()=>delete process.env.CUSTOMER_PORTAL_TAX_ATOMIC_POST_DEV],
    ["atomic bridge OFF",()=>delete process.env.CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV],
    ["AR proof OFF",()=>delete process.env.CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV],
    ["APP_ENV PROD",()=>{process.env.APP_ENV="production";}],
  ])("retains global tax rejection when %s",async(_name,change)=>{
    change();
    const txn=client();
    const result=await engine().post(original(),txn as any);
    expect(result.ok).toBe(false);
    expect(m.postCore).not.toHaveBeenCalled();
    expect(txn.execute).not.toHaveBeenCalled();
  });

  it("refuses scoped tax on the global DB client; no fire-and-forget side effects",async()=>{
    const result=await engine().post(original(),m.globalDb as any);
    expect(result.ok).toBe(false);
    expect(m.postCore).not.toHaveBeenCalled();
  });
  it.each([
    ["wrong source",{source:"vendor_invoice"}],
    ["wrong company",{companyId:2}],
    ["draft status",{initialStatus:"draft"}],
    ["different tax type",{taxes:[{taxType:"PPH21",baseAmount:100,taxAmount:11,rate:11,glAccountId:503}]}],
    ["wrong rate",{taxes:[{taxType:"PPN_OUT",baseAmount:100,taxAmount:11,rate:12,glAccountId:503}]}],
    ["wrong tax GL account",{taxes:[{taxType:"PPN_OUT",baseAmount:100,taxAmount:11,rate:11,glAccountId:999}]}],
    ["mismatched gross line",{lines:[{accountId:501,debit:110,credit:0},{accountId:502,debit:0,credit:100},{accountId:503,debit:0,credit:11}]}],
  ])("refuses %s without calling original journal writer",async(_name,changes)=>{
    const txn=client(),r={...original(),...changes} as PostingRequest;
    const res=await engine().post(r,txn as any);
    expect(res.ok).toBe(false);
    expect(m.postCore).not.toHaveBeenCalled();
    expect(txn.execute).not.toHaveBeenCalled();
  });
  it("refuses pre-existing PPN metadata rather than inserting a second record",async()=>{
    const txn={execute:vi.fn().mockResolvedValue({rows:[{id:90}]})};
    const result=await engine().post(original(),txn as any);
    expect(result.ok).toBe(false);
    expect(txn.execute).toHaveBeenCalledTimes(1);
  });
  it("returns failure on tax insert error so caller's transaction can roll back the GL",async()=>{
    const txn={execute:vi.fn().mockResolvedValueOnce({rows:[]})
      .mockRejectedValueOnce(Error("QA_FORCED_TAX_INSERT_FAILURE"))};
    const result=await engine().post(original(),txn as any);
    expect(result).toMatchObject({ok:false,errorCode:"TRANSACTION_FAILED"});
    expect(m.postCore).toHaveBeenCalledTimes(1);
    expect(txn.execute).toHaveBeenCalledTimes(2);
  });
  it("rejects unverified metadata INSERT receipt",async()=>{
    const txn={execute:vi.fn().mockResolvedValueOnce({rows:[]})
      .mockResolvedValueOnce({rows:[]})};
    const result=await engine().post(original(),txn as any);
    expect(result.ok).toBe(false);
  });
  it("preserves existing zero-tax journal behavior without new queries",async()=>{
    process.env.APP_ENV="production";
    const txn=client();
    const source=original();
    delete source.taxes;
    source.lines=[
      {accountId:501,debit:100,credit:0},
      {accountId:502,debit:0,credit:100},
    ];
    const result=await engine().post(source,txn as any);
    expect(result).toEqual({ok:true,entryId:77});
    expect(m.postCore).toHaveBeenCalledTimes(1);
    expect(txn.execute).not.toHaveBeenCalled();
  });
});
