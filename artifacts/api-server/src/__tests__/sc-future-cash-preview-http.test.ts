import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

const mock=vi.hoisted(()=>({
  signed:true, enabled:true,
  actor:{role:"super_admin",companyId:null as number|null},
  queries:[] as Array<{sql:string,params:unknown[]}>,
  accountValid:true, contraValid:true, dbFailure:false,
}));
vi.mock("../routes/dev-auth",()=>({
  isDevelopmentEnvironment:()=>process.env.APP_ENV==="development",
  isSignedOtpDevEnabled:()=>mock.enabled,
  getProductionSession:()=>mock.signed?{id:"owner-session"}:null,
  getProductionUser:async()=>mock.actor,
}));
vi.mock("@workspace/db",()=>({
  pool:{query:async(sql:string,params:unknown[]=[])=>{
    mock.queries.push({sql,params});
    if(mock.dbFailure)throw Error("UNAVAILABLE_BACKEND");
    if(sql.includes("from public.company_bank_accounts a"))return {rows:[{
      id:18,name:"Kas Besar SC",account_type:"cash",is_active:true,
      opening_balance:"0.00",created_at:"2026-11-25 18:01:03.692741",
      notes:mock.accountValid?"tidak digunakan untuk migrasi transaksi historis":"",
      cash_coa_id:75839,cash_coa_code:"1-1011-CST",
      coa_active:true,is_postable:true,is_header:false,
    }]};
    if(sql.includes("from public.chart_of_accounts")){
      const row={id:902,company_id:1,code:"5-2010-CST",name:"Beban Operasional",
        is_active:mock.contraValid,is_postable:true,is_header:false};
      return {rows:[row]};
    }
    throw Error("UNEXPECTED_QUERY");
  }},
}));
import route from "../routes/sc-future-cash-preview";

describe("Owner-only Account18 future cash readonly preview HTTP",()=>{
  let server:Server,base:string;
  const url="/api/cash-bank/sc-new";
  const input={companyId:1,accountId:18,date:"2026-11-27",direction:"IN",
    amount:"150000.25",counterCoaId:902};
  beforeAll(async()=>{
    const app=express();app.use(express.json());app.use("/api",route);
    server=createServer(app);server.listen(0,"127.0.0.1");
    await once(server,"listening");
    const address=server.address();
    if(!address||typeof address==="string")throw Error("PORT");
    base="http://127.0.0.1:"+address.port;
  });
  afterAll(async()=>await new Promise<void>(resolve=>server.close(()=>resolve())));
  beforeEach(()=>{
    vi.stubEnv("APP_ENV","development");
    mock.signed=true;mock.enabled=true;mock.actor={role:"super_admin",companyId:null};
    mock.accountValid=true;mock.contraValid=true;mock.dbFailure=false;mock.queries.length=0;
  });
  afterEach(()=>vi.unstubAllEnvs());
  const get=(company="1")=>fetch(base+url+"/readiness?company_id="+company);
  const post=(inputBody:unknown=input,origin="https://dev-bizportal.cstlogistic.co.id")=>
    fetch(base+url+"/preview",{
      method:"POST",headers:{"content-type":"application/json",origin},
      body:JSON.stringify(inputBody),
    });
  it("blocks PROD and absent signed OTP without SQL",async()=>{
    vi.stubEnv("APP_ENV","production");
    expect((await get()).status).toBe(404);
    expect((await post()).status).toBe(404);
    vi.stubEnv("APP_ENV","development");
    mock.enabled=false;expect((await get()).status).toBe(503);
    mock.enabled=true;mock.signed=false;expect((await get()).status).toBe(401);
    expect(mock.queries).toHaveLength(0);
  });
  it("rejects non-owner, different company and wrong scope",async()=>{
    mock.actor={role:"finance",companyId:1};
    expect((await get()).status).toBe(403);
    mock.actor={role:"owner",companyId:3};
    expect((await get()).status).toBe(403);
    mock.actor={role:"owner",companyId:1};
    expect((await get("3")).status).toBe(403);
    expect((await post({...input,accountId:1})).status).toBe(403);
    expect(mock.queries).toHaveLength(0);
  });
  it("readiness lists only candidate COA and always blocks posting",async()=>{
    const r=await get();
    expect(r.status).toBe(200);
    const result=await r.json();
    expect(result).toMatchObject({
      mode:"READ_ONLY_FUTURE_CASH_DEV",postingAllowed:false,
      signedOwnerSession:"VERIFIED",historicalSheetConfig5:"NOT_USED_NONMIGRATION",
      account:{id:18,coaId:75839,coaCode:"1-1011-CST",openingBalance:"0.00"},
      contraCandidates:[{id:902,code:"5-2010-CST",name:"Beban Operasional"}],
    });
    expect(result.reasons).toContain("PRIMARY_CASH_DOCUMENT_NOT_VERIFIED");
    expect(mock.queries).toHaveLength(2);
  });
  it("preview produces exact balanced IN/OUT legs without returning a source key",async()=>{
    const incoming=await post();
    expect(incoming.status).toBe(200);
    const parsed=await incoming.json();
    expect(parsed).toMatchObject({
      postingAllowed:false,mode:"READ_ONLY_IN_MEMORY_DRAFT",
      amount:"150000.25",counterCoaClassification:"UNVERIFIED_PRIMARY_DOCUMENT",
      proposedLines:[
        {coaId:75839,debit:"150000.25",credit:"0.00"},
        {coaId:902,debit:"0.00",credit:"150000.25"},
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain("sourceKey");
    const outgoing=await post({...input,direction:"OUT",amount:"45000.75"});
    expect(outgoing.status).toBe(200);
    expect((await outgoing.json()).proposedLines).toMatchObject([
      {debit:"0.00",credit:"45000.75"},
      {debit:"45000.75",credit:"0.00"},
    ]);
  });
  it("rejects spoofed proof, foreign origin, invalid amounts, old source dates",async()=>{
    expect((await post(input,"https://another.invalid")).status).toBe(403);
    expect((await post({...input,ownerApproved:true})).status).toBe(400);
    expect((await post({...input,voucherId:"11111111-1111-4111-8111-111111111111"})).status).toBe(400);
    expect((await post({...input,counterCoaId:75839})).status).toBe(400);
    expect((await post({...input,date:"2026-06-22"})).status).toBe(400);
    expect((await post({...input,date:"2026-02-30"})).status).toBe(400);
    expect((await post({...input,amount:"150000.251"})).status).toBe(400);
  });
  it("fails closed for inactive counter and invalid Account18 baseline",async()=>{
    mock.contraValid=false;expect((await post()).status).toBe(422);
    mock.contraValid=true;mock.accountValid=false;
    expect((await get()).status).toBe(409);
    expect((await post()).status).toBe(409);
  });
  it("does not leak database errors or execute any DML",async()=>{
    mock.dbFailure=true;
    const failed=await get();
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("UNAVAILABLE_BACKEND");
    mock.dbFailure=false;await get();await post();
    expect(mock.queries.length).toBeGreaterThan(0);
    for(const query of mock.queries){
      expect(query.sql.trim().toLowerCase().startsWith("select")).toBe(true);
      expect(query.sql).not.toMatch(/\b(insert|update|delete)\b/i);
    }
  });
});
