import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const state=vi.hoisted(()=>({signed:true,url:"",events:[] as string[],failArtifact:false,failSecret:false,
 failBind:false,wait:null as Promise<void>|null,reads:0,pools:0,ends:0,binds:0,artifactLoads:0}));
vi.mock("@workspace/db",()=>({
 readSecret:async (_name:string)=>{state.events.push("secret");state.reads++;if(state.wait)await state.wait;
  if(state.failSecret)throw Error("synthetic-secret-provider-error");return state.url;},
 createDedicatedPayrollPool:(_url:string)=>{state.events.push("pool");state.pools++;
  return {connect:vi.fn(),end:async()=>{state.events.push("close");state.ends++;}};},
}));
vi.mock("./dev-auth",()=>({isSignedOtpDevEnabled:()=>state.signed}));
vi.mock("./payroll-accounting-native-runtime",()=>({loadDevPayrollNativeArtifact:async()=>{
 state.events.push("artifact");state.artifactLoads++;if(state.failArtifact)throw Error("synthetic-untrusted-artifact");
 return {transactionalAccrualVersion:"payroll-accrual-atomic-v1",postAccrualJournal:vi.fn()};
}}));
vi.mock("./payroll-accounting-http",()=>({bindDevPayrollAtomicHttpRuntime:async()=>{
 state.events.push("bind");state.binds++;if(state.failBind)throw Error("synthetic-direct-role-preflight-failure");
}}));
const direct="postgresql://bizportal_payroll_settlement_dev:synthetic-test-only@db.xssrfshdrtdfupgqwfdw.supabase.co:5432/postgres?sslmode=verify-full";
const run=async()=> (await import("./payroll-accounting-bootstrap")).prepareDevPayrollAtomicRuntime();
beforeEach(()=>{
 vi.resetModules();state.signed=true;state.url=direct;state.events.length=0;state.failArtifact=false;state.failSecret=false;state.failBind=false;
 state.wait=null;state.reads=0;state.pools=0;state.ends=0;state.binds=0;state.artifactLoads=0;
 vi.stubEnv("PAYROLL_DEV_LEGACY_INSTALLMENT_LINK_ENABLED","false");
 vi.stubEnv("APP_ENV","development");vi.stubEnv("PAYROLL_DEV_ATOMIC_ROUTE_MOUNT_ENABLED","true");vi.stubEnv("PAYROLL_DEV_ATOMIC_POSTING_ENABLED","true");
 vi.stubEnv("PAYROLL_SETTLEMENT_GCP_SECRET_NAME_DEV","bizportal-payroll-settlement-dev");
 vi.stubEnv("PAYROLL_SETTLEMENT_DATABASE_URL_DEV","");vi.stubEnv("PAYROLL_DEV_ATOMIC_NATIVE_ARTIFACT_PATH","/release/native-accrual.mjs");
 vi.stubEnv("PAYROLL_DEV_ATOMIC_NATIVE_SHA256","a".repeat(64));vi.stubEnv("PAYROLL_DEV_ATOMIC_ALLOWED_ORIGIN","https://dev.example.test");
});
afterEach(()=>vi.unstubAllEnvs());

describe("DEV native Payroll startup assembly (external boundaries simulated)",()=>{
 it("uses the existing secret/pool/binder only after artifact verification",async()=>{
  expect(await run()).toBe(true);expect(state.events).toEqual(["artifact","secret","pool","bind"]);
  expect(state.ends).toBe(0);expect(await run()).toBe(true);expect(state.binds).toBe(1);
 });
 it.each(["production",""])("does no work outside DEV (%s)",async env=>{
  vi.stubEnv("APP_ENV",env);expect(await run()).toBe(false);expect(state.events).toEqual([]);
 });
 it.each(["PAYROLL_DEV_ATOMIC_ROUTE_MOUNT_ENABLED","PAYROLL_DEV_ATOMIC_POSTING_ENABLED"])("does nothing when %s is disabled",async key=>{
  vi.stubEnv(key,"false");expect(await run()).toBe(false);expect(state.events).toEqual([]);
 });
 it("does not read credentials before signed-OTP mode is ready",async()=>{
  state.signed=false;await expect(run()).rejects.toThrow("BOOTSTRAP_UNAVAILABLE");expect(state.events).toEqual([]);
 });
 it.each([
  ["PAYROLL_SETTLEMENT_GCP_SECRET_NAME_DEV","cst-super-app-production"],
  ["PAYROLL_SETTLEMENT_GCP_SECRET_NAME_DEV",""],
  ["PAYROLL_SETTLEMENT_DATABASE_URL_DEV","postgresql://synthetic-direct-unsupported"],
  ["PAYROLL_DEV_ATOMIC_NATIVE_ARTIFACT_PATH","relative.mjs"],
  ["PAYROLL_DEV_ATOMIC_NATIVE_SHA256","invalid"],
  ["PAYROLL_DEV_ATOMIC_ALLOWED_ORIGIN","http://localhost:1234"],
  ["PAYROLL_DEV_ATOMIC_ALLOWED_ORIGIN","https://dev.example.test/path"],
  ["PAYROLL_DEV_ATOMIC_ALLOWED_ORIGIN","https://user:pass@dev.example.test"],
 ])("rejects invalid trusted configuration %s",async(key,value)=>{
  vi.stubEnv(key,value);await expect(run()).rejects.toThrow("BOOTSTRAP_UNAVAILABLE");expect(state.events).toEqual([]);
 });
 it.each([
  direct.replace("xssrfshdrtdfupgqwfdw","nzdweipzckfszczzqtuw"),
  direct.replace("bizportal_payroll_settlement_dev","bizportal_payroll_dev"),
  direct.replace("bizportal_payroll_settlement_dev","postgres"),
  direct.replace(".supabase.co:",".supabase.co.attacker.test:"),
  direct.replace("verify-full","require"),direct.replace("?sslmode=verify-full",""),
  direct+"&sslmode=disable",direct+"&host=attacker.test",direct+"&user=postgres",
  direct.replace("/postgres?","/other?"),direct.replace(":5432/",":65432/"),
  direct.replace(":synthetic-test-only@","@"),direct+"#unwanted-fragment",
  "not-a-url",
 ])("rejects invalid managed database target %#",async url=>{
  state.url=url;await expect(run()).rejects.toThrow("BOOTSTRAP_UNAVAILABLE");expect(state.pools).toBe(0);expect(state.binds).toBe(0);
 });
 it("accepts the exact project-suffixed Supavisor login without accepting unscoped users",async()=>{
  state.url="postgresql://bizportal_payroll_settlement_dev.xssrfshdrtdfupgqwfdw:synthetic-test-only@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres?sslmode=verify-full";
  expect(await run()).toBe(true);expect(state.binds).toBe(1);
 });
 it("does not read GCP or construct a pool when artifact validation fails",async()=>{
  state.failArtifact=true;await expect(run()).rejects.toThrow(/^PAYROLL_NATIVE_BOOTSTRAP_UNAVAILABLE$/);
  expect(state.reads).toBe(0);expect(state.pools).toBe(0);
 });
 it("fails closed when the existing managed reader fails",async()=>{
  state.failSecret=true;await expect(run()).rejects.toThrow(/^PAYROLL_NATIVE_BOOTSTRAP_UNAVAILABLE$/);
  expect(state.pools).toBe(0);expect(state.binds).toBe(0);
 });
 it("closes the new pool on failed direct-connection preflight and permits a clean retry",async()=>{
  state.failBind=true;await expect(run()).rejects.toThrow(/^PAYROLL_NATIVE_BOOTSTRAP_UNAVAILABLE$/);
  expect(state.ends).toBe(1);state.failBind=false;expect(await run()).toBe(true);
  expect(state.pools).toBe(2);expect(state.binds).toBe(2);expect(state.ends).toBe(1);
 });
 it("coalesces identical startup calls and rejects configuration replacement",async()=>{
  let resolve!:()=>void;state.wait=new Promise<void>(done=>{resolve=done;});
  const first=run(),second=run();await vi.waitFor(()=>expect(state.reads).toBe(1));
  vi.stubEnv("PAYROLL_DEV_ATOMIC_NATIVE_SHA256","b".repeat(64));
  await expect(run()).rejects.toThrow("BOOTSTRAP_UNAVAILABLE");
  vi.stubEnv("PAYROLL_DEV_ATOMIC_NATIVE_SHA256","a".repeat(64));resolve();
  expect(await Promise.all([first,second])).toEqual([true,true]);expect(state.pools).toBe(1);expect(state.binds).toBe(1);
 });
 it("does not open a pool if activation is removed while the secret is being read",async()=>{
  let resolve!:()=>void;state.wait=new Promise<void>(done=>{resolve=done;});
  const preparing=run();const rejected=expect(preparing).rejects.toThrow("BOOTSTRAP_UNAVAILABLE");
  await vi.waitFor(()=>expect(state.reads).toBe(1));vi.stubEnv("PAYROLL_DEV_ATOMIC_POSTING_ENABLED","false");resolve();await rejected;
  expect(state.pools).toBe(0);expect(state.binds).toBe(0);
 });
 it("requires restart instead of changing an installed fingerprint",async()=>{
  expect(await run()).toBe(true);vi.stubEnv("PAYROLL_DEV_ATOMIC_NATIVE_SHA256","b".repeat(64));
  await expect(run()).rejects.toThrow("BOOTSTRAP_UNAVAILABLE");expect(state.binds).toBe(1);
 });
 it("requires restart before switching the optional installment permission profile",async()=>{
  expect(await run()).toBe(true);vi.stubEnv("PAYROLL_DEV_LEGACY_INSTALLMENT_LINK_ENABLED","true");
  await expect(run()).rejects.toThrow("BOOTSTRAP_UNAVAILABLE");expect(state.binds).toBe(1);
 });

});
