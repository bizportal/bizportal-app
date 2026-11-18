import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import pg from "pg";

/** Test-only: real signed cookie + real user query; candidate writer is mocked.
 * This is NOT an OTP-delivery test or production route E2E.
 */
const enabled = Boolean(process.env.PR95_ATOMIC_PG_URL);
const shared = vi.hoisted(() => ({
  pool: null as null | { query: (sql:string,params?:unknown[])=>Promise<{rows:Record<string,unknown>[]}> },
}));
vi.mock("@workspace/db",()=>({
  pool: { query:(sql:string,args?:unknown[])=>{
    if(!shared.pool)throw Error("PR95_TEST_POOL_UNAVAILABLE");
    return shared.pool.query(sql,args);
  }},
  getRuntimeDatabaseUrl:async()=>{throw Error("PR95_CI_NO_EXTERNAL_DB");},
}));
vi.mock("../lib/outboundSourceReuseCandidate",()=>({
  finalizeOutboundSourceReuseCandidate:vi.fn(),
}));
import { finalizeOutboundSourceReuseCandidate } from "../lib/outboundSourceReuseCandidate";
import { runOutboundReuseSignedDevCandidate } from "../lib/outboundSourceReuseDevBridge";
import { setProductionSessionCookie } from "../routes/dev-auth";
import type { OutboundReuseQueryClient } from "../lib/outboundReuseFinalityReader";

describe.skipIf(!enabled)("PR95 signed DEV session and role/company scope through isolated HTTP",()=>{
  let db:pg.Client;
  let server:Server;
  let base="";
  let cookie="";
  const previous={
    env:process.env.APP_ENV,
    flag:process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV,
    secret:process.env.BIZPORTAL_SESSION_SECRET,
    writer:process.env.PR95_OUTBOUND_SOURCE_REUSE_ENABLED_DEV,
  };
  const candidate=vi.mocked(finalizeOutboundSourceReuseCandidate);
  const tx={query:async()=>{throw Error("PR95_AUTH_TEST_MUST_NOT_QUERY_WRITER");}} as OutboundReuseQueryClient;
  const request=async(companyId:number,sessionCookie=cookie)=>fetch(base+"/__test__/outbound-reuse",{
    method:"POST",
    headers:{"content-type":"application/json",...(sessionCookie?{cookie:sessionCookie}:{})},
    body:JSON.stringify({companyId,mutationId:90001,invoiceId:7}),
  });
  beforeAll(async()=>{
    const parsed=new URL(process.env.PR95_ATOMIC_PG_URL!);
    if(parsed.hostname!=="127.0.0.1"||parsed.port!=="65433"||
      parsed.pathname!=="/pr95_ci"||parsed.username!=="postgres.xssrfshdrtdfupgqwfdw")
      throw Error("PR95_REFUSE_NON_DISPOSABLE_DB");
    process.env.APP_ENV="development";
    process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV="true";
    process.env.BIZPORTAL_SESSION_SECRET="pr95-ci-isolated-signed-session-only-0001";
    process.env.PR95_OUTBOUND_SOURCE_REUSE_ENABLED_DEV="true";
    db=new pg.Client({connectionString:process.env.PR95_ATOMIC_PG_URL});
    await db.connect();
    shared.pool=db;
    await db.query(`
      CREATE TABLE public.users (
        id text primary key,email text,role text,company_id integer,
        is_active boolean,status text
      );
      INSERT INTO public.users VALUES
        ('signed-user','admin@example.invalid','super_admin',1,true,'active'),
        ('other-user','other@example.invalid','super_admin',2,true,'active');
    `);
    candidate.mockResolvedValue({
      mutationId:90001,invoiceId:7,sourceEntryId:314,paymentMatchingGroupId:9,
    });
    const app=express();
    app.use(express.json({limit:"4kb"}));
    app.post("/__test__/outbound-reuse",async(req,res)=>{
      try{
        const body=req.body as {companyId:number;mutationId:number;invoiceId:number};
        const output=await runOutboundReuseSignedDevCandidate(req,tx,body);
        res.status(200).json({ok:true,output});
      }catch(err){
        res.status(403).json({ok:false,reason:err instanceof Error?err.message:"rejected"});
      }
    });
    server=createServer(app);
    server.listen(0,"127.0.0.1");
    await once(server,"listening");
    const addr=server.address();
    if(!addr||typeof addr==="string")throw Error("PR95_NO_HTTP_LISTENER");
    base="http://127.0.0.1:"+addr.port;
    const issued=Date.now();
    const cookies:string[]=[];
    setProductionSessionCookie({
      append:(header:string,value:string)=>{if(header==="Set-Cookie")cookies.push(value);},
    } as never,{id:"signed-user",email:"admin@example.invalid",issuedAt:issued,expiresAt:issued+60000});
    cookie=(cookies[0]??"").split(";")[0]??"";
    expect(cookie).toContain("bizportal_supabase_session=");
  });
  beforeEach(async()=>{
    candidate.mockClear();
    await db.query("UPDATE public.users SET role='super_admin',is_active=true,status='active' WHERE id='signed-user'");
    process.env.PR95_OUTBOUND_SOURCE_REUSE_ENABLED_DEV="true";
  });
  afterAll(async()=>{
    if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
    if(db){await db.query("DROP TABLE public.users");await db.end();}
    shared.pool=null;
    for(const [key,value] of Object.entries({
      APP_ENV:previous.env,
      BIZPORTAL_SIGNED_OTP_ENABLED_DEV:previous.flag,
      BIZPORTAL_SESSION_SECRET:previous.secret,
      PR95_OUTBOUND_SOURCE_REUSE_ENABLED_DEV:previous.writer,
    })){
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
  });
  it("uses genuine signed cookie plus DB-revalidated Super Admin/company before candidate",async()=>{
    const reply=await request(1);
    expect(reply.status).toBe(200);
    expect(candidate).toHaveBeenCalledTimes(1);
    expect(candidate).toHaveBeenCalledWith(tx,{
      companyId:1,mutationId:90001,invoiceId:7,
      verifiedActorEmail:"admin@example.invalid",
    });
  });
  it("rejects no cookie, tampering and other company",async()=>{
    expect((await request(1,"")).status).toBe(403);
    const bad=cookie.slice(0,-1)+(cookie.endsWith("A")?"B":"A");
    expect((await request(1,bad)).status).toBe(403);
    expect((await request(2)).status).toBe(403);
    expect(candidate).not.toHaveBeenCalled();
  });
  it("rejects role downgrade, disabled account, and OFF flag without calling candidate",async()=>{
    await db.query("UPDATE public.users SET role='finance' WHERE id='signed-user'");
    expect((await request(1)).status).toBe(403);
    await db.query("UPDATE public.users SET role='super_admin',is_active=false WHERE id='signed-user'");
    expect((await request(1)).status).toBe(403);
    await db.query("UPDATE public.users SET is_active=true WHERE id='signed-user'");
    delete process.env.PR95_OUTBOUND_SOURCE_REUSE_ENABLED_DEV;
    expect((await request(1)).status).toBe(403);
    expect(candidate).not.toHaveBeenCalled();
  });
});
