import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

const mock = vi.hoisted(() => ({
  actor: null as null | { email: string; companyId: number | null; role: string },
  queries: [] as Array<{sql: string; params: unknown[]}>,
  readerFailure: null as null | string,
}));
vi.mock("../routes/dev-auth", () => ({
  isDevelopmentEnvironment: () => process.env.APP_ENV === "development",
  getProductionSession: () => null,
  getProductionUser: async () => null,
  getDevSession: () => mock.actor,
}));
vi.mock("@workspace/db", () => ({
  pool: {
    query: async (sql: string, params: unknown[] = []) => {
      mock.queries.push({sql, params});
      if (sql.includes("select company_id from public.bank_sheet_configs where id=$1")) {
        return {rowCount:1, rows:[{company_id:Number(params[0]) === 3 ? 3 : 1}]};
      }
      if (sql.includes("from public.bank_sheet_configs config")) {
        return {rowCount:2,rows:[
          {id:2,company_id:1,label:"mutasi dev",tab_name:"mutasidev",bank_account_id:17,is_active:false},
          {id:3,company_id:1,label:"kas besar",tab_name:"kasbesar",bank_account_id:2,is_active:true},
        ]};
      }
      throw Error("UNEXPECTED_DB_QUERY");
    },
  },
}));

vi.mock("../lib/bankSheetScopedReader", () => ({
  getDevBankSheetReaderFromConfiguredSource: async (companyId: number) => {
    if (mock.readerFailure) throw new Error(mock.readerFailure);
    return ({
    query: async (sql: string, params: unknown[] = []) => {
      mock.queries.push({sql, params});
      if (sql.includes("select sheet_id, tab_name from public.bank_sheet_configs")) {
        return { rowCount:0, rows:[] };
      }
      if (Number(companyId) !== Number(params[0])) throw Error("COMPANY_SCOPE_MISMATCH");
      return {rowCount:2,rows:[
        {id:2,company_id:1,label:"mutasi dev",tab_name:"mutasidev",bank_account_id:17,is_active:false},
        {id:3,company_id:1,label:"kas besar",tab_name:"kasbesar",bank_account_id:2,is_active:true},
      ]};
    },
  });
  },
}));
import router from "../routes/bank-reconciliation";

describe("bank Sheet company-scoped HTTP authorization gate", () => {
  let server:Server;
  let base:string;
  beforeAll(async()=>{
    const app=express();
    app.use(express.json());
    app.use((req,_res,next)=>{
      (req as unknown as {log:unknown}).log={error:()=>undefined,warn:()=>undefined};
      next();
    });
    app.use("/api",router);
    server=createServer(app);
    server.listen(0,"127.0.0.1");
    await once(server,"listening");
    const addr=server.address();
    if(!addr||typeof addr==="string")throw Error("NO_HTTP_PORT");
    base="http://127.0.0.1:"+addr.port;
  });
  afterAll(async()=>await new Promise<void>(resolve=>server.close(()=>resolve())));
  beforeEach(()=>{
    vi.stubEnv("APP_ENV","development");
    mock.actor=null;
    mock.queries.length=0;
    mock.readerFailure=null;
  });
  afterEach(()=>vi.unstubAllEnvs());
  const get=(path:string)=>fetch(base+"/api"+path);
  const post=(path:string,body?:Record<string,unknown>)=>fetch(base+"/api"+path,{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify(body??{}),
  });
  it("rejects anonymous bank Sheet configuration listing before any SQL",async()=>{
    expect((await get("/bank-reconciliation/sheet-configs?company_id=1")).status).toBe(401);
    expect(mock.queries).toHaveLength(0);
  });
  it("accepts only company-scoped authenticated config list",async()=>{
    mock.actor={email:"owner@pr95.invalid",companyId:1,role:"super_admin"};
    const res=await get("/bank-reconciliation/sheet-configs?company_id=1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({configs:[
      {id:2,bank_account_id:17},{id:3,bank_account_id:2},
    ]});
    expect(mock.queries).toHaveLength(1);
    expect(mock.queries[0].params).toEqual([1]);
    expect(mock.queries[0].sql).toContain("where config.company_id=$1");
  });
  it("returns a safe DEV reader failure code without leaking raw exception text", async()=>{
    mock.actor={email:"owner@pr95.invalid",companyId:1,role:"super_admin"};
    mock.readerFailure="PR147_DEV_SHEET_READER_NOT_CONFIGURED";
    const known=await get("/bank-reconciliation/sheet-configs?company_id=1");
    expect(known.status).toBe(503);
    expect(await known.json()).toEqual({
      error:"Konfigurasi Google Sheet tidak dapat dimuat",
      code:"PR147_DEV_SHEET_READER_NOT_CONFIGURED",
    });
    mock.readerFailure="postgresql://secret:password@private.invalid";
    const unknown=await get("/bank-reconciliation/sheet-configs?company_id=1");
    expect(unknown.status).toBe(503);
    const body=await unknown.text();
    expect(body).toContain('"code":"BANK_SHEET_READER_UNAVAILABLE"');
    expect(body).not.toContain("password");
    expect(body).not.toContain("private.invalid");
    expect(mock.queries).toHaveLength(0);
  });
  it("requires explicit company for unscoped Super Admin DEV Sheet listing", async()=>{
    mock.actor={email:"owner@pr95.invalid",companyId:null,role:"super_admin"};
    expect((await get("/bank-reconciliation/sheet-configs")).status).toBe(400);
    expect(mock.queries).toHaveLength(0);
  });
  it("forbids company crossover with no query",async()=>{
    mock.actor={email:"owner@pr95.invalid",companyId:1,role:"super_admin"};
    expect((await get("/bank-reconciliation/sheet-configs?company_id=3")).status).toBe(403);
    expect(mock.queries).toHaveLength(0);
  });
  it("forbids anonymous Sheet test, create, sync and bulk sync",async()=>{
    for(const endpoint of [
      "/bank-reconciliation/sheet-configs/2/test",
      "/bank-reconciliation/sheet-configs",
      "/bank-reconciliation/sheet-configs/2/sync",
      "/bank-reconciliation/sheet-sync?company_id=1",
    ])expect((await post(endpoint)).status).toBe(401);
    expect(mock.queries).toHaveLength(0);
  });
  it("denies cross-company Sheet test and locks sync before any bank query",async()=>{
    mock.actor={email:"owner@pr95.invalid",companyId:1,role:"super_admin"};
    expect((await post("/bank-reconciliation/sheet-configs/3/test?company_id=3")).status).toBe(403);
    expect((await post("/bank-reconciliation/sheet-configs/3/sync")).status).toBe(423);
    expect(mock.queries).toHaveLength(0);
  });
  it("reads test config only through the company reader, not OTP pool",async()=>{
    mock.actor={email:"owner@pr95.invalid",companyId:1,role:"super_admin"};
    const r=await post("/bank-reconciliation/sheet-configs/2/test");
    expect(r.status).toBe(404);
    expect(mock.queries).toHaveLength(1);
    expect(mock.queries[0].sql).toContain("where id=$1 and company_id=$2");
    expect(mock.queries[0].params).toEqual([2,1]);
  });
  it("requires company for unscoped Super Admin test before DB access",async()=>{
    mock.actor={email:"owner@pr95.invalid",companyId:null,role:"super_admin"};
    expect((await post("/bank-reconciliation/sheet-configs/2/test")).status).toBe(400);
    expect(mock.queries).toHaveLength(0);
  });
  it("defaults source-only DEV to deny Sheet create and bulk sync with zero SQL",async()=>{
    mock.actor={email:"owner@pr95.invalid",companyId:1,role:"super_admin"};
    const create=await post("/bank-reconciliation/sheet-configs",{company_id:1,label:"fixture"});
    expect(create.status).toBe(423);
    expect(await create.json()).toMatchObject({code:"BANK_SHEET_DEV_SOURCE_ONLY_READ_ONLY"});
    const sync=await post("/bank-reconciliation/sheet-sync?company_id=1");
    expect(sync.status).toBe(423);
    expect(mock.queries).toHaveLength(0);
  });
  it("denies Sheet edit, delete and sync before any OTP-pool query",async()=>{
    mock.actor={email:"owner@pr95.invalid",companyId:1,role:"super_admin"};
    for(const [method,path] of [
      ["PUT","/bank-reconciliation/sheet-configs/2"],
      ["DELETE","/bank-reconciliation/sheet-configs/2"],
      ["POST","/bank-reconciliation/sheet-configs/2/sync"],
    ]) {
      const response=await fetch(base+"/api"+path,{method});
      expect(response.status).toBe(423);
      expect(await response.json()).toMatchObject({code:"BANK_SHEET_DEV_SOURCE_ONLY_READ_ONLY"});
    }
    expect(mock.queries).toHaveLength(0);
  });
  it("prevents bulk and create requests from crossing company scope",async()=>{
    mock.actor={email:"owner@pr95.invalid",companyId:1,role:"super_admin"};
    expect((await post("/bank-reconciliation/sheet-sync?company_id=3")).status).toBe(403);
    expect((await post("/bank-reconciliation/sheet-configs",{company_id:3,label:"wrong"})).status).toBe(403);
    expect(mock.queries).toHaveLength(0);
  });
});