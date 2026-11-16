import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const mock = vi.hoisted(() => ({
  query: vi.fn(), auth: vi.fn(), dev: vi.fn(), companyId: 1 as number | null,
  role: "super_admin",
}));
vi.mock("@workspace/db", () => ({ pool: { query: mock.query } }));
vi.mock("./admin-auth", () => ({ authenticateAdmin: mock.auth }));
vi.mock("./dev-auth", () => ({ isDevelopmentEnvironment: mock.dev }));
import pdfRouter from "./dev-purchase-pdf";

let server: Server; let base: string;
const company = {
  id:1,company_name:"PT Cahaya Sejati Teknologi",name:"PT Cahaya Sejati Teknologi",
  company_code:"CST",address:"not official company address",phone:"123",email:"example@invalid.test",
};
const document = {
  id:55,doc_number:"PO-CST-55",kind:"order",status:"confirmed",
  supplier_name:"Vendor Synthetic",supplier_address:"Tangerang",
  created_at:"2026-11-15T00:00:00.000Z",grand_total:"300000",
  total_amount:"300000",tax_amount:"0",notes:"Synthetic test only",
};
const originalEnv={
  app:process.env.APP_ENV,
  flag:process.env.BIZPORTAL_DOCUMENT_TEMPLATES_ENABLED_DEV,
};
beforeAll(async () => {
  const app=express();app.use("/api",pdfRouter);
  server=app.listen(0);
  await new Promise<void>(resolve=>server.once("listening",resolve));
  base="http://127.0.0.1:"+(server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
  if(originalEnv.app===undefined)delete process.env.APP_ENV;else process.env.APP_ENV=originalEnv.app;
  if(originalEnv.flag===undefined)delete process.env.BIZPORTAL_DOCUMENT_TEMPLATES_ENABLED_DEV;
  else process.env.BIZPORTAL_DOCUMENT_TEMPLATES_ENABLED_DEV=originalEnv.flag;
});
beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_ENV="development";
  process.env.BIZPORTAL_DOCUMENT_TEMPLATES_ENABLED_DEV="true";
  mock.companyId=1;mock.role="super_admin";mock.dev.mockReturnValue(true);
  mock.auth.mockImplementation(async (req,res,next) => {
    if(req.headers.authorization!=="Bearer tested") {
      res.status(401).json({error:"Unauthorized"});return;
    }
    req.adminUser={email:"admin@example.invalid",id:"test",role:mock.role,companyId:mock.companyId};
    next();
  });
  mock.query.mockImplementation(async (sql:string) => {
    if(sql.includes("from public.companies"))return {rows:[company]};
    if(sql.includes("from public.purchase_documents"))return {rows:[document]};
    if(sql.includes("from public.purchase_document_lines"))
      return {rows:[{name:"Jasa Kirim",description:"Paket",quantity:"2",unit_cost:"150000",subtotal:"300000"}]};
    if(sql.includes("from public.app_config"))return {rows:[]};
    throw new Error("Unexpected database lookup");
  });
});
const url=(id:string,extra="")=>base+"/api/purchase/documents/"+id+"/pdf"+extra;
describe("original Purchase PDF restored for authenticated DEV and company-scoped data",()=>{
  it("returns a real A4 PDF binary from canonical PO data with no writes",async()=>{
    const response=await fetch(url("55"),{headers:{authorization:"Bearer tested"}});
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/pdf");
    expect(response.headers.get("content-disposition")).toContain("PO-CST-55.pdf");
    const bytes=Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0,5).toString()).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(1800);
    expect(mock.query.mock.calls.every(x=>!/^\s*(INSERT|UPDATE|DELETE|CREATE|DROP)/i.test(String(x[0])))).toBe(true);
    const poQuery=mock.query.mock.calls.find(x=>String(x[0]).includes("from public.purchase_documents"));
    expect(poQuery?.[1]).toEqual([55,1]);
  });
  it("requires signed Admin and refuses unverified or cross-company identities",async()=>{
    expect((await fetch(url("55"))).status).toBe(401);
    expect(mock.query).not.toHaveBeenCalled();
    mock.companyId=null;
    expect((await fetch(url("55"),{headers:{authorization:"Bearer tested"}})).status).toBe(403);
    expect(mock.query).not.toHaveBeenCalled();
    mock.companyId=1;
    expect((await fetch(url("55","?companyId=3"),{headers:{authorization:"Bearer tested"}})).status).toBe(403);
    expect(mock.query).not.toHaveBeenCalled();
  });
  it("never exposes PDF route on PROD or while document feature flag is off",async()=>{
    process.env.APP_ENV="production";
    expect((await fetch(url("55"),{headers:{authorization:"Bearer tested"}})).status).toBe(404);
    process.env.APP_ENV="development";
    process.env.BIZPORTAL_DOCUMENT_TEMPLATES_ENABLED_DEV="false";
    expect((await fetch(url("55"),{headers:{authorization:"Bearer tested"}})).status).toBe(404);
    expect(mock.auth).not.toHaveBeenCalled();
    expect(mock.query).not.toHaveBeenCalled();
  });
  it("rejects unknown PO and invalid document ID before PDF generation",async()=>{
    expect((await fetch(url("not-a-number"),{headers:{authorization:"Bearer tested"}})).status).toBe(400);
    mock.query.mockImplementation(async(sql:string) => {
      if(sql.includes("from public.companies"))return {rows:[company]};
      return {rows:[]};
    });
    expect((await fetch(url("999"),{headers:{authorization:"Bearer tested"}})).status).toBe(404);
    expect(mock.query.mock.calls.every(x=>!/^\s*(INSERT|UPDATE|DELETE)/i.test(String(x[0])))).toBe(true);
  });
});
