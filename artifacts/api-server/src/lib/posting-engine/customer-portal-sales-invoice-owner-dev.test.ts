import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
const m=vi.hoisted(()=>({post:vi.fn()}));
vi.mock("./index.js",()=>({getPostingEngine:()=>({post:m.post})}));
import {postCustomerPortalSalesInvoiceWithExistingOwner} from "./customer-portal-sales-invoice-owner-dev";

const flag="CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV";
const proofFlag="CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV";
const old={app:process.env.APP_ENV,flag:process.env[flag],proof:process.env[proofFlag]};
const row=(companyId=1,tax=0)=>({
  id:91,company_id:companyId,invoice_status:"invoiced",
  invoice_number:"INV-QA-91",invoice_date:"2026-11-18",due_date:"2026-12-18",
  total_amount:String(100-tax),tax_amount:String(tax),
  grand_total:"100",amount_paid:"0",
});
const invoice=(companyId=1)=>({
 id:91,company_id:companyId,invoice_status:"invoiced",
 invoice_number:"INV-QA-91",invoice_date:"2026-11-18",
 due_date:"2026-12-18",total_amount:"100",grand_total:"100",amount_paid:"0",
 // Tax deliberately missing: Portal INVOICE_COLUMNS never selects tax_amount.
});
function fake(companyId=1,tax=0){
 const calls:string[]=[];
 const c={
  query:vi.fn(async(statement:string,params?:unknown[])=>{
   const q=String(statement);
   calls.push(q);
   if(q.includes("from public.sales_documents"))return {rows:[row(companyId,tax)]};
   if(q.includes("from public.accounting_settings"))return {rows:[{journal:companyId+20,ar:101,revenue:202}]};
   throw Error("UNEXPECTED_SQL_TEST_QUERY");
  }),
 };
 return {client:c,calls};
}
function args(companyId=1,tax=0){
 const {client,calls}=fake(companyId,tax);
 return {client,calls,input:{
   transactionClient:client as any,
   query:(statement:string,params?:unknown[])=>client.query(statement,params),
   companyId,source:"sales_invoice" as const,sourceId:91,
   invoice:invoice(companyId) as any,actorId:99,
 }};
}
const post=async(arg:ReturnType<typeof args>)=>
  postCustomerPortalSalesInvoiceWithExistingOwner(arg.input);
beforeEach(()=>{
  process.env.APP_ENV="development";
  process.env[flag]="true";
  process.env[proofFlag]="true";
  m.post.mockReset().mockResolvedValue({ok:true,entryId:77});
});
afterEach(()=>{
  for(const [key,value] of [["APP_ENV",old.app],[flag,old.flag],[proofFlag,old.proof]] as const){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
});
describe("canonical existing posting owner injected into Customer Portal's PG client",()=>{
 it.each([1,3])("reuses company %i accounting settings and same transaction with tax field absent from Portal response",async company=>{
   const a=args(company);
   await expect(post(a)).resolves.toEqual({posted:true,entryId:77});
   expect(a.client.query).toHaveBeenCalledTimes(2);
   expect(a.calls[0]).toContain("for update");
   expect(m.post).toHaveBeenCalledTimes(1);
   const [request,drizzleTx]=m.post.mock.calls[0]!;
   expect(request).toMatchObject({
      companyId:company,source:"sales_invoice",sourceId:91,
      journalId:company+20,journalCode:"SAL",
      ref:"INV-QA-91",createdById:"99",
      lines:[
       {accountId:101,debit:100,credit:0},
       {accountId:202,debit:0,credit:100},
      ],
   });
   expect(drizzleTx).toHaveProperty("execute");
   expect(drizzleTx).toHaveProperty("insert");
 });
 it("posts using the locked database invoice date rather than potentially stale application data",async()=>{
   const a=args(1);
   (a.input.invoice as any).invoice_date="2026-10-01";
   (a.input.invoice as any).due_date="2026-11-01";
   await expect(post(a)).resolves.toEqual({posted:true,entryId:77});
   const [request]=m.post.mock.calls[0]!;
   expect(request.date).toEqual(new Date("2026-11-18"));
 });
 it("rejects a locked database row with a mismatched invoice identity",async()=>{
   const a=args(1);
   a.client.query.mockResolvedValueOnce({rows:[{...row(),id:92}]});
   await expect(post(a)).rejects.toThrow("DEV_SALES_POSTING_SOURCE_MISMATCH");
   expect(m.post).not.toHaveBeenCalled();
 });
 it("rejects missing accounting dates in the locked invoice",async()=>{
   const a=args(1);
   a.client.query.mockResolvedValueOnce({rows:[{...row(),invoice_date:""}]});
   await expect(post(a)).rejects.toThrow("DEV_SALES_POSTING_SOURCE_MISMATCH");
   expect(m.post).not.toHaveBeenCalled();
 });
 it("rejects nonzero tax from LOCKED DB even if the Portal response does not carry tax_amount",async()=>{
   const a=args(1,11);
   await expect(post(a)).rejects.toThrow("DEV_SALES_POSTING_FINANCIAL_TOTAL_INVALID");
   expect(m.post).not.toHaveBeenCalled();
 });
 it("rejects taxable invoices even when the rest of the original DB amounts match",async()=>{
   const a=args(1,11);
   (a.input.invoice as any).total_amount="89";
   await expect(post(a)).rejects.toThrow("DEV_SALES_POSTING_TAX_NOT_READY");
   expect(m.post).not.toHaveBeenCalled();
 });
 it.each([
  ["unknown company",2],
  ["other company",4],
 ])("rejects %s before any database access",async(_label,company)=>{
   const a=args(company);
   await expect(post(a)).rejects.toThrow("DEV_SALES_POSTING_INVOICE_SCOPE_INVALID");
   expect(a.client.query).not.toHaveBeenCalled();
   expect(m.post).not.toHaveBeenCalled();
 });
 it("rejects a changed invoice company in locked database row",async()=>{
   const a=args(1);
   a.client.query.mockResolvedValueOnce({rows:[row(3,0)]});
   await expect(post(a)).rejects.toThrow("DEV_SALES_POSTING_SOURCE_MISMATCH");
   expect(m.post).not.toHaveBeenCalled();
 });
 it("rejects an invoice number modified after the Portal update",async()=>{
   const a=args(1);
   a.client.query.mockResolvedValueOnce({rows:[{...row(),invoice_number:"INV-OTHER"}]});
   await expect(post(a)).rejects.toThrow("DEV_SALES_POSTING_SOURCE_MISMATCH");
   expect(m.post).not.toHaveBeenCalled();
 });
 it("rejects a missing or ambiguous existing invoice row",async()=>{
   const a=args(1);
   a.client.query.mockResolvedValueOnce({rows:[]});
   await expect(post(a)).rejects.toThrow("DEV_SALES_POSTING_SOURCE_MISMATCH");
   expect(m.post).not.toHaveBeenCalled();
 });
 it("rejects missing or ambiguous company settings",async()=>{
   const a=args(1);
   a.client.query.mockResolvedValueOnce({rows:[row()]})
      .mockResolvedValueOnce({rows:[]});
   await expect(post(a)).rejects.toThrow("DEV_SALES_POSTING_SETTINGS_MISSING");
   expect(m.post).not.toHaveBeenCalled();
 });
 it("does not convert a failed original posting engine into an issued invoice",async()=>{
   const a=args(1);
   m.post.mockResolvedValueOnce({ok:false,errorCode:"PERIOD_CLOSED"});
   await expect(post(a)).rejects.toThrow("DEV_SALES_POSTING_OWNER_REJECTED");
 });
 it("does not trust the engine returning success without a journal entry ID",async()=>{
   const a=args(1);
   m.post.mockResolvedValueOnce({ok:true,entryId:0});
   await expect(post(a)).rejects.toThrow("DEV_SALES_POSTING_OWNER_REJECTED");
 });
 it.each(["production","staging"])("never enables original posting in %s",async app=>{
   const a=args(1);
   process.env.APP_ENV=app;
   await expect(post(a)).rejects.toThrow("DEV_SALES_POSTING_NOT_ENABLED");
   expect(a.client.query).not.toHaveBeenCalled();
   expect(m.post).not.toHaveBeenCalled();
 });
 it("both existing feature flags must be ON",async()=>{
   const a=args(1);
   delete process.env[proofFlag];
   await expect(post(a)).rejects.toThrow("DEV_SALES_POSTING_NOT_ENABLED");
   delete process.env[flag];
   await expect(post(a)).rejects.toThrow("DEV_SALES_POSTING_NOT_ENABLED");
   expect(m.post).not.toHaveBeenCalled();
 });
 it("never posts on wrong source identity",async()=>{
   const a=args(1);
   a.input.sourceId=92;
   await expect(post(a)).rejects.toThrow("DEV_SALES_POSTING_INVOICE_SCOPE_INVALID");
   expect(m.post).not.toHaveBeenCalled();
 });
});
