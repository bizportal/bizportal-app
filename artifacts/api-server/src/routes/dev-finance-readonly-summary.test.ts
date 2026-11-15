import express from "express";
import type { Server } from "node:http";
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  session: null as any,
  user: null as any,
  companyActive: true,
  authReads: [] as unknown[][],
  reads: [] as number[],
  readerFailure: false,
}));
vi.mock("@workspace/db", () => ({
  pool: { query: vi.fn(async (_sql: string, params: unknown[]) => {
    fixture.authReads.push(params);
    return { rows: fixture.companyActive ? [{ id: params[0] }] : [] };
  }) },
  readMarketplaceFinanceSummaryDev: vi.fn(async (companyId: number) => {
    fixture.reads.push(companyId);
    if (fixture.readerFailure) throw Error("SENSITIVE_DB_CONNECTION_ERROR");
    return {
      companyId,
      purchaseOrders: companyId === 1 ? 2 : 0,
      vendorInvoices: 0,
      apPreparations: 0,
      accountingHandoffs: 0,
    };
  }),
}));
vi.mock("./dev-auth", () => ({
  isDevelopmentEnvironment: () => process.env.APP_ENV === "development",
  getProductionSession: () => fixture.session,
  getProductionUser: async () => fixture.user,
}));

import financeReadonlyRouter from "./dev-finance-readonly-summary";

const EMAIL = "admin@example.invalid";
const ORIGIN = "https://finance-pr81.72.61.210.205.sslip.io";
const SESSION = { id:"superadmin-1", email:EMAIL, issuedAt:1699999999999, expiresAt: Date.now()+3600000 };
const USER = { id: SESSION.id, email:EMAIL, role:"super_admin", companyId:null };

const keys = [
  "APP_ENV", "NODE_ENV", "SESSION_SECRET", "BIZPORTAL_SESSION_SECRET",
  "BIZPORTAL_SIGNED_PASSWORD_ENABLED_DEV", "BIZPORTAL_SIGNED_OTP_ENABLED_DEV",
  "BIZPORTAL_SIGNED_PASSWORD_ACCOUNT_EMAIL_DEV",
  "BIZPORTAL_FINANCE_READONLY_ENABLED_DEV",
  "BIZPORTAL_FINANCE_READONLY_ORIGIN_DEV",
  "BIZPORTAL_FINANCE_READONLY_SUPERADMIN_EMAIL_DEV",
  "BIZPORTAL_FINANCE_READONLY_COMPANY_IDS_DEV",
  "BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV",
] as const;
const original = Object.fromEntries(keys.map(x => [x,process.env[x]]));
let server:Server;
let base:string;

async function send(path:string, method="GET", body?:object, headers:Record<string,string>={}) {
  const response = await fetch(base + path, {
    method, headers: {
      ...(body ? {"Content-Type":"application/json"} : {}),
      ...headers,
    },
    ...(body ? {body:JSON.stringify(body)} : {}),
  });
  return {
    response,
    data: await response.json().catch(() => null) as any,
  };
}
const select = (companyId:number, headers:Record<string,string>={}) =>
  send("/api/mkt/admin/finance-readonly/select-company","POST",{companyId},{
    "X-Test-Proxy-Host":"finance-pr81.72.61.210.205.sslip.io",
    Origin:ORIGIN,
    "X-Forwarded-Proto":"https",
    "Sec-Fetch-Site":"same-origin",
    ...headers,
  });
const summary = (cookie?:string) =>
  send("/api/mkt/admin/finance-readonly/summary","GET",undefined,
    cookie ? {Cookie: cookie} : {});

describe("signed private Super Admin Finance summary (separate from writer)", () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    // Simulate Nginx proxy_set_header Host $host: undici fetch forbids a custom Host.
    app.use((req,_res,next) => {
      if (req.header("x-test-proxy-host") === new URL(ORIGIN).host) {
        req.headers.host = new URL(ORIGIN).host;
      }
      (req as any).log={info:vi.fn(),error:vi.fn()};next();
    });
    app.use("/api",financeReadonlyRouter);
    app.use((_req,res)=>{res.status(404).json({error:"Not found"});});
    server=app.listen(0,"127.0.0.1");
    await new Promise<void>(resolve=>server.once("listening",resolve));
    const addr=server.address();
    if(!addr || typeof addr==="string")throw Error("NO_SERVER_PORT");
    base="http://127.0.0.1:"+addr.port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  });
  beforeEach(() => {
    process.env.APP_ENV="development";
    process.env.NODE_ENV="production";
    process.env.SESSION_SECRET="test-signing-secret-for-private-readonly-more-than-32";
    delete process.env.BIZPORTAL_SESSION_SECRET;
    process.env.BIZPORTAL_SIGNED_PASSWORD_ENABLED_DEV="true";
    process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV="false";
    process.env.BIZPORTAL_SIGNED_PASSWORD_ACCOUNT_EMAIL_DEV=EMAIL;
    process.env.BIZPORTAL_FINANCE_READONLY_ENABLED_DEV="true";
    process.env.BIZPORTAL_FINANCE_READONLY_ORIGIN_DEV=ORIGIN;
    process.env.BIZPORTAL_FINANCE_READONLY_SUPERADMIN_EMAIL_DEV=EMAIL;
    process.env.BIZPORTAL_FINANCE_READONLY_COMPANY_IDS_DEV="1,3";
    process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV="false";
    fixture.session={...SESSION,expiresAt:Date.now()+3600000};
    fixture.user={...USER};
    fixture.authReads=[];
    fixture.reads=[];
    fixture.companyActive=true;
    fixture.readerFailure=false;
  });
  afterEach(() => {
    for(const key of keys){
      if(original[key]===undefined) delete process.env[key];
      else process.env[key]=original[key];
    }
  });
  it("binds signed session to company 1, then reads only company 1", async () => {
    const selection=await select(1);
    expect(selection.response.status).toBe(200);
    expect(selection.data).toEqual({ok:true,companyId:1});
    const cookie=selection.response.headers.get("set-cookie")??"";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/api/mkt/admin/finance-readonly");
    const out=await summary(cookie.split(";")[0]);
    expect(out.response.status).toBe(200);
    expect(out.data).toEqual({
      mode:"read_only",companyId:1,purchaseOrders:2,vendorInvoices:0,
      apPreparations:0,accountingHandoffs:0,
    });
    expect(fixture.authReads.map(x=>x[0])).toEqual([1,1]);
    expect(fixture.reads).toEqual([1]);
  });
  it("isolates company 3 in a separately signed scope", async () => {
    const selection=await select(3);
    expect(selection.response.status).toBe(200);
    const out=await summary((selection.response.headers.get("set-cookie")??"").split(";")[0]);
    expect(out.response.status).toBe(200);
    expect(out.data.companyId).toBe(3);
    expect(fixture.reads).toEqual([3]);
  });
  it("refuses unbound/unsigned/forged finance scope", async () => {
    expect((await summary()).response.status).toBe(403);
    const selection=await select(1);
    const cookie=(selection.response.headers.get("set-cookie")??"").split(";")[0];
    expect((await summary(cookie.slice(0,-1)+"A")).response.status).toBe(403);
    expect(fixture.reads).toHaveLength(0);
  });
  it("rejects company 2 or 999 before reading Finance", async () => {
    expect((await select(2)).response.status).toBe(403);
    expect((await select(999)).response.status).toBe(403);
    expect(fixture.authReads).toHaveLength(0);
    expect(fixture.reads).toHaveLength(0);
  });
  it("requires one valid signed Super Admin", async () => {
    fixture.session=null;
    expect((await select(1)).response.status).toBe(401);
    fixture.session={...SESSION,expiresAt:Date.now()+3600000};
    fixture.user={...USER,role:"admin"};
    expect((await select(1)).response.status).toBe(401);
    fixture.user={...USER,companyId:1};
    expect((await select(1)).response.status).toBe(401);
    fixture.user=null;
    expect((await select(1)).response.status).toBe(401);
    expect(fixture.authReads).toHaveLength(0);
  });
  it("revokes selection after new login session", async () => {
    const selection=await select(1);
    const cookie=(selection.response.headers.get("set-cookie")??"").split(";")[0];
    fixture.session={...fixture.session,issuedAt:SESSION.issuedAt+1};
    expect((await summary(cookie)).response.status).toBe(403);
    expect(fixture.reads).toHaveLength(0);
  });
  it("rejects cross-origin or missing fetch metadata for selection", async () => {
    expect((await select(1,{Origin:"https://evil.example.invalid"})).response.status).toBe(403);
    expect((await select(1,{"Sec-Fetch-Site":"cross-site"})).response.status).toBe(403);
    expect((await select(1,{"X-Forwarded-Proto":"http"})).response.status).toBe(403);
    expect(fixture.authReads).toHaveLength(0);
  });
  it("fails closed when writer is selected or read-only flag missing", async () => {
    process.env.BIZPORTAL_FINANCE_READONLY_ENABLED_DEV="false";
    expect((await select(1)).response.status).toBe(404);
    process.env.BIZPORTAL_FINANCE_READONLY_ENABLED_DEV="true";
    process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV="true";
    expect((await select(1)).response.status).toBe(404);
    expect((await summary()).response.status).toBe(404);
    expect(fixture.authReads).toHaveLength(0);
  });
  it("does not allow PROD or disabled signed password to access", async () => {
    process.env.APP_ENV="production";
    expect((await select(1)).response.status).toBe(404);
    process.env.APP_ENV="development";
    process.env.BIZPORTAL_SIGNED_PASSWORD_ENABLED_DEV="false";
    expect((await select(1)).response.status).toBe(404);
  });
  it("requires company still active, hides Finance error details", async () => {
    fixture.companyActive=false;
    expect((await select(1)).response.status).toBe(404);
    fixture.companyActive=true;
    const selection=await select(1);
    fixture.readerFailure=true;
    const out=await summary((selection.response.headers.get("set-cookie")??"").split(";")[0]);
    expect(out.response.status).toBe(503);
    expect(JSON.stringify(out.data)).not.toContain("SENSITIVE_DB_CONNECTION_ERROR");
  });
  it("never provides any mutation endpoint through the read-only router", async () => {
    expect((await send("/api/mkt/admin/finance-readonly/summary","POST",{})).response.status).toBe(404);
    expect((await send("/api/mkt/admin/finance-readonly/payments","POST",{})).response.status).toBe(404);
    expect(fixture.reads).toHaveLength(0);
  });
});
