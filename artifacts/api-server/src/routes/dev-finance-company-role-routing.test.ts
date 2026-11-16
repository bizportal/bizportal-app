import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/** Test source-only company pool routing. Never call real GCP/Supabase. */
const m=vi.hoisted(()=>({
  secret:vi.fn(),
  poolOptions:[] as Array<Record<string,any>>,
  transactions:[] as Array<{role:string,company:string,queries:string[]}>,
  roleOverride:null as string|null,
  elevated:false,
  rls:true,
  restrictivePolicies:11,
  memberships:0,
  isolatedLogin:true,
}));
vi.mock("@workspace/db/gcp-database-secret",()=>({readSecret:m.secret}));
vi.mock("pg",()=>({default:{Pool:class {
  options:Record<string,any>;
  constructor(options:Record<string,any>){this.options=options;m.poolOptions.push(options)}
}}}));
vi.mock("drizzle-orm/node-postgres",()=>({
  drizzle:(pool:{options:Record<string,any>})=>({
    transaction:async <T>(work:(tx:any)=>Promise<T>)=>{
      const role=m.roleOverride??String(pool.options.user).split(".")[0];
      const trace={role,company:"",queries:[] as string[]};
      m.transactions.push(trace);
      const tx={
        execute:async(query:unknown)=>{
          const statement=new PgDialect().sqlToQuery(query as any);
          trace.queries.push(statement.sql);
          if(statement.sql.trim().toUpperCase()==="SET TRANSACTION READ ONLY")return{rows:[]};
          if(statement.sql.includes("current_user::text")) return{rows:[{
            db_role:role,login_role:role,elevated:m.elevated,
            po_rls:m.rls,po_lines_rls:m.rls,
            shipments_rls:m.rls,shipment_items_rls:m.rls,
            receipts_rls:m.rls,receipt_items_rls:m.rls,
            invoice_rls:m.rls,invoice_lines_rls:m.rls,
            ap_rls:m.rls,payment_rls:m.rls,handoff_rls:m.rls,
          }]};
          if(statement.sql.includes("pg_catalog.pg_policy")) {
            return{rows:[{
              guarded_tables:m.restrictivePolicies,
              isolated_login:m.isolatedLogin,
              memberships:m.memberships,
            }]};
          }
          if(statement.sql.includes("set_config")){
            trace.company=String(statement.params[0]);
            return{rows:[{set_config:trace.company}]};
          }
          if(statement.sql.includes("current_setting"))return{rows:[{company_id:trace.company}]};
          throw Error("UNEXPECTED_FINANCE_SQL");
        }
      };
      return work(tx);
    },
  }),
}));
const KEYS=[
 "APP_ENV","BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV",
 "BIZPORTAL_MARKETPLACE_FINANCE_READONLY_ENABLED_DEV",
 "BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV",
 "BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV",
 "BIZPORTAL_MARKETPLACE_FINANCE_GCP_SECRET_NAME_DEV",
] as const;
const originals=Object.fromEntries(KEYS.map(key=>[key,process.env[key]]));
const PROJECT="xssrfshdrtdfupgqwfdw";
const ROLE={
  cst:"bizportal_finance_cst_login_dev",
  diva:"bizportal_finance_diva_login_dev",
};
const SECRET={
  cst:"bizportal-marketplace-finance-dev-cst",
  diva:"bizportal-marketplace-finance-dev-diva",
};
const url=(role:string,password="synthetic")=>
  "postgresql://"+role+"."+PROJECT+":"+password+
  "@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres"+
  "?sslmode=verify-full&sslrootcert=/trusted/synthetic-ca.crt";

const load=async()=>import("@workspace/db");
describe("DEV-only company Finance pool routing is fail closed",()=>{
 beforeEach(()=>{
  vi.resetModules();
  for(const key of KEYS)delete process.env[key];
  process.env.APP_ENV="development";
  process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV="true";
  process.env.BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV="true";
  m.secret.mockReset();
  m.poolOptions.length=0;
  m.transactions.length=0;
  m.roleOverride=null;
  m.elevated=false;
  m.rls=true;
  m.restrictivePolicies=11;
  m.memberships=0;
  m.isolatedLogin=true;
  m.secret.mockImplementation(async(secretName:string)=>{
    if(secretName===SECRET.cst)return url(ROLE.cst);
    if(secretName===SECRET.diva)return url(ROLE.diva);
    throw Error("UNKNOWN_COMPANY_SECRET");
  });
 });
 afterEach(()=>{
  for(const key of KEYS){
    if(originals[key]===undefined)delete process.env[key];
    else process.env[key]=originals[key];
  }
 });
 it("uses distinct verified company pool identities and tenant scopes",async()=>{
  const mod=await load();
  const cst=await mod.withMarketplaceFinanceDevTransaction(1,async()=> "cst-ok");
  const diva=await mod.withMarketplaceFinanceDevTransaction(3,async()=> "diva-ok");
  expect(cst).toBe("cst-ok");expect(diva).toBe("diva-ok");
  expect(m.secret.mock.calls.map(call=>call[0])).toEqual([SECRET.cst,SECRET.diva]);
  expect(m.poolOptions.map(p=>p.user)).toEqual([
    ROLE.cst+"."+PROJECT,ROLE.diva+"."+PROJECT
  ]);
  expect(m.transactions.map(t=>[t.role,t.company])).toEqual([
    [ROLE.cst,"1"],[ROLE.diva,"3"]
  ]);
  for(const opt of m.poolOptions){
    expect(opt).not.toHaveProperty("connectionString");
    expect(opt.max).toBe(1);
    expect(opt.ssl).toMatchObject({rejectUnauthorized:true,servername:"aws-0-ap-southeast-2.pooler.supabase.com"});
  }
 });
 it("cannot select unsupported company 2 (Wangsamas) or arbitrary company",async()=>{
  const mod=await load();
  const work=vi.fn();
  await expect(mod.withMarketplaceFinanceDevTransaction(2,work))
    .rejects.toThrow("DEV_FINANCE_COMPANY_NOT_ALLOWLISTED");
  await expect(mod.withMarketplaceFinanceDevTransaction(999,work))
    .rejects.toThrow("DEV_FINANCE_COMPANY_NOT_ALLOWLISTED");
  expect(work).not.toHaveBeenCalled();
  expect(m.secret).not.toHaveBeenCalled();
  expect(m.poolOptions).toHaveLength(0);
 });
 it("refuses either shared legacy credential when company mode is enabled",async()=>{
  const mod=await load();
  process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV=url("bizportal_marketplace_finance_login_dev");
  await expect(mod.withMarketplaceFinanceDevTransaction(1,async()=>true))
    .rejects.toThrow("DEV_FINANCE_LEGACY_CREDENTIAL_IN_COMPANY_MODE");
  delete process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV;
  process.env.BIZPORTAL_MARKETPLACE_FINANCE_GCP_SECRET_NAME_DEV="bizportal-marketplace-finance-dev";
  await expect(mod.withMarketplaceFinanceDevTransaction(3,async()=>true))
    .rejects.toThrow("DEV_FINANCE_LEGACY_CREDENTIAL_IN_COMPANY_MODE");
  expect(m.secret).not.toHaveBeenCalled();
  expect(m.poolOptions).toHaveLength(0);
 });
 it("blocks the original generic Finance resolver as fallback",async()=>{
  const mod=await load();
  await expect(mod.resolveMarketplaceFinanceDevDatabaseUrl())
    .rejects.toThrow("DEV_FINANCE_LEGACY_ROLE_DISABLED_IN_COMPANY_MODE");
  expect(m.secret).not.toHaveBeenCalled();
 });
 it("rejects swapped CST/Diva secret roles before opening a pool",async()=>{
  const mod=await load();
  m.secret.mockResolvedValue(url(ROLE.diva));
  await expect(mod.withMarketplaceFinanceDevTransaction(1,async()=>true))
    .rejects.toThrow("DEV_FINANCE_DATABASE_IDENTITY_INVALID");
  expect(m.poolOptions).toHaveLength(0);
 });
 it("requires pinned verified TLS and refuses privileged or driver-level overrides",async()=>{
  const mod=await load();
  for(const bad of [
    url(ROLE.cst).replace("sslmode=verify-full","sslmode=require"),
    url(ROLE.cst).replace("sslrootcert=/trusted/synthetic-ca.crt","sslrootcert=relative.crt"),
    url("postgres"),
    url(ROLE.cst)+"&user=postgres",
    url(ROLE.cst)+"&sslmode=disable",
    url(ROLE.cst).replace(PROJECT,"nzdweipzckfszczzqtuw"),
  ]){
    m.secret.mockResolvedValueOnce(bad);
    await expect(mod.withMarketplaceFinanceDevTransaction(1,async()=>true)).rejects.toThrow();
    expect(m.poolOptions).toHaveLength(0);
  }
 });
 it("rejects missing company secret without connecting to default pool",async()=>{
  const mod=await load();
  m.secret.mockRejectedValue(new Error("SYNTHETIC_GCP_SECRET_MISSING"));
  await expect(mod.withMarketplaceFinanceDevTransaction(1,async()=>true))
    .rejects.toThrow("SYNTHETIC_GCP_SECRET_MISSING");
  expect(m.poolOptions).toHaveLength(0);
 });
 it("verifies session_user and current_user match their approved company role",async()=>{
  const mod=await load();
  m.roleOverride=ROLE.diva;
  const work=vi.fn();
  await expect(mod.withMarketplaceFinanceDevTransaction(1,work))
    .rejects.toThrow("DEV_FINANCE_ROLE_OR_RLS_UNVERIFIED");
  expect(work).not.toHaveBeenCalled();
 });
 it("never enables the Writer from GET-only flag alone",async()=>{
  const mod=await load();
  delete process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV;
  process.env.BIZPORTAL_MARKETPLACE_FINANCE_READONLY_ENABLED_DEV="true";
  const work=vi.fn();
  await expect(mod.withMarketplaceFinanceDevTransaction(1,work))
    .rejects.toThrow("DEV_FINANCE_WRITER_DISABLED");
  expect(m.secret).not.toHaveBeenCalled();
  await expect(mod.withMarketplaceFinanceDevReadOnlyTransaction(1,async()=>true)).resolves.toBe(true);
  expect(m.transactions[0].queries[0].trim().toUpperCase()).toBe("SET TRANSACTION READ ONLY");
 });
 it("refuses company mode in PROD even when every feature flag is enabled",async()=>{
  const mod=await load();
  process.env.APP_ENV="production";
  await expect(mod.withMarketplaceFinanceDevTransaction(1,async()=>true))
    .rejects.toThrow("DEV_FINANCE_DISABLED");
  expect(m.poolOptions).toHaveLength(0);
 });
 it("rejects missing RLS or elevated role without entering business callback",async()=>{
  const mod=await load();
  const work=vi.fn();
  m.rls=false;
  await expect(mod.withMarketplaceFinanceDevTransaction(1,work))
    .rejects.toThrow("DEV_FINANCE_ROLE_OR_RLS_UNVERIFIED");
  m.rls=true;
  m.elevated=true;
  await expect(mod.withMarketplaceFinanceDevTransaction(3,work))
    .rejects.toThrow("DEV_FINANCE_ROLE_OR_RLS_UNVERIFIED");
  expect(work).not.toHaveBeenCalled();
 });
 it("refuses switching an already initialized company-bound process back to legacy credentials",async()=>{
  const mod=await load();
  await mod.withMarketplaceFinanceDevTransaction(1,async()=>true);
  delete process.env.BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV;
  const work=vi.fn();
  await expect(mod.withMarketplaceFinanceDevTransaction(1,work))
    .rejects.toThrow("DEV_FINANCE_CREDENTIAL_MODE_CHANGED_RESTART_REQUIRED");
  expect(work).not.toHaveBeenCalled();
  expect(m.poolOptions).toHaveLength(1);
 });
 it("never reuses a company pool when the GCP secret rotates",async()=>{
  const mod=await load();
  const start=Date.now();
  const clock=vi.spyOn(Date,"now");
  try {
    await mod.withMarketplaceFinanceDevTransaction(1,async()=>true);
    expect(m.poolOptions).toHaveLength(1);
    clock.mockReturnValue(start+61_000);
    m.secret.mockResolvedValueOnce(url(ROLE.cst,"synthetic-rotated"));
    const work=vi.fn();
    await expect(mod.withMarketplaceFinanceDevTransaction(1,work))
      .rejects.toThrow("DEV_FINANCE_COMPANY_CREDENTIAL_CHANGED_RESTART_REQUIRED");
    expect(work).not.toHaveBeenCalled();
    expect(m.poolOptions).toHaveLength(1);
  } finally {
    clock.mockRestore();
  }
 });
 it("refuses changing an initialized legacy Finance pool into company mode without restart",async()=>{
  delete process.env.BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV;
  process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV=
    url("bizportal_marketplace_finance_login_dev");
  const mod=await load();
  await mod.withMarketplaceFinanceDevTransaction(1,async()=>true);
  expect(m.poolOptions).toHaveLength(1);
  delete process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV;
  process.env.BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV="true";
  const work=vi.fn();
  await expect(mod.withMarketplaceFinanceDevTransaction(1,work))
    .rejects.toThrow("DEV_FINANCE_CREDENTIAL_MODE_CHANGED_RESTART_REQUIRED");
  expect(work).not.toHaveBeenCalled();
  expect(m.poolOptions).toHaveLength(1);
 });
 it("fails closed before callback if any restrictive company policy is missing",async()=>{
  const mod=await load();
  m.restrictivePolicies=10;
  const work=vi.fn();
  await expect(mod.withMarketplaceFinanceDevTransaction(1,work))
    .rejects.toThrow("DEV_FINANCE_COMPANY_RLS_GUARD_NOT_READY");
  expect(work).not.toHaveBeenCalled();
 });
 it("fails closed for company roles with unexpected memberships or role attributes",async()=>{
  const mod=await load();
  const work=vi.fn();
  m.memberships=1;
  await expect(mod.withMarketplaceFinanceDevTransaction(1,work))
    .rejects.toThrow("DEV_FINANCE_COMPANY_RLS_GUARD_NOT_READY");
  m.memberships=0;
  m.isolatedLogin=false;
  await expect(mod.withMarketplaceFinanceDevTransaction(3,work))
    .rejects.toThrow("DEV_FINANCE_COMPANY_RLS_GUARD_NOT_READY");
  expect(work).not.toHaveBeenCalled();
 });
 it("reuses a per-company pool without ever swapping one company's identity",async()=>{
  const mod=await load();
  await mod.withMarketplaceFinanceDevTransaction(1,async()=>true);
  await mod.withMarketplaceFinanceDevTransaction(1,async()=>true);
  await mod.withMarketplaceFinanceDevTransaction(3,async()=>true);
  expect(m.poolOptions.map(p=>p.user)).toEqual([ROLE.cst+"."+PROJECT,ROLE.diva+"."+PROJECT]);
  expect(m.transactions.map(t=>t.role)).toEqual([ROLE.cst,ROLE.cst,ROLE.diva]);
 });
});
