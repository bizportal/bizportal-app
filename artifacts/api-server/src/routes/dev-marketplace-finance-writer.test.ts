import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
const mock=vi.hoisted(()=>({
  session:vi.fn(),user:vi.fn(),isDev:vi.fn(),query:vi.fn(),
  getInvoice:vi.fn(),submitInvoice:vi.fn(),createAp:vi.fn(),getAp:vi.fn(),reviewAp:vi.fn(),waitingAp:vi.fn(),handoffAp:vi.fn(),
}));
vi.mock("./dev-auth",()=>({getProductionSession:mock.session,getProductionUser:mock.user,isDevelopmentEnvironment:mock.isDev}));
vi.mock("@workspace/db",()=>({pool:{query:mock.query}}));
vi.mock("../lib/services/mktVendorInvoiceService.js",()=>({getMarketplaceVendorInvoice:mock.getInvoice,submitMarketplaceVendorInvoice:mock.submitInvoice,safeMarketplaceVendorInvoiceView:vi.fn(()=>({id:77}))}));
vi.mock("../lib/services/mktApPreparationService.js",()=>({createApPreparation:mock.createAp,getApPreparation:mock.getAp,reviewApPreparation:mock.reviewAp,markApPreparationWaitingPayment:mock.waitingAp,createMarketplaceAccountingHandoff:mock.handoffAp,safeApView:vi.fn(()=>({id:88}))}));
import route from "./dev-marketplace-finance-writer";
let server:Server,base:string;
beforeAll(async()=>{const app=express();app.use(express.json());app.use("/api",route);server=app.listen(0);await new Promise<void>(r=>server.once("listening",r));base="http://127.0.0.1:"+(server.address() as AddressInfo).port});
afterAll(async()=>{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()))});
beforeEach(()=>{
  for(const v of Object.values(mock))v.mockReset();
  mock.isDev.mockReturnValue(true);mock.session.mockReturnValue({id:"signed"});mock.user.mockResolvedValue({email:"admin@test.dev",role:"super_admin"});mock.query.mockResolvedValue({rows:[{company_id:1}]});
  mock.getInvoice.mockResolvedValue({invoice:{id:77,mktPurchaseOrderId:12,companyId:1,supplierId:5},lines:[]});
  process.env.APP_ENV="development";
  delete process.env.NODE_ENV;
  process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV="true";
  delete process.env.BIZPORTAL_MARKETPLACE_ACCOUNTING_HANDOFF_ENABLED_DEV;
});
const get=(path:string)=>fetch(base+path);
const post=(path:string,body:any={})=>fetch(base+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
describe("DEV-only restored canonical vendor invoice/AP runtime gates",()=>{
 it("fails closed for PROD, unspecified APP_ENV or disabled feature flag",async()=>{
   mock.isDev.mockReturnValue(false);
   expect((await get("/api/mkt/admin/vendor-invoices/77")).status).toBe(404);
   mock.isDev.mockReturnValue(true);process.env.APP_ENV="production";
   process.env.NODE_ENV="development";
   expect((await get("/api/mkt/admin/vendor-invoices/77")).status).toBe(404);
   delete process.env.APP_ENV;
   expect((await get("/api/mkt/admin/vendor-invoices/77")).status).toBe(404);
   process.env.APP_ENV="development";
   delete process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV;
   expect((await post("/api/mkt/admin/vendor-invoices/77/match")).status).toBe(404);
   expect(mock.getInvoice).not.toHaveBeenCalled();expect(mock.submitInvoice).not.toHaveBeenCalled();
 });
 it("allows production-built Node only with explicit APP_ENV development and a verified session",async()=>{
   process.env.APP_ENV="development";
   process.env.NODE_ENV="production";
   expect((await get("/api/mkt/admin/vendor-invoices/77")).status).toBe(200);
   expect(mock.getInvoice).toHaveBeenCalledOnce();
 });
 it("requires a signed verified session, not role metadata",async()=>{
   mock.session.mockReturnValue(null);expect((await post("/api/mkt/admin/vendor-invoices/77/match")).status).toBe(401);
   mock.session.mockReturnValue({id:"signed"});mock.user.mockResolvedValue({email:"customer@test.dev",role:"customer"});
   expect((await post("/api/mkt/admin/vendor-invoices/77/ap-preparation")).status).toBe(403);
   expect(mock.createAp).not.toHaveBeenCalled();
 });
 it("rejects otherwise valid admin and owner sessions until tenant permissions are certified",async()=>{
   mock.user.mockResolvedValue({email:"admin@test.dev",role:"admin"});
   expect((await post("/api/mkt/admin/vendor-invoices/77/match")).status).toBe(403);
   mock.user.mockResolvedValue({email:"owner@test.dev",role:"owner"});
   expect((await post("/api/mkt/admin/vendor-invoices/77/ap-preparation")).status).toBe(403);
   expect(mock.getInvoice).not.toHaveBeenCalled();expect(mock.createAp).not.toHaveBeenCalled();
 });
 it("requires company-scoped vendor invoice and matching PO, prevents null-company writes",async()=>{
   mock.getInvoice.mockResolvedValue({invoice:{id:77,mktPurchaseOrderId:12,companyId:null,supplierId:5},lines:[]});
   expect((await post("/api/mkt/admin/vendor-invoices/77/match")).status).toBe(404);
   expect(mock.query).not.toHaveBeenCalled();expect(mock.submitInvoice).not.toHaveBeenCalled();
   mock.getInvoice.mockResolvedValue({invoice:{id:77,mktPurchaseOrderId:12,companyId:1,supplierId:5},lines:[]});
   mock.query.mockResolvedValue({rows:[]});
   expect((await post("/api/mkt/admin/vendor-invoices/77/ap-preparation")).status).toBe(404);
   expect(mock.createAp).not.toHaveBeenCalled();
 });
 it("rejects malformed IDs and any non-empty action payload",async()=>{
   expect((await post("/api/mkt/admin/vendor-invoices/bad/match")).status).toBe(400);
   expect((await post("/api/mkt/admin/vendor-invoices/77/match",{overrideMatch:true})).status).toBe(422);
   expect(mock.submitInvoice).not.toHaveBeenCalled();
 });
 it("delegates matches/AP to original functions, never writes custom SQL",async()=>{
   mock.submitInvoice.mockResolvedValue({ok:true,invoice:{},lines:[],alreadyExists:false,match:{ok:true,status:"passed"}});
   mock.createAp.mockResolvedValue({ok:true,preparation:{id:88},alreadyExists:false});
   expect((await post("/api/mkt/admin/vendor-invoices/77/match")).status).toBe(200);
   expect((await post("/api/mkt/admin/vendor-invoices/77/ap-preparation")).status).toBe(201);
   expect(mock.submitInvoice).toHaveBeenCalledOnce();expect(mock.createAp).toHaveBeenCalledOnce();
   expect(mock.query).toHaveBeenCalledTimes(2);
   for(const [sql] of mock.query.mock.calls)expect(sql.toLowerCase()).toMatch(/^select /);
 });
 it("reuses canonical AP without creating a second preparation",async()=>{
   mock.createAp.mockResolvedValue({ok:true,preparation:{id:88},alreadyExists:true});
   const res=await post("/api/mkt/admin/vendor-invoices/77/ap-preparation");
   expect(res.status).toBe(200);
   expect(((await res.json()) as {alreadyExists:boolean}).alreadyExists).toBe(true);
   expect(mock.createAp).toHaveBeenCalledOnce();
 });
 it("preserves the canonical 3-way-match refusal",async()=>{
   mock.createAp.mockResolvedValue({ok:false,code:"MATCH_NOT_PASSED"});
   const res=await post("/api/mkt/admin/vendor-invoices/77/ap-preparation");
   expect(res.status).toBe(422);
   expect(((await res.json()) as {error:string}).error).toBe("MATCH_NOT_PASSED");
 });
 it("refuses AP transitions when company, PO, GR and matched vendor invoice references disagree",async()=>{
   mock.getAp.mockResolvedValue({id:88,companyId:1,mktPurchaseOrderId:12,mktGoodsReceiptId:51,vendorInvoiceId:77});
   mock.query.mockResolvedValue({rows:[]});
   const res=await post("/api/mkt/admin/ap-preparations/88/waiting-payment");
   expect(res.status).toBe(404);
   expect(mock.waitingAp).not.toHaveBeenCalled();
   const [sql,params]=mock.query.mock.calls[0];
   expect(sql).toContain("ap.company_id=p.company_id");
   expect(sql).toContain("vi.mkt_goods_receipt_id=gr.id");
   expect(sql).toContain("vi.three_way_match_status='passed'");
   expect(params).toEqual([88]);
 });
 it("keeps Accounting handoff OFF by default even for a verified Super Admin", async () => {
   const response = await post("/api/mkt/admin/ap-preparations/88/accounting-handoff");
   expect(response.status).toBe(404);
   expect(mock.handoffAp).not.toHaveBeenCalled();
 });
 it("requires the same verified AP company/PO/GR/3-way-match gate for handoff", async () => {
   process.env.BIZPORTAL_MARKETPLACE_ACCOUNTING_HANDOFF_ENABLED_DEV="true";
   mock.getAp.mockResolvedValue({ id:88,companyId:1,mktPurchaseOrderId:12,mktGoodsReceiptId:51,vendorInvoiceId:77 });
   mock.query.mockResolvedValue({rows:[]});
   expect((await post("/api/mkt/admin/ap-preparations/88/accounting-handoff")).status).toBe(404);
   expect(mock.handoffAp).not.toHaveBeenCalled();
 });
 it("does not create Accounting handoff for unauthenticated sessions", async () => {
   process.env.BIZPORTAL_MARKETPLACE_ACCOUNTING_HANDOFF_ENABLED_DEV="true";
   mock.session.mockReturnValue(null);
   expect((await post("/api/mkt/admin/ap-preparations/88/accounting-handoff")).status).toBe(401);
   expect(mock.handoffAp).not.toHaveBeenCalled();
 });
 it("uses existing canonical handoff once; returns Draft-only, no journal", async () => {
   process.env.BIZPORTAL_MARKETPLACE_ACCOUNTING_HANDOFF_ENABLED_DEV="true";
   mock.getAp.mockResolvedValue({ id:88,companyId:1,mktPurchaseOrderId:12,mktGoodsReceiptId:51,vendorInvoiceId:77 });
   mock.handoffAp
     .mockResolvedValueOnce({ok:true,alreadyExists:false,paymentRequestId:41,handoffId:9})
     .mockResolvedValueOnce({ok:true,alreadyExists:true,paymentRequestId:41,handoffId:9});
   const url="/api/mkt/admin/ap-preparations/88/accounting-handoff";
   const first=await post(url);
   expect(first.status).toBe(201);
   expect(await first.json()).toMatchObject({ok:true,alreadyExists:false,paymentStatus:"draft",journalPosted:false,paymentRequestId:41,handoffId:9});
   const repeated=await post(url);
   expect(repeated.status).toBe(200);
   expect(await repeated.json()).toMatchObject({ok:true,alreadyExists:true,paymentRequestId:41,handoffId:9});
   expect(mock.handoffAp).toHaveBeenCalledTimes(2);
 });
 it("does not advance AP when associated record lacks company",async()=>{
   mock.getAp.mockResolvedValue({id:88,companyId:null,mktPurchaseOrderId:12});
   expect((await post("/api/mkt/admin/ap-preparations/88/finance-review")).status).toBe(404);
   expect(mock.reviewAp).not.toHaveBeenCalled();
 });
});
