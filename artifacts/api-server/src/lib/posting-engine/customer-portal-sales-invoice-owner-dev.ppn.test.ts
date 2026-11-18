import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
const m=vi.hoisted(()=>({post:vi.fn()}));
vi.mock("./index.js",()=>({getPostingEngine:()=>({post:m.post})}));
import {postCustomerPortalSalesInvoiceWithExistingOwner} from "./customer-portal-sales-invoice-owner-dev";

const FLAGS=["APP_ENV","CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV",
  "CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV",
  "CUSTOMER_PORTAL_TAX_ATOMIC_POST_DEV"];
const old=Object.fromEntries(FLAGS.map(k=>[k,process.env[k]]));
function fixture(companyId=1,rate=11){
  const tax=rate,net=100,gross=net+tax;
  const rateId=companyId===1?1:rate===11?9:144;
  const ppnAccount=companyId===1?49109:49199;
  const source={
    id:91,company_id:companyId,invoice_status:"invoiced",
    invoice_number:"INV-QA-91",invoice_date:"2026-11-18",due_date:"2026-12-18",
    total_amount:String(net),tax_amount:String(tax),
    grand_total:String(gross),amount_paid:"0",tax_rate_id:rateId,
    tax_treatment:"exclusive",
  };
  const settings={
    journal:companyId+20,ar:101,revenue:202,
    default_tax_id:rateId,ppn_output_account:ppnAccount,
    rate_company:companyId,rate_id:rateId,rate_percent:String(rate),
    rate_account:ppnAccount,rate_kind:"sale",rate_cut_type:"self_borne",
    rate_active:true,ppn_company:companyId,ppn_type:"liability",
    ppn_status:"ACTIVE",ppn_active:true,ppn_postable:true,
  };
  const invoice={
    id:91,company_id:companyId,invoice_status:"invoiced",
    invoice_number:"INV-QA-91",invoice_date:"2026-11-18",
    due_date:"2026-12-18",total_amount:String(net),
    grand_total:String(gross),amount_paid:"0",
  };
  const sqls:string[]=[];
  const client={query:vi.fn(async(q:string)=>{
    sqls.push(q);
    if(q.includes("from public.sales_documents"))return {rows:[source]};
    if(q.includes("from public.accounting_settings"))return {rows:[settings]};
    throw Error("UNEXPECTED_QA_SQL");
  })};
  const input={
    transactionClient:client as any,
    query:(sql:string,params?:unknown[])=>client.query(sql),
    companyId,source:"sales_invoice" as const,sourceId:91,
    invoice:invoice as any,actorId:"qa-bizportal-super-admin",
  };
  return {source,settings,invoice,client,input,sqls};
}
beforeEach(()=>{
  vi.clearAllMocks();
  process.env.APP_ENV="development";
  process.env.CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV="true";
  process.env.CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV="true";
  process.env.CUSTOMER_PORTAL_TAX_ATOMIC_POST_DEV="true";
  m.post.mockResolvedValue({ok:true,entryId:77});
});
afterEach(()=>{for(const k of FLAGS){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}});
describe("original CanonicalPostingEngine DEV-only PPN adapter tenant+rate checks",()=>{
  it.each([[1,11],[3,11],[3,12]])("posts explicit company %i rate %i only with 3 balanced GL lines and tax metadata",async(company,rate)=>{
    const x=fixture(company,rate);
    await expect(postCustomerPortalSalesInvoiceWithExistingOwner(x.input)).resolves.toEqual({
      posted:true,entryId:77,
    });
    expect(x.client.query).toHaveBeenCalledTimes(2);
    expect(x.sqls[0]).toContain("for update");
    expect(m.post).toHaveBeenCalledTimes(1);
    const [request]=m.post.mock.calls[0];
    expect(request).toMatchObject({
      companyId:company,source:"sales_invoice",sourceId:91,
      createdById:"qa-bizportal-super-admin",
      lines:[
        {accountId:101,debit:100+rate,credit:0},
        {accountId:202,debit:0,credit:100},
        {accountId:company===1?49109:49199,debit:0,credit:rate},
      ],
      taxes:[{
        taxType:"PPN_OUT",baseAmount:100,taxAmount:rate,
        rate,glAccountId:company===1?49109:49199,
      }],
    });
  });
  it("rejects positive tax unless dedicated DEV flag explicitly ON",async()=>{
    const x=fixture();
    delete process.env.CUSTOMER_PORTAL_TAX_ATOMIC_POST_DEV;
    await expect(postCustomerPortalSalesInvoiceWithExistingOwner(x.input))
      .rejects.toThrow("DEV_SALES_POSTING_TAX_NOT_READY");
    expect(m.post).not.toHaveBeenCalled();
  });
  it("refuses Diva default tax pointing to CST even though Diva has its own alternatives",async()=>{
    const x=fixture(3);
    x.settings.default_tax_id=1;
    x.settings.rate_id=1;
    x.settings.rate_company=1;
    await expect(postCustomerPortalSalesInvoiceWithExistingOwner(x.input))
      .rejects.toThrow("DEV_SALES_POSTING_TAX_SETTINGS_NOT_READY");
    expect(m.post).not.toHaveBeenCalled();
  });
  it.each([
    ["tax company differs",x=>{x.settings.rate_company=3;}],
    ["tax id differs from source",x=>{x.source.tax_rate_id=144;}],
    ["tax output account is another company",x=>{x.settings.ppn_company=3;}],
    ["tax account does not match mapped liability",x=>{x.settings.rate_account=999;}],
    ["tax rate inactive",x=>{x.settings.rate_active=false;}],
    ["tax treatment not exclusive",x=>{x.source.tax_treatment="inclusive";}],
    ["net/tax rounding mismatch",x=>{x.source.tax_amount="10.99";x.source.grand_total="110.99";x.invoice.grand_total="110.99";}],
  ])("blocks %s before CanonicalPostingEngine",async(_label,change)=>{
    const x=fixture(1);
    change(x);
    await expect(postCustomerPortalSalesInvoiceWithExistingOwner(x.input))
      .rejects.toThrow("DEV_SALES_POSTING_TAX_SETTINGS_NOT_READY");
    expect(m.post).not.toHaveBeenCalled();
  });
  it("remains fail-closed for production even with tax feature flag ON",async()=>{
    process.env.APP_ENV="production";
    const x=fixture(1);
    await expect(postCustomerPortalSalesInvoiceWithExistingOwner(x.input))
      .rejects.toThrow("DEV_SALES_POSTING_NOT_ENABLED");
    expect(m.post).not.toHaveBeenCalled();
  });
  it("does not turn original engine rejection into a successful financial posting",async()=>{
    const x=fixture(1);
    m.post.mockResolvedValueOnce({ok:false,errorCode:"TRANSACTION_FAILED"});
    await expect(postCustomerPortalSalesInvoiceWithExistingOwner(x.input))
      .rejects.toThrow("DEV_SALES_POSTING_OWNER_REJECTED");
  });
});
