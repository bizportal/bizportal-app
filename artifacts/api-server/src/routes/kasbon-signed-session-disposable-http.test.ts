import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { hash } from "bcryptjs";

/**
 * Authenticates via the real POST /auth/email-login and real signed-cookie
 * getProductionSession + getProductionUser, with a disposable localhost PG.
 * Only @workspace/db connection selection and the finance-scoped reader
 * adapter are replaced; the actual login and Advance route are unmocked.
 */
const enabled = Boolean(process.env.KASBON_SIGNED_PG_URL);
const shared = vi.hoisted(() => ({
  client: null as null | { query: (sql:string, args?:unknown[])=>Promise<{rows:Record<string,unknown>[];rowCount:number|null}>;
    connect: ()=>Promise<unknown>; end: ()=>Promise<void> },
}));
vi.mock("@workspace/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@workspace/db")>();
  return {
    ...real,
    pool: {
      query: (sql:string, args?:unknown[]) => {
        if (!shared.client) throw Error("CI_POOL_UNAVAILABLE");
        return shared.client.query(sql,args);
      },
      connect: () => {
        if (!shared.client) throw Error("CI_POOL_UNAVAILABLE");
        return shared.client.connect();
      },
      end: () => shared.client?.end(),
    },
  };
});
vi.mock("./payroll-prod-db", () => ({
  payrollReadOnlyReady: () => true,
  payrollScopedQuery: async (companyId:number, sql:string, args:unknown[]) => {
    if (!shared.client) throw Error("CI_POOL_UNAVAILABLE");
    const client = await shared.client.connect() as {
      query:(sql:string,values?:unknown[])=>Promise<{rows:Record<string,unknown>[];rowCount:number|null}>;
      release:()=>void;
    };
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL ROLE ci_kasbon_reader");
      await client.query("SELECT set_config('app.payroll_company_id',$1,true)", [String(companyId)]);
      const identity = await client.query(
        "SELECT current_user role,current_setting('app.payroll_company_id',true) company,current_setting('transaction_read_only') read_only",
      );
      if (identity.rows[0]?.role !== "ci_kasbon_reader" ||
          identity.rows[0]?.company !== String(companyId) ||
          identity.rows[0]?.read_only !== "on") throw Error("CI_ROLE_SCOPE_INVALID");
      const result = await client.query(sql,args);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(()=>undefined);
      throw error;
    } finally {
      client.release();
    }
  },
}));

describe.skipIf(!enabled)("signed production session + Kasbon HTTP and disposable PG", () => {
  let server:Server;
  let base:string;
  const alice="alice@example.test", bob="bob@example.test";
  let aliceCookie="", bobCookie="";
  const companyOne=900001, companyTwo=900002;
  const request=(path:string, cookie?:string)=>fetch(base+path,{
    headers: cookie ? {cookie} : {},
    redirect:"manual",
  });

  async function login(email:string,password:string):Promise<{status:number;cookie:string}> {
    const r=await fetch(base+"/api/auth/email-login",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({email,password}),
    });
    const raw=r.headers.get("set-cookie") ?? "";
    return {status:r.status,cookie:raw.split(";")[0] ?? ""};
  }

  beforeAll(async () => {
    const raw=process.env.KASBON_SIGNED_PG_URL;
    if (!raw) throw Error("CI_URL_MISSING");
    const url=new URL(raw);
    if(url.protocol!=="postgresql:" || url.hostname!=="127.0.0.1" ||
       url.port!=="65432" || url.pathname!=="/kasbon_auth_ci" ||
       url.username!=="postgres") throw Error("REFUSE_NON_DISPOSABLE_DB");
    process.env.APP_ENV="production";
    process.env.NODE_ENV="test";
    process.env.BIZPORTAL_SESSION_SECRET="synthetic-ci-secret-not-used-outside-test-00001";
    const {createDedicatedPayrollPool}=await import("@workspace/db");
    const pool=createDedicatedPayrollPool(raw);
    shared.client=pool;
    const ddl=[
      "CREATE TABLE public.users (id text primary key,email text,role text,company_id integer,status text,is_active boolean,password_hash text)",
      "CREATE TABLE public.employees (id integer primary key,company_id integer,first_name text,last_name text)",
      `CREATE TABLE public.cash_advances (
        id integer primary key,company_id integer,employee_id integer,advance_number text,
        date date,type text,amount numeric,remaining_amount numeric,settled_amount numeric,
        paid_amount numeric,status text,lifecycle_status text,posting_status text,
        approved_at timestamptz,approved_by text,disbursed_at timestamptz,disbursed_by text,
        accounting_entry_id integer,voided_at timestamptz)`,
    ];
    for(const sql of ddl) await pool.query(sql);
    const password=await hash("ci-password-never-production",4);
    for(const [id,email,company] of [["a",alice,companyOne],["b",bob,companyTwo]] as const) {
      await pool.query("INSERT INTO public.users VALUES($1,$2,'admin',$3,'active',true,$4)",[id,email,company,password]);
    }
    await pool.query("INSERT INTO public.employees VALUES(1,900001,'Synthetic','One'),(2,900002,'Synthetic','Two')");
    await pool.query(`INSERT INTO public.cash_advances
      (id,company_id,employee_id,advance_number,date,type,amount,remaining_amount,settled_amount,paid_amount,status,lifecycle_status,posting_status)
      VALUES (101,900001,1,'CI-001','2099-11-01','kasbon',100,100,0,0,'DRAFT','outstanding','PENDING'),
             (202,900002,2,'CI-002','2099-11-02','kasbon',200,200,0,0,'DRAFT','outstanding','PENDING')`);
    await pool.query("CREATE ROLE ci_kasbon_reader NOLOGIN NOBYPASSRLS");
    await pool.query("GRANT USAGE ON SCHEMA public TO ci_kasbon_reader");
    await pool.query("GRANT SELECT ON public.employees,public.cash_advances TO ci_kasbon_reader");
    for(const table of ["employees","cash_advances"]) {
      await pool.query(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      await pool.query(`CREATE POLICY ci_${table}_scope ON public.${table} FOR SELECT TO ci_kasbon_reader
        USING (company_id = NULLIF(current_setting('app.payroll_company_id',true),'')::integer)`);
    }

    const {default:localAuth}=await import("./local-production-auth");
    const {default:advances}=await import("./advance-kasbon-readonly");
    const app=express();
    app.use((req,_res,next)=>{req.log={error:vi.fn()} as unknown as typeof req.log;next()});
    app.use(express.json());app.use("/api",localAuth);app.use("/api",advances);
    server=createServer(app);server.listen(0,"127.0.0.1");
    await once(server,"listening");
    const address=server.address();
    if(!address || typeof address==="string")throw Error("NO_LISTENER");
    base="http://127.0.0.1:"+address.port;
    const a=await login(alice,"ci-password-never-production");
    const b=await login(bob,"ci-password-never-production");
    expect(a.status).toBe(200);expect(b.status).toBe(200);
    aliceCookie=a.cookie;bobCookie=b.cookie;
    expect(aliceCookie).toContain("bizportal_supabase_session=");
  });
  afterAll(async()=>{
    if(server) await new Promise<void>(r=>server.close(()=>r()));
    if(shared.client)await shared.client.end();
    shared.client=null;
    delete process.env.BIZPORTAL_SESSION_SECRET;
  });
  beforeEach(async()=>{
    if(!shared.client)throw Error("CI_POOL_UNAVAILABLE");
    await shared.client.query("UPDATE public.users SET is_active=true,role='admin',status='active'");
  });

  it("creates signed login cookies and returns only scoped tenant rows",async()=>{
    const a=await request("/api/advances?companyId=900001",aliceCookie);
    expect(a.status).toBe(200);
    expect((await a.json() as {data:Array<{advance_number:string}>}).data.map(x=>x.advance_number)).toEqual(["CI-001"]);
    const b=await request("/api/advances?companyId=900002",bobCookie);
    expect(b.status).toBe(200);
    expect((await b.json() as {data:Array<{advance_number:string}>}).data.map(x=>x.advance_number)).toEqual(["CI-002"]);
  });
  it("rejects tampered and unsigned cookies",async()=>{
    expect((await request("/api/advances?companyId=900001")).status).toBe(401);
    const tampered=aliceCookie.slice(0,-1)+(aliceCookie.endsWith("A")?"B":"A");
    expect((await request("/api/advances?companyId=900001",tampered)).status).toBe(401);
  });
  it("rejects signed cross-tenant requests",async()=>{
    expect((await request("/api/advances?companyId=900002",aliceCookie)).status).toBe(403);
    expect((await request("/api/advances?companyId=900001",bobCookie)).status).toBe(403);
  });
  it("rejects wrong password without issuing a cookie",async()=>{
    const failed=await login(alice,"invalid-password");
    expect(failed.status).toBe(401);
    expect(failed.cookie).not.toContain("bizportal_supabase_session");
  });
  it("checks current stored role after issuing cookie",async()=>{
    await shared.client!.query("UPDATE public.users SET role='staff' WHERE email=$1",[alice]);
    expect((await request("/api/advances?companyId=900001",aliceCookie)).status).toBe(403);
  });
  it("revokes an existing signed session when the account is deactivated",async()=>{
    await shared.client!.query("UPDATE public.users SET is_active=false WHERE email=$1",[alice]);
    expect((await request("/api/advances?companyId=900001",aliceCookie)).status).toBe(403);
  });
  it("revokes an existing signed session when account status becomes inactive",async()=>{
    await shared.client!.query("UPDATE public.users SET status='resigned' WHERE email=$1",[alice]);
    expect((await request("/api/advances?companyId=900001",aliceCookie)).status).toBe(403);
  });
  it("fails closed when account activation field is missing",async()=>{
    await shared.client!.query("UPDATE public.users SET is_active=NULL WHERE email=$1",[alice]);
    expect((await request("/api/advances?companyId=900001",aliceCookie)).status).toBe(403);
  });
  it("ensures writer endpoint remains unavailable",async()=>{
    const response=await fetch(base+"/api/advances?companyId=900001",{
      method:"POST",headers:{"content-type":"application/json",cookie:aliceCookie},body:"{}",
    });
    expect([404,405]).toContain(response.status);
  });
});
