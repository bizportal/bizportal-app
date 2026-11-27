import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PgDialect } from "drizzle-orm/pg-core";
const mock=vi.hoisted(()=>({
  session:vi.fn(),user:vi.fn(),isDev:vi.fn(),query:vi.fn(),roleCheck:vi.fn(),finance:vi.fn(),financeReadOnly:vi.fn(),
  companyQuery:vi.fn(),globalAllowed:vi.fn(),allowedCompany:vi.fn(),globalEnabled:vi.fn(),signedScope:vi.fn(),setScopeCookie:vi.fn(),
  getInvoice:vi.fn(),submitInvoice:vi.fn(),createAp:vi.fn(),getAp:vi.fn(),reviewAp:vi.fn(),waitingAp:vi.fn(),handoffAp:vi.fn(),approvePay:vi.fn(),
}));
vi.mock("./dev-auth",()=>({
  getProductionSession: mock.session,
  getProductionUser: mock.user,
  isDevelopmentEnvironment: mock.isDev,
  isFinanceGlobalScopeDevEnabled: mock.globalEnabled,
  isApprovedFinanceGlobalSuperAdmin: mock.globalAllowed,
  isApprovedFinanceGlobalCompany: mock.allowedCompany,
  getFinanceCompanyScope: mock.signedScope,
  setFinanceCompanyScopeCookie: mock.setScopeCookie,
}));
vi.mock("@workspace/db",()=>({
  withMarketplaceFinanceDevTransaction: mock.finance,
}));
vi.mock("../lib/services/mktVendorInvoiceService.js",()=>({getMarketplaceVendorInvoice:mock.getInvoice,submitMarketplaceVendorInvoice:mock.submitInvoice,safeMarketplaceVendorInvoiceView:vi.fn(()=>({id:77}))}));
vi.mock("../lib/services/mktApPreparationService.js",()=>({createApPreparation:mock.createAp,getApPreparation:mock.getAp,reviewApPreparation:mock.reviewAp,markApPreparationWaitingPayment:mock.waitingAp,createMarketplaceAccountingHandoff:mock.handoffAp,safeApView:vi.fn(()=>({id:88}))}));
vi.mock("../lib/finance/marketplacePaymentApproval.js",()=>({approveMarketplacePaymentRequest:mock.approvePay}));
import route from "./dev-marketplace-finance-writer";
let server:Server,base:string;
beforeAll(async()=>{const app=express();app.use(express.json());app.use("/api",route);server=app.listen(0);await new Promise<void>(r=>server.once("listening",r));base="http://127.0.0.1:"+(server.address() as AddressInfo).port});
afterAll(async()=>{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()))});
beforeEach(()=>{
  for(const v of Object.values(mock))v.mockReset();
  mock.globalEnabled.mockReturnValue(false);
  mock.globalAllowed.mockReturnValue(false);
  mock.allowedCompany.mockReturnValue(false);
  mock.signedScope.mockReturnValue(null);
  mock.isDev.mockReturnValue(true);mock.session.mockReturnValue({id:"signed"});mock.user.mockResolvedValue({email:"admin@test.dev",role:"super_admin",companyId:1});mock.query.mockResolvedValue({rows:[{company_id:1}]});
  mock.roleCheck.mockResolvedValue({rows:[{db_role:"bizportal_marketplace_finance_login_dev",elevated:false,vendor_rls_active:true,ap_rls_active:true,payment_rls_active:true}]});
  mock.finance.mockImplementation(async (companyId:number, fn:(db:unknown)=>Promise<unknown>) => {
    if (companyId !== 1) throw Error("wrong tenant");
    const role=(await mock.roleCheck()).rows[0];
    if (role.db_role !== "bizportal_marketplace_finance_login_dev" || role.elevated ||
        !role.vendor_rls_active || !role.ap_rls_active || !role.payment_rls_active) {
      throw Error("role/RLS not ready");
    }
    const scopedDb = {
      execute: (query: unknown) => {
        const statement=new PgDialect().sqlToQuery(query as any);
        return mock.query(statement.sql,statement.params);
      },
    };
    return fn(scopedDb);
  });
  mock.getInvoice.mockResolvedValue({invoice:{id:77,mktPurchaseOrderId:12,companyId:1,supplierId:5},lines:[]});
  process.env.APP_ENV="development";
  delete process.env.NODE_ENV;
  process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV="true";
  delete process.env.BIZPORTAL_MARKETPLACE_ACCOUNTING_HANDOFF_ENABLED_DEV;
  delete process.env.BIZPORTAL_MARKETPLACE_PAYMENT_APPROVAL_ENABLED_DEV;
  delete process.env.BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV;
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
 it("rejects a Super Admin without a verified company before any finance access",async()=>{
   mock.user.mockResolvedValue({email:"admin@test.dev",role:"super_admin",companyId:null});
   expect((await get("/api/mkt/admin/vendor-invoices/77")).status).toBe(403);
   expect((await post("/api/mkt/admin/vendor-invoices/77/match")).status).toBe(403);
   expect((await get("/api/mkt/admin/ap-preparations/88")).status).toBe(403);
   expect(mock.getInvoice).not.toHaveBeenCalled();
   expect(mock.getAp).not.toHaveBeenCalled();
   expect(mock.query).not.toHaveBeenCalled();
 });
 it("does not read another company's vendor invoice before scoped DB validation",async()=>{
   mock.query.mockResolvedValue({rows:[]});
   const response=await get("/api/mkt/admin/vendor-invoices/77");
   expect(response.status).toBe(404);
   expect(mock.getInvoice).not.toHaveBeenCalled();
   expect(mock.query).toHaveBeenCalledWith(expect.stringContaining("p.company_id=$2"),[77,1,1]);
 });
 it("does not read another company's AP before scoped DB validation",async()=>{
   mock.getAp.mockResolvedValue({id:88,companyId:2,mktPurchaseOrderId:12,mktGoodsReceiptId:51,vendorInvoiceId:77});
   mock.query.mockResolvedValue({rows:[]});
   const response=await get("/api/mkt/admin/ap-preparations/88");
   expect(response.status).toBe(404);
   expect(mock.getAp).not.toHaveBeenCalled();
   expect(mock.query).toHaveBeenCalledWith(expect.stringContaining("ap.company_id=$2"),[88,1,1,1]);
 });
 it("blocks all cross-company Finance/AP actions before canonical writers",async()=>{
   process.env.BIZPORTAL_MARKETPLACE_ACCOUNTING_HANDOFF_ENABLED_DEV="true";
   mock.query.mockResolvedValue({rows:[]});
   mock.getAp.mockResolvedValue({id:88,companyId:2,mktPurchaseOrderId:12,mktGoodsReceiptId:51,vendorInvoiceId:77});
   expect((await post("/api/mkt/admin/vendor-invoices/77/match")).status).toBe(404);
   expect((await post("/api/mkt/admin/vendor-invoices/77/ap-preparation")).status).toBe(404);
   expect((await post("/api/mkt/admin/ap-preparations/88/finance-review")).status).toBe(404);
   expect((await post("/api/mkt/admin/ap-preparations/88/accounting-handoff")).status).toBe(404);
   expect(mock.getInvoice).not.toHaveBeenCalled();
   expect(mock.getAp).not.toHaveBeenCalled();
   expect(mock.submitInvoice).not.toHaveBeenCalled();
   expect(mock.createAp).not.toHaveBeenCalled();
   expect(mock.reviewAp).not.toHaveBeenCalled();
   expect(mock.handoffAp).not.toHaveBeenCalled();
 });
 it("rejects privileged postgres database connections even for a verified Super Admin",async()=>{
   mock.roleCheck.mockResolvedValueOnce({rows:[{
     db_role:"postgres", elevated:true, vendor_rls_active:false,
     ap_rls_active:false, payment_rls_active:false,
   }]});
   expect((await get("/api/mkt/admin/vendor-invoices/77")).status).toBe(503);
   expect(mock.getInvoice).not.toHaveBeenCalled();
   expect(mock.getAp).not.toHaveBeenCalled();
   expect(mock.submitInvoice).not.toHaveBeenCalled();
   expect(mock.createAp).not.toHaveBeenCalled();
 });
 it("rejects the dedicated role if any finance table is not under RLS",async()=>{
   mock.roleCheck.mockResolvedValueOnce({rows:[{
     db_role:"bizportal_marketplace_finance_login_dev", elevated:false, vendor_rls_active:true,
     ap_rls_active:false, payment_rls_active:true,
   }]});
   expect((await get("/api/mkt/admin/vendor-invoices/77")).status).toBe(503);
   expect(mock.getInvoice).not.toHaveBeenCalled();
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
   expect(mock.query).toHaveBeenCalledWith(expect.stringContaining("p.company_id=$2"),[77,1,1]);
   expect(mock.submitInvoice).not.toHaveBeenCalled();
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
   expect(mock.getInvoice.mock.calls[0][1]).toBe(mock.submitInvoice.mock.calls[0][2]);
   expect(mock.getInvoice.mock.calls[1][1]).toBe(mock.createAp.mock.calls[0][2]);
   expect(mock.finance.mock.calls.map(([companyId]) => companyId)).toEqual([1,1]);
   expect(mock.query).toHaveBeenCalledTimes(2);
   for(const [sql] of mock.query.mock.calls)expect(sql.toLowerCase()).toMatch(/^\s*select /);
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
   expect(params).toEqual([88,1,1,1]);
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

describe("DEV Marketplace real Payment Request approval protected HTTP boundary",()=>{
  it("is invisible while the real payment-approval flag is OFF",async()=>{
    expect((await post("/api/mkt/admin/payment-requests/41/approve")).status).toBe(404);
    expect(mock.approvePay).not.toHaveBeenCalled();
  });
  it("rejects anonymous, mismatched company and non-superadmin",async()=>{
    process.env.BIZPORTAL_MARKETPLACE_PAYMENT_APPROVAL_ENABLED_DEV="true";
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV="true";
    mock.session.mockReturnValue(null);
    expect((await post("/api/mkt/admin/payment-requests/41/approve")).status).toBe(401);
    mock.session.mockReturnValue({id:"signed",email:"admin@test.dev",issuedAt:100,expiresAt:Date.now()+600000});
    mock.user.mockResolvedValue({email:"other@test.dev",role:"admin",companyId:1});
    expect((await post("/api/mkt/admin/payment-requests/41/approve")).status).toBe(403);
    expect(mock.approvePay).not.toHaveBeenCalled();
  });
  it("rejects invalid body and cross-site origin before any financial operation",async()=>{
    process.env.BIZPORTAL_MARKETPLACE_PAYMENT_APPROVAL_ENABLED_DEV="true";
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV="true";
    const origin="https://"+new URL(base).host;
    const path="/api/mkt/admin/payment-requests/41/approve";
    expect((await post(path,{approve:true})).status).toBe(422);
    const bad=await fetch(base+path,{method:"POST",
      headers:{"Content-Type":"application/json","Origin":"https://evil.invalid"},
      body:"{}"});
    expect(bad.status).toBe(403);
    expect(mock.approvePay).not.toHaveBeenCalled();
  });
  it("keeps all other Finance writers OFF when approval-only is enabled",async()=>{
    delete process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV;
    process.env.BIZPORTAL_MARKETPLACE_PAYMENT_APPROVAL_ENABLED_DEV="true";
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV="true";
    mock.approvePay.mockResolvedValue({requestId:41,companyId:1,status:"approved",
      replay:false,bankTransfer:false,glPosted:false});
    const path="/api/mkt/admin/payment-requests/41/approve";
    const response=await fetch(base+path,{method:"POST",
      headers:{"Content-Type":"application/json","Origin":"https://"+new URL(base).host},body:"{}"});
    expect(response.status).toBe(200);
    expect(mock.finance).toHaveBeenCalledWith(1,expect.any(Function),
      {paymentApprovalOnly:true});
    expect((await post("/api/mkt/admin/ap-preparations/88/accounting-handoff")).status).toBe(404);
    expect((await post("/api/mkt/admin/vendor-invoices/77/match")).status).toBe(404);
    expect(mock.handoffAp).not.toHaveBeenCalled();
    expect(mock.submitInvoice).not.toHaveBeenCalled();
  });
  it("does not expose approval without company-scoped credential mode",async()=>{
    process.env.BIZPORTAL_MARKETPLACE_PAYMENT_APPROVAL_ENABLED_DEV="true";
    delete process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV;
    expect((await post("/api/mkt/admin/payment-requests/41/approve")).status).toBe(404);
    expect(mock.approvePay).not.toHaveBeenCalled();
  });
  it("uses existing signed Super Admin, company role and approval-only transaction",async()=>{
    process.env.BIZPORTAL_MARKETPLACE_PAYMENT_APPROVAL_ENABLED_DEV="true";
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV="true";
    mock.approvePay.mockResolvedValue({requestId:41,companyId:1,status:"approved",
      replay:false,bankTransfer:false,glPosted:false});
    const path="/api/mkt/admin/payment-requests/41/approve";
    const response=await fetch(base+path,{method:"POST",
      headers:{"Content-Type":"application/json","Origin":"https://"+new URL(base).host,
        "Sec-Fetch-Site":"same-origin"},body:"{}"});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ok:true,requestId:41,status:"approved",
      bankTransfer:false,glPosted:false});
    expect(mock.approvePay).toHaveBeenCalledOnce();
    expect(mock.finance).toHaveBeenCalledOnce();
  });
});


describe("Finance company selection — signed Super Admin and tenant isolation", () => {
  const endpoint = "/api/mkt/admin/finance-company-selection";
  const scopedPost = (body: unknown, origin = "https://" + new URL(base).host) =>
    fetch(base + endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": origin,
        "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify(body),
    });

  it("is invisible without the dedicated global Finance gate and in PROD", async () => {
    expect((await scopedPost({ companyId: 1 })).status).toBe(404);
    mock.globalEnabled.mockReturnValue(true);
    mock.isDev.mockReturnValue(false);
    expect((await scopedPost({ companyId: 1 })).status).toBe(404);
    expect(mock.setScopeCookie).not.toHaveBeenCalled();
  });

  it("rejects missing signed session, wrong role, cross-tenant company and cross-site Origin", async () => {
    mock.globalEnabled.mockReturnValue(true);
    mock.allowedCompany.mockReturnValue(true);
    mock.session.mockReturnValue(null);
    expect((await scopedPost({ companyId: 1 })).status).toBe(401);
    mock.session.mockReturnValue({ id: "signed" });
    mock.user.mockResolvedValue({ email: "admin@test.dev", role: "admin", companyId: null });
    expect((await scopedPost({ companyId: 1 })).status).toBe(403);
    mock.user.mockResolvedValue({ email: "admin@test.dev", role: "super_admin", companyId: null });
    mock.globalAllowed.mockReturnValue(true);
    expect((await scopedPost({ companyId: 1 }, "https://evil.invalid")).status).toBe(403);
    expect((await scopedPost({ companyId: 0 })).status).toBe(422);
    expect((await scopedPost({ companyId: -1 })).status).toBe(422);
    expect((await scopedPost({ companyId: 1, companyId2: 3 })).status).toBe(422);
    mock.allowedCompany.mockReturnValue(false);
    expect((await scopedPost({ companyId: 1 })).status).toBe(403);
    expect(mock.setScopeCookie).not.toHaveBeenCalled();
  });

  it("issues exactly one verified scope to an allowlisted global Super Admin", async () => {
    mock.globalEnabled.mockReturnValue(true);
    mock.globalAllowed.mockReturnValue(true);
    mock.allowedCompany.mockImplementation((companyId: number) => companyId === 3);
    mock.user.mockResolvedValue({ email: "owner@test.dev", role: "super_admin", companyId: null });
    const response = await scopedPost({ companyId: 3 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, companyId: 3 });
    expect(mock.setScopeCookie).toHaveBeenCalledWith(expect.anything(), expect.anything(), 3);
    expect(mock.finance).not.toHaveBeenCalled();
    expect(mock.approvePay).not.toHaveBeenCalled();
  });

  it("global Super Admin cannot read Finance without signed scope; with it tenant is pinned", async () => {
    mock.globalEnabled.mockReturnValue(true);
    mock.globalAllowed.mockReturnValue(true);
    mock.allowedCompany.mockImplementation((companyId: number) => companyId === 1);
    mock.user.mockResolvedValue({ email: "owner@test.dev", role: "super_admin", companyId: null });
    expect((await get("/api/mkt/admin/vendor-invoices/77")).status).toBe(403);
    expect(mock.getInvoice).not.toHaveBeenCalled();
    mock.signedScope.mockReturnValue(1);
    expect((await get("/api/mkt/admin/vendor-invoices/77")).status).toBe(200);
    expect(mock.finance.mock.calls[0][0]).toBe(1);
  });
});
