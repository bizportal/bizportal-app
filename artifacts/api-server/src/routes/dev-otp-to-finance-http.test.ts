import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const m = vi.hoisted(() => ({
  query: vi.fn(), email: vi.fn(), finance: vi.fn(), getInvoice: vi.fn(),
  invoiceSubmit: vi.fn(), ap: vi.fn(), currentCompany: 1, userActive: true,
  userId: "admin-otp-1", userRole: "super_admin", codeHash: "",
  consumed: false, attempts: 0, scopedCalls: [] as {sql:string;params:unknown[]}[],
}));
vi.mock("@workspace/db", () => ({
  pool: { query: m.query },
  getRuntimeDatabaseUrl: vi.fn(),
  withMarketplaceFinanceDevTransaction: m.finance,
}));
vi.mock("../lib/smtp", () => ({ sendAdminLoginOtpEmail: m.email }));
vi.mock("../lib/services/mktVendorInvoiceService.js", () => ({
  getMarketplaceVendorInvoice: m.getInvoice,
  submitMarketplaceVendorInvoice: m.invoiceSubmit,
  safeMarketplaceVendorInvoiceView: vi.fn((invoice:any) => ({
    id: invoice.id, companyId: invoice.companyId,
  })),
}));
vi.mock("../lib/services/mktApPreparationService.js", () => ({
  createApPreparation: m.ap,
  getApPreparation: vi.fn(),
  reviewApPreparation: vi.fn(),
  markApPreparationWaitingPayment: vi.fn(),
  createMarketplaceAccountingHandoff: vi.fn(),
  safeApView: vi.fn(),
}));

import authRouter from "./local-production-auth";
import financeRouter from "./dev-marketplace-finance-writer";

const KEYS = [
  "APP_ENV", "NODE_ENV", "SESSION_SECRET", "BIZPORTAL_SESSION_SECRET",
  "BIZPORTAL_SIGNED_OTP_ENABLED_DEV",
  "BIZPORTAL_SIGNED_OTP_ACCOUNT_EMAIL_DEV",
  "BIZPORTAL_SIGNED_OTP_ACCOUNT_ID_DEV",
  "BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV",
  "BIZPORTAL_MARKETPLACE_ACCOUNTING_HANDOFF_ENABLED_DEV",
] as const;
const originals = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
const dialect = new PgDialect();
let server: Server;
let origin: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    next();
  });
  app.use("/api", authRouter);
  app.use("/api", financeRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close(err => err ? reject(err) : resolve()));
});
beforeEach(() => {
  process.env.APP_ENV = "development";
  process.env.NODE_ENV = "production"; // same as built DEV service
  process.env.SESSION_SECRET = "pr50-dev-otp-to-finance-synthetic-signing-key-32-chars";
  delete process.env.BIZPORTAL_SESSION_SECRET;
  process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV = "true";
  // Current main signs DEV OTP only for a deliberately pinned Super Admin.
  process.env.BIZPORTAL_SIGNED_OTP_ACCOUNT_EMAIL_DEV = "admin-otp@example.invalid";
  process.env.BIZPORTAL_SIGNED_OTP_ACCOUNT_ID_DEV = "admin-otp-1";
  process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV = "true";
  delete process.env.BIZPORTAL_MARKETPLACE_ACCOUNTING_HANDOFF_ENABLED_DEV;
  for (const v of [m.query,m.email,m.finance,m.getInvoice,m.invoiceSubmit,m.ap]) v.mockReset();
  m.currentCompany = 1; m.userActive = true;
  m.userId = "admin-otp-1"; m.userRole = "super_admin";
  m.codeHash = "";m.consumed = false;m.attempts=0;m.scopedCalls.length=0;
  m.email.mockResolvedValue(undefined);
  m.query.mockImplementation(async (q:string, args?:unknown[]) => {
    if (q.includes("to_regclass")) return { rows:[{ present:true }] };
    if (q.includes("count(*)::text")) return { rows:[{ count:"0" }] };
    if (q.includes("with invalidated")) {
      m.codeHash = String(args?.[3] ?? "");
      m.consumed = false;
      return { rows:[{ id:"otp-test-1" }] };
    }
    if (q.includes("code_hash, attempts")) return {
      rows: m.codeHash && !m.consumed ? [{
        id:"otp-test-1",code_hash:m.codeHash,attempts:m.attempts,
        expires_at:new Date(Date.now()+5*60*1000),
      }] : [],
    };
    if (q.includes("set attempts = attempts + 1")) {
      m.attempts += 1;return { rowCount:1,rows:[] };
    }
    if (q.includes("set verified_at = now()") && q.includes("returning id")) {
      if (m.consumed) return {rowCount:0,rows:[]};
      m.consumed = true;return {rowCount:1,rows:[{id:"otp-test-1"}]};
    }
    if (q.includes("to_jsonb(u)")) return { rows:[{user_data:{
      id:m.userId,email:"admin-otp@example.invalid",role:m.userRole,
      status:m.userActive?"active":"inactive",
      is_active:m.userActive,company_id:m.currentCompany,
    }}] };
    throw new Error("Unexpected DB query in isolated OTP test");
  });
  m.finance.mockImplementation(async (companyId:number,work:(tx:any)=>Promise<unknown>) => {
    if (![1,3].includes(companyId)) throw Error("Untrusted company scope");
    const scoped = {
      execute: async (sql:unknown) => {
        const s = dialect.sqlToQuery(sql as any);
        m.scopedCalls.push({sql:s.sql,params:s.params});
        // Fixture exists in company 1 only, never in company 3.
        return {rows:companyId===1?[{company_id:1,vendor_id:5,mkt_goods_receipt_id:7}]:[]};
      },
    };
    return work(scoped);
  });
  m.getInvoice.mockResolvedValue({invoice:{
    id:77,companyId:1,mktPurchaseOrderId:12,supplierId:5,
  },lines:[]});
});
afterEach(() => {
  for (const k of KEYS) {
    if (originals[k] === undefined) delete process.env[k];
    else process.env[k] = originals[k];
  }
});

async function otpLogin(): Promise<string> {
  const send=await fetch(origin+"/api/auth/email-otp/send",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({email:"admin-otp@example.invalid"}),
  });
  expect(send.status).toBe(202);
  expect(m.email).toHaveBeenCalledOnce();
  const code=String(m.email.mock.calls[0][1]);
  expect(code).toMatch(/^\d{6}$/);
  const verified=await fetch(origin+"/api/auth/email-otp/verify",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({email:"admin-otp@example.invalid",code}),
  });
  expect(verified.status).toBe(200);
  expect(await verified.json()).toMatchObject({
    ok:true,user:{role:"super_admin",companyId:1},
  });
  const cookie=verified.headers.get("set-cookie")??"";
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Secure");
  expect(cookie).toContain("SameSite=Lax");
  return cookie.split(";")[0];
}
const getInvoice = (cookie?:string) => fetch(origin+"/api/mkt/admin/vendor-invoices/77",{
  headers:cookie?{Cookie:cookie}:{},
});

describe("signed Super Admin OTP -> canonical Finance route integrated HTTP boundary",()=>{
  it("issues real signed cookie from OTP and reads only verified tenant via scoped canonical service",async()=>{
    const cookie=await otpLogin();
    const res=await getInvoice(cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ok:true,data:{id:77,companyId:1}});
    expect(m.finance.mock.calls[0][0]).toBe(1);
    expect(m.scopedCalls).toHaveLength(1);
    expect(m.scopedCalls[0].sql).toContain("p.company_id=$2");
    expect(m.scopedCalls[0].params).toEqual([77,1,1]);
    expect(m.getInvoice).toHaveBeenCalledOnce();
    expect(m.invoiceSubmit).not.toHaveBeenCalled();
    expect(m.ap).not.toHaveBeenCalled();
  });
  it("denies signed session for a different company rather than reading another tenant",async()=>{
    const cookie=await otpLogin();
    m.currentCompany=3;
    const res=await getInvoice(cookie);
    expect(res.status).toBe(404);
    expect(m.finance.mock.calls[0][0]).toBe(3);
    expect(m.scopedCalls[0].params).toEqual([77,3,3]);
    expect(m.getInvoice).not.toHaveBeenCalled();
  });
  it("rejects inactive user even when cookie is signed and was previously valid",async()=>{
    const cookie=await otpLogin();
    m.userActive=false;
    const res=await getInvoice(cookie);
    expect(res.status).toBe(403);
    expect(m.finance).not.toHaveBeenCalled();
  });
  it("denies a real signed session after Super Admin role is revoked",async()=>{
    const cookie=await otpLogin();
    m.userRole="owner";
    expect((await getInvoice(cookie)).status).toBe(403);
    expect(m.finance).not.toHaveBeenCalled();
  });
  it("denies a real signed session after company binding becomes null",async()=>{
    const cookie=await otpLogin();
    m.currentCompany=null as unknown as number;
    expect((await getInvoice(cookie)).status).toBe(403);
    expect(m.finance).not.toHaveBeenCalled();
  });
  it("rejects reassigned account ID for an otherwise valid signed cookie",async()=>{
    const cookie=await otpLogin();
    m.userId="reassigned-admin-account";
    expect((await getInvoice(cookie)).status).toBe(403);
    expect(m.finance).not.toHaveBeenCalled();
  });
  it("does not let signed cookie authorize Finance after DEV OTP is disabled",async()=>{
    const cookie=await otpLogin();
    delete process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV;
    expect((await getInvoice(cookie)).status).toBe(401);
    expect(m.finance).not.toHaveBeenCalled();
  });
  it("rejects tampered signed OTP cookie before any tenant-scoped Finance action",async()=>{
    const cookie=await otpLogin();
    const parts=cookie.split("=");
    const forged=parts[0]+"="+parts[1].slice(0,-1)+(parts[1].endsWith("A")?"B":"A");
    expect((await getInvoice(forged)).status).toBe(401);
    expect(m.finance).not.toHaveBeenCalled();
  });
  it("rejects invalid or absent OTP without minting any finance-capable session",async()=>{
    const send=await fetch(origin+"/api/auth/email-otp/send",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({email:"admin-otp@example.invalid"}),
    });
    expect(send.status).toBe(202);
    const invalid=await fetch(origin+"/api/auth/email-otp/verify",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({email:"admin-otp@example.invalid",code:"000000"}),
    });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("set-cookie")).toBeNull();
    expect((await getInvoice()).status).toBe(401);
    expect(m.finance).not.toHaveBeenCalled();
  });
});
