import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import express from 'express';
import {createServer,type Server} from 'node:http';
import {once} from 'node:events';
const state=vi.hoisted(()=>({signed:true,mode:true,dedicated:true,missingActor:false,error:'',calls:[] as unknown[],poolCalls:0,
 actor:{id:'synthetic-period-admin',email:'admin@example.test',role:'super_admin',companyId:null as number|null}}));
vi.mock('./dev-auth',()=>({isSignedOtpDevEnabled:()=>state.mode,getProductionSession:()=>state.signed?{}:null,
 getProductionUser:async()=>state.missingActor?null:state.actor}));
vi.mock('./payroll-db',()=>({payrollDedicatedEnabled:()=>state.dedicated,getPayrollPool:()=>{state.poolCalls++;return{};}}));
vi.mock('./payroll-financial-period',()=>({registerPayrollFinancialPeriod:async(_p:unknown,request:unknown)=>{
 state.calls.push(request);if(state.error)throw Error(state.error);return{periodId:11,auditEventId:'22',created:true,replayed:false,
 companyId:1,runId:32,payrollApproved:false,fundingApproved:false,accountingPosted:false,salaryPaid:false};}}));
let server:Server|undefined,url='';
const origin='https://payroll-dev.example.test';
const payload={requestId:'d769a067-dd14-4d9e-ae3c-54e7aedf7b68',note:'Synthetic setup without approving any salary'};
async function start(){
 const {createPayrollFinancialPeriodRouter}=await import('./payroll-financial-period-http');
 const app=express();app.use(express.json({limit:'8kb'}));app.use('/api',createPayrollFinancialPeriodRouter());
 server=createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');const a=server.address();
 if(!a||typeof a==='string')throw Error('NO_TEST_LISTENER');url=`http://127.0.0.1:${a.port}/api/payroll/runs/32/register-financial-period?companyId=1`;
}
const post=(body:unknown=payload,headers:Record<string,string>={},endpoint=url)=>fetch(endpoint,{method:'POST',headers:{origin,'content-type':'application/json',...headers},body:JSON.stringify(body)});
beforeEach(()=>{vi.resetModules();vi.stubEnv('APP_ENV','development');vi.stubEnv('PAYROLL_DEV_FINANCIAL_SETUP_ENABLED','true');
 vi.stubEnv('PAYROLL_DEV_FINANCIAL_SETUP_ALLOWED_ORIGIN',origin);state.signed=true;state.mode=true;state.dedicated=true;state.missingActor=false;state.error='';state.calls=[];state.poolCalls=0;
 state.actor={id:'synthetic-period-admin',email:'admin@example.test',role:'super_admin',companyId:null};});
afterEach(async()=>{if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;}vi.unstubAllEnvs();});
describe('DEV-only audited financial-period HTTP adapter',()=>{
 it.each(['production',''])('does not mount in %s',async env=>{vi.stubEnv('APP_ENV',env);await start();expect((await post()).status).toBe(404);expect(state.poolCalls).toBe(0);});
 it('is default off and rechecks the flag after route registration',async()=>{await start();vi.stubEnv('PAYROLL_DEV_FINANCIAL_SETUP_ENABLED','');expect((await post()).status).toBe(404);expect(state.calls).toHaveLength(0);});
 it('requires signed session mode and does not accept a legacy DEV cookie',async()=>{
  await start();state.mode=false;expect((await post()).status).toBe(503);state.mode=true;state.signed=false;
  expect((await post(payload,{cookie:'bizportal_dev_session=synthetic'})).status).toBe(401);expect(state.poolCalls).toBe(0);
 });
 it.each(['owner','finance','admin','accounting'])('rejects role %s',async role=>{await start();state.actor.role=role;expect((await post()).status).toBe(403);expect(state.poolCalls).toBe(0);});
 it('rejects missing/inactive server-side actor',async()=>{await start();state.missingActor=true;expect((await post()).status).toBe(403);});
 it.each(['https://attacker.example.test','null',''])('rejects foreign origin %s',async value=>{await start();expect((await post(payload,{origin:value})).status).toBe(403);expect(state.calls).toHaveLength(0);});
 it('rejects cross-site requests and missing server origin configuration',async()=>{await start();expect((await post(payload,{'sec-fetch-site':'cross-site'})).status).toBe(403);
  vi.stubEnv('PAYROLL_DEV_FINANCIAL_SETUP_ALLOWED_ORIGIN','');expect((await post()).status).toBe(503);expect(state.poolCalls).toBe(0);});
 it.each(['http://payroll-dev.example.test','https://payroll-dev.example.test/path','https://u:p@payroll-dev.example.test'])('rejects untrusted origin configuration %s',async value=>{vi.stubEnv('PAYROLL_DEV_FINANCIAL_SETUP_ALLOWED_ORIGIN',value);await start();expect((await post()).status).toBe(503);expect(state.poolCalls).toBe(0);});
 it.each([{...payload,actor:{id:'different'}},{...payload,year:2026},{...payload,isClosed:false},{...payload,bankAccountId:1},null,[]])('rejects body authority or period overrides %j',async body=>{await start();expect((await post(body)).status).toBe(400);expect(state.poolCalls).toBe(0);});
 it.each(['all','0','2147483648','1&companyId=3','1&actor=admin'])('rejects ambiguous scope %s',async scope=>{await start();expect((await post(payload,{},url.replace('companyId=1','companyId='+scope))).status).toBe(400);expect(state.calls).toHaveLength(0);});
 it('never uses the shared pool when a dedicated connection is missing',async()=>{await start();state.dedicated=false;expect((await post()).status).toBe(503);expect(state.poolCalls).toBe(0);});
 it('has no GET side effect and does not accept form posts',async()=>{await start();expect((await fetch(url)).status).toBe(404);expect((await post(payload,{'content-type':'text/plain'})).status).toBe(415);expect(state.calls).toHaveLength(0);});
 it('derives actor and period selection only from trusted context',async()=>{await start();const r=await post();expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('no-store');
  expect(await r.json()).toMatchObject({ok:true,periodId:11,payrollApproved:false,fundingApproved:false,accountingPosted:false,salaryPaid:false});
  expect(state.calls).toEqual([{...payload,companyId:1,runId:32,actor:{id:'synthetic-period-admin',email:'admin@example.test',role:'super_admin'}}]);});
 it.each([['PAYROLL_PERIOD_RUN_NOT_FOUND',404],['PAYROLL_PERIOD_REQUEST_INVALID',400],['PAYROLL_PERIOD_VERIFIED_ACTOR_REQUIRED',403],
  ['PAYROLL_PERIOD_CLOSED_OR_OVERRIDE_PERIOD',409],['PAYROLL_PERIOD_ACCOUNTING_PERIOD_LOCKED',409],['PAYROLL_PERIOD_AUDIT_MISSING_OR_CHANGED',409],
  ['postgresql://secret:password@private.invalid internal SQL',503]] as const)('redacts %s',async(error,status)=>{await start();state.error=error;const r=await post();expect(r.status).toBe(status);const text=await r.text();expect(text).not.toContain(error);expect(text).not.toContain('password');});
});
