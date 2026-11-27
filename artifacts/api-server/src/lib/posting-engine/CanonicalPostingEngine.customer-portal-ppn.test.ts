import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
const m=vi.hoisted(()=>({
  postCore:vi.fn(),warn:vi.fn(),error:vi.fn(),globalDb:{execute:vi.fn()},
}));
vi.mock("@workspace/db",()=>({db:m.globalDb,chartOfAccountsTable:{}}));
vi.mock("../accounting.js",()=>({postEntryWithClient:m.postCore}));
vi.mock("../logger.js",()=>({logger:{warn:m.warn,error:m.error}}));
import {CanonicalPostingEngine} from "./CanonicalPostingEngine";
import type {PostingRequest} from "./types";

const KEYS=["APP_ENV","CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV",
 "CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV","CUSTOMER_PORTAL_TAX_ATOMIC_POST_DEV"];
const saved=Object.fromEntries(KEYS.map(k=>[k,process.env[k]]));
const source=()=>({
  companyId:1,journalId:5,journalCode:"SAL",date:new Date("2026-11-18"),
  source:"sales_invoice",sourceId:91,ref:"INV-QA-91",createdById:"qa-super-admin",
  lines:[
    {accountId:501,debit:111,credit:0},
    {accountId:502,debit:0,credit:100},
    {accountId:503,debit:0,credit:11},
  ],
  taxes:[{taxType:"PPN_OUT",baseAmount:100,taxAmount:11,glAccountId:503}],
}) as PostingRequest;
beforeEach(()=>{
  vi.clearAllMocks();
  process.env.APP_ENV="development";
  process.env.CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV="true";
  process.env.CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV="true";
  process.env.CUSTOMER_PORTAL_TAX_ATOMIC_POST_DEV="true";
  m.postCore.mockResolvedValue({id:77,status:"posted"});
});
afterEach(()=>{for(const k of KEYS){
  if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];
}});
describe("original CanonicalPostingEngine v1 tax rejection must remain byte-identical",()=>{
  it.each(["development","production"])("still rejects request.taxes in %s, even with DEV flags enabled",async app=>{
    process.env.APP_ENV=app;
    const transaction={execute:vi.fn()};
    const result=await new CanonicalPostingEngine([]).post(source(),transaction as any);
    expect(result).toMatchObject({ok:false,errorCode:"TRANSACTION_FAILED"});
    expect(m.postCore).not.toHaveBeenCalled();
    expect(transaction.execute).not.toHaveBeenCalled();
    expect(m.globalDb.execute).not.toHaveBeenCalled();
  });
  it("keeps zero-tax original posting unchanged, with no tax metadata side effects",async()=>{
    const transaction={execute:vi.fn()};
    const request=source();
    delete request.taxes;
    request.lines=[
      {accountId:501,debit:100,credit:0},
      {accountId:502,debit:0,credit:100},
    ];
    const result=await new CanonicalPostingEngine([]).post(request,transaction as any);
    expect(result).toEqual({ok:true,entryId:77});
    expect(m.postCore).toHaveBeenCalledTimes(1);
    expect(m.postCore.mock.calls[0][0]).toBe(transaction);
    expect(transaction.execute).not.toHaveBeenCalled();
  });
  it("preserves rejection for other tax types and multiple lines",async()=>{
    const req=source();
    req.taxes=[{taxType:"PPH21",baseAmount:100,taxAmount:3}];
    const transaction={execute:vi.fn()};
    const result=await new CanonicalPostingEngine([]).post(req,transaction as any);
    expect(result.ok).toBe(false);
    expect(m.postCore).not.toHaveBeenCalled();
  });
});
