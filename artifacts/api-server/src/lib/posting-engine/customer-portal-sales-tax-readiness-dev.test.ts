import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {inspectCustomerInvoiceTaxReadinessDev} from "./customer-portal-sales-tax-readiness-dev";

const ORIGINAL=process.env.APP_ENV;
const fixture=(companyId=1,taxAmount=11)=>({
  id:91,company_id:companyId,total_amount:"100",
  tax_amount:String(taxAmount),grand_total:String(100+taxAmount),
  tax_rate_id:companyId===1?1:9,tax_treatment:"exclusive",
});
const setup=(companyId=1)=>({
  default_sales_tax_id:companyId===1?1:9,
  default_tax_company:companyId,default_tax_kind:"sale",
  default_tax_cut_type:"self_borne",default_tax_active:true,
  ppn_output_account_id:companyId===1?49109:49199,
  output_account_company:companyId,output_account_type:"liability",
  output_account_status:"ACTIVE",output_account_active:true,
  output_account_postable:true,
});
const selected=(companyId=1)=>({
  id:companyId===1?1:9,company_id:companyId,
  kind:"sale",cut_type:"self_borne",
  rate:"11.000",is_active:true,account_id:companyId===1?49109:49199,
});
function mockRead(rows:Record<string,unknown>[] = [fixture(),setup(),selected()]) {
  const query=vi.fn(async(statement:string)=>{
    if(/^\s*(insert|update|delete|create|alter|drop|begin|commit|rollback)\b/i.test(statement))
      throw Error("READ_ONLY_REQUIRED");
    const current=rows.shift();
    return {rows:current?[current]:[]};
  });
  return query;
}
beforeEach(()=>{process.env.APP_ENV="development";});
afterEach(()=>{
  if(ORIGINAL===undefined)delete process.env.APP_ENV;
  else process.env.APP_ENV=ORIGINAL;
});
describe("original Accounting owner: PPN preflight must be read-only and never activate tax posting",()=>{
  it("returns zero-tax without querying any Accounting tax mapping",async()=>{
    const read=mockRead([fixture(1,0)]);
    const r=await inspectCustomerInvoiceTaxReadinessDev({read,companyId:1,invoiceId:91});
    expect(r).toMatchObject({eligible:false,code:"ZERO_TAX"});
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("keeps company1 matching active default 11% fail closed until engine tax implementation",async()=>{
    const read=mockRead();
    const r=await inspectCustomerInvoiceTaxReadinessDev({read,companyId:1,invoiceId:91});
    expect(r).toMatchObject({
      companyId:1,invoiceId:91,eligible:false,code:"CANONICAL_TAX_POSTING_NOT_READY",
    });
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls.every(x=>x[0].trim().toLowerCase().startsWith("select"))).toBe(true);
  });
  it("detects real Diva mismatch: company3 default tax points to company1",async()=>{
    const invalidDiva={...setup(3),default_sales_tax_id:1,default_tax_company:1};
    const read=mockRead([fixture(3),invalidDiva]);
    const r=await inspectCustomerInvoiceTaxReadinessDev({read,companyId:3,invoiceId:91});
    expect(r.code).toBe("DEFAULT_SALES_TAX_COMPANY_MISMATCH");
    expect(r.eligible).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("does not select Diva's 11% or 12% alternative automatically",async()=>{
    const read=mockRead([fixture(3),setup(3),selected(3)]);
    const r=await inspectCustomerInvoiceTaxReadinessDev({read,companyId:3,invoiceId:91});
    expect(r.code).toBe("CANONICAL_TAX_POSTING_NOT_READY");
    expect(r.eligible).toBe(false);
  });
  it("refuses missing or foreign Invoice tax_rate_id",async()=>{
    const absent=mockRead([{...fixture(),tax_rate_id:null},setup()]);
    expect((await inspectCustomerInvoiceTaxReadinessDev({
      read:absent,companyId:1,invoiceId:91,
    })).code).toBe("INVOICE_TAX_RATE_REQUIRED");
    const foreign=mockRead([fixture(),setup(),{...selected(),company_id:3}]);
    expect((await inspectCustomerInvoiceTaxReadinessDev({
      read:foreign,companyId:1,invoiceId:91,
    })).code).toBe("INVOICE_TAX_RATE_COMPANY_MISMATCH");
  });
  it("refuses cross-company PPN output account and tax account mismatch",async()=>{
    const crossCoa=mockRead([fixture(),{...setup(),output_account_company:3}]);
    expect((await inspectCustomerInvoiceTaxReadinessDev({
      read:crossCoa,companyId:1,invoiceId:91,
    })).code).toBe("OUTPUT_TAX_ACCOUNT_INVALID");
    const differentAccount=mockRead([fixture(),setup(),{...selected(),account_id:49199}]);
    expect((await inspectCustomerInvoiceTaxReadinessDev({
      read:differentAccount,companyId:1,invoiceId:91,
    })).code).toBe("INVOICE_TAX_RATE_ACCOUNT_MISMATCH");
  });
  it("blocks inactive/other-purpose default tax even when owned by company",async()=>{
    const invalid=mockRead([fixture(),{...setup(),default_tax_active:false}]);
    expect((await inspectCustomerInvoiceTaxReadinessDev({
      read:invalid,companyId:1,invoiceId:91,
    })).code).toBe("DEFAULT_SALES_TAX_INACTIVE");
  });
  it("does not silently prefer an override rate without explicit approval",async()=>{
    const unexpected=mockRead([fixture(),setup(),{...selected(),id:144}]);
    expect((await inspectCustomerInvoiceTaxReadinessDev({
      read:unexpected,companyId:1,invoiceId:91,
    })).code).toBe("INVOICE_TAX_RATE_REQUIRED");
    const invoiceOverride=mockRead([{...fixture(),tax_rate_id:144},setup(),{...selected(),id:144}]);
    expect((await inspectCustomerInvoiceTaxReadinessDev({
      read:invoiceOverride,companyId:1,invoiceId:91,
    })).code).toBe("INVOICE_TAX_RATE_NOT_DEFAULT");
  });
  it("requires an explicit recognised Invoice tax treatment",async()=>{
    const noTreatment=mockRead([{...fixture(),tax_treatment:null},setup(),selected()]);
    expect((await inspectCustomerInvoiceTaxReadinessDev({
      read:noTreatment,companyId:1,invoiceId:91,
    })).code).toBe("INVOICE_TAX_TREATMENT_REVIEW");
  });
  it("rejects incorrect gross=net+tax and never writes to database",async()=>{
    const read=mockRead([{...fixture(),grand_total:"120"}]);
    expect((await inspectCustomerInvoiceTaxReadinessDev({
      read,companyId:1,invoiceId:91,
    })).code).toBe("INVALID_FINANCIAL_AMOUNTS");
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("cannot run preflight for unknown companies, missing source, or production",async()=>{
    const read=mockRead();
    expect((await inspectCustomerInvoiceTaxReadinessDev({
      read,companyId:2,invoiceId:91,
    })).code).toBe("INVALID_SOURCE");
    process.env.APP_ENV="production";
    expect((await inspectCustomerInvoiceTaxReadinessDev({
      read,companyId:1,invoiceId:91,
    })).code).toBe("NOT_DEV");
    expect(read).not.toHaveBeenCalled();
  });
});
