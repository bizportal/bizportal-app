import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
const mocks=vi.hoisted(()=>({
  findPo:vi.fn(),finance:vi.fn(),list:vi.fn(),getInvoice:vi.fn(),create:vi.fn(),submit:vi.fn(),
  upload:vi.fn(),delete:vi.fn(),includeFile:false,
}));
vi.mock("../lib/services/mktVendorPoTokenService.js",()=>({findPoByVendorToken:mocks.findPo}));
vi.mock("@workspace/db",()=>({
  db:{select:vi.fn(()=>{throw Error("SHARED_DB_MUST_NOT_READ_FINANCE")})},
  withMarketplaceFinanceDevTransaction:mocks.finance,
  vendorInvoicesTable:{id:"id",mktPurchaseOrderId:"po",supplierId:"vendor"},
}));
vi.mock("../lib/uploadMiddleware.js",()=>({
  imagePdfUpload:()=>({single:()=> (req:any,_res:any,next:()=>void)=>{
    if(mocks.includeFile) req.file={buffer:Buffer.from("%PDF-1.4 test"),mimetype:"application/pdf",originalname:"vendor.pdf",size:13};
    next();
  }}),
  sanitizeFilename:(name:string)=>name,
}));
vi.mock("../lib/uploadValidation.js",()=>({validateMagicBytes:()=>({ok:true})}));
vi.mock("../lib/objectStorage.js",()=>({ObjectStorageService:class{uploadPrivateEntity=mocks.upload;tryDeletePrivateEntity=mocks.delete}}));
vi.mock("../lib/middleware/validateBody.js",()=>({validateBody:()=> (_req:any,_res:any,next:()=>void)=>next()}));
vi.mock("../middlewares/securityRateLimiter.js",()=>({tokenGetRateLimiter:(_req:any,_res:any,next:()=>void)=>next(),tokenPostRateLimiter:(_req:any,_res:any,next:()=>void)=>next()}));
vi.mock("../lib/services/mktVendorInvoiceService.js",()=>({
  createMarketplaceVendorInvoice:mocks.create,
  getMarketplaceVendorInvoice:mocks.getInvoice,
  safeMarketplaceVendorInvoiceView:(invoice:any,lines:any[])=>({id:invoice.id,lines}),
  submitMarketplaceVendorInvoice:mocks.submit,
}));
vi.mock("../lib/logger.js",()=>({logger:{warn:vi.fn(),info:vi.fn()}}));
import router from "./mktVendorInvoice";
let server:Server;let base:string;
const po={id:12,companyId:1,vendorId:5,vendorNameSnapshot:"DEV Vendor"};
const invoice={id:77,companyId:1,supplierId:5,mktPurchaseOrderId:12,status:"draft"};
const scopedDb={
  select:()=>({from:()=>({where:()=>({orderBy:async()=>[invoice]})})}),
};
beforeAll(async()=>{
  const app=express();app.use(express.json());
  app.use("/api/mkt/vendor-invoice",router);
  server=app.listen(0);
  await new Promise<void>(resolve=>server.once("listening",resolve));
  base="http://127.0.0.1:"+(server.address() as AddressInfo).port;
});
afterAll(async()=>{await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()))});
beforeEach(()=>{
  for(const [key,value] of Object.entries(mocks))if(typeof value==="function")value.mockReset();
  mocks.includeFile=false;
  mocks.findPo.mockResolvedValue({ok:true,po});
  mocks.finance.mockImplementation(async (companyId:number,work:(scoped:any)=>Promise<unknown>)=>{
    expect(companyId).toBe(1);
    return work(scopedDb);
  });
  mocks.getInvoice.mockResolvedValue({invoice,lines:[]});
  mocks.upload.mockResolvedValue("private/dev-test.pdf");
  mocks.create.mockResolvedValue({ok:true,invoice,lines:[],alreadyExists:false});
  mocks.submit.mockResolvedValue({ok:true,invoice,lines:[],match:{ok:true,status:"passed"},alreadyExists:false});
  mocks.delete.mockResolvedValue(undefined);
});
describe("DEV vendor token invoice is restricted to Finance transaction",()=>{
  it("lists invoice using the dedicated tenant session, not the privileged shared DB",async()=>{
    const res=await fetch(base+"/api/mkt/vendor-invoice/valid-token/invoices");
    expect(res.status).toBe(200);
    expect(mocks.finance).toHaveBeenCalledOnce();
    expect(mocks.findPo).toHaveBeenCalledTimes(2);
    expect(mocks.getInvoice).toHaveBeenCalledWith(77,scopedDb);
  });
  it("rejects token rotation between initial lookup and Finance transaction",async()=>{
    mocks.findPo.mockResolvedValueOnce({ok:true,po})
      .mockResolvedValueOnce({ok:false,code:"NOT_FOUND"});
    const res=await fetch(base+"/api/mkt/vendor-invoice/rotated-token/invoices");
    expect(res.status).toBe(404);
    expect(mocks.getInvoice).not.toHaveBeenCalled();
  });
  it("does not upload vendor proof when dedicated Finance credential is unavailable",async()=>{
    mocks.includeFile=true;
    mocks.finance.mockRejectedValue(new Error("DEV_FINANCE_CREDENTIAL_NOT_CONFIGURED"));
    const res=await fetch(base+"/api/mkt/vendor-invoice/valid-token",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({grId:9,vendorInvoiceRef:"DEVTOKEN",invoiceDate:"2026-11-15",
        currency:"IDR",totalAmount:100,taxAmount:0,grandTotal:100,
        lines:JSON.stringify([{poLineId:6,quantity:1,unitPrice:100,subtotal:100}])}),
    });
    expect(res.status).toBe(503);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("creates a vendor invoice only with the same restricted session and verified PO scope",async()=>{
    mocks.includeFile=true;
    const res=await fetch(base+"/api/mkt/vendor-invoice/valid-token",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({grId:9,vendorInvoiceRef:"DEVTOKEN",invoiceDate:"2026-11-15",
        currency:"IDR",totalAmount:100,taxAmount:0,grandTotal:100,
        lines:JSON.stringify([{poLineId:6,quantity:1,unitPrice:100,subtotal:100}])}),
    });
    expect(res.status).toBe(201);
    expect(mocks.finance).toHaveBeenCalledTimes(2);
    expect(mocks.findPo).toHaveBeenCalledTimes(3);
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(mocks.create.mock.calls[0][2]).toBe(scopedDb);
    expect(mocks.create.mock.calls[0][0].vendorToken).toBe("valid-token");
  });
  it("cleans uploaded proof if vendor token rotates before canonical create",async()=>{
    mocks.includeFile=true;
    mocks.findPo.mockResolvedValueOnce({ok:true,po})
      .mockResolvedValueOnce({ok:true,po})
      .mockResolvedValueOnce({ok:false,code:"NOT_FOUND"});
    const res=await fetch(base+"/api/mkt/vendor-invoice/rotated-token",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({grId:9,vendorInvoiceRef:"DEV-ROTATED",invoiceDate:"2026-11-15",
        currency:"IDR",totalAmount:100,taxAmount:0,grandTotal:100,
        lines:JSON.stringify([{poLineId:6,quantity:1,unitPrice:100,subtotal:100}])}),
    });
    expect(res.status).toBe(404);
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(mocks.delete).toHaveBeenCalledWith("private/dev-test.pdf");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("passes the same scoped transaction to the canonical vendor invoice submit",async()=>{
    const res=await fetch(base+"/api/mkt/vendor-invoice/valid-token/invoices/77/submit",{
      method:"POST",headers:{"Content-Type":"application/json"},body:"{}",
    });
    expect(res.status).toBe(200);
    expect(mocks.findPo).toHaveBeenCalledTimes(2);
    expect(mocks.getInvoice).toHaveBeenCalledWith(77,scopedDb);
    expect(mocks.submit.mock.calls[0][2]).toBe(scopedDb);
  });
});
