/** Rehearsal only. Requires exact local disposable PostgreSQL plus separately
 * supplied, SHA-pinned existing source. Never loads a live app environment. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../..'),api=root+'/artifacts/api-server';
const legacy=process.argv[2];
const suite=process.argv[3]||'native';
if(!['native','application','triggers','permissions','packaged','financial-setup','integrated'].includes(suite))throw Error('UNKNOWN_REHEARSAL_SUITE');
if(!legacy||!path.isAbsolute(legacy))throw Error('EXPLICIT_LEGACY_SOURCE_REQUIRED');
const u=new URL(process.env.PAYROLL_PG_E2E_URL||'invalid:');
if(u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.port!=='65432'||u.pathname!=='/payroll_ci'||u.username!=='postgres.xssrfshdrtdfupgqwfdw')throw Error('REFUSE_NON_DISPOSABLE_POSTGRES');
const manifest=JSON.parse(fs.readFileSync(here+'/provenance.json','utf8'));
const stage=fs.mkdtempSync(path.join(os.tmpdir(),'payroll-native-atomic-'));
const req=createRequire(api+'/package.json'),{build}=req('esbuild');
const routes=api+'/src/routes';
const entry=routes+`/.payroll-atomic-pg-${process.pid}.tmp.ts`;
const output=api+`/.payroll-atomic-pg-${process.pid}.tmp.mjs`;
const baseOut=api+`/.payroll-native-base-${process.pid}.tmp.mjs`;
const fixedOut=api+`/.payroll-native-fixed-${process.pid}.tmp.mjs`;
const sourceLib='artifacts/api-server/src/lib';
const previousOut=api+`/.payroll-native-previous-${process.pid}.tmp.mjs`;
const artifactFiles=[entry,output,baseOut,fixedOut,previousOut];
if(artifactFiles.some(p=>fs.existsSync(p)))throw Error('SCRATCH_ALREADY_EXISTS');
const baselineLib=path.join(stage,'baseline',sourceLib),fixedLib=path.join(stage,'patched',sourceLib);
const previousLib=path.join(stage,'previous',sourceLib);
const variants=suite==='triggers'?['baseline','patched','previous']:['baseline','patched'];
/** ONLY for the integrated disposable suite. Replaces connection plumbing,
 * not any financial or auth logic. Three actual PostgreSQL LOGIN roles connect
 * to the same isolated database and are checked by the real services.
 */
function integratedBoundaryPlugin(){
 const db="const state=()=>{if(!globalThis.__payrollIntegrated)throw Error('INTEGRATED_DB_NOT_READY');return globalThis.__payrollIntegrated;}; export const pool={query:(...args)=>state().admin.query(...args),connect:(...args)=>state().admin.connect(...args)}; export async function getRuntimeDatabaseUrl(){throw Error('NO_LIVE_DATABASE_URL');} export function createDedicatedPayrollPool(){throw Error('NO_SHARED_WRITER_FALLBACK');}";
 const payroll="const state=()=>{if(!globalThis.__payrollIntegrated)throw Error('INTEGRATED_DB_NOT_READY');return globalThis.__payrollIntegrated;}; export const payrollDedicatedEnabled=()=>!!state().calculate; export const getPayrollPool=()=>state().calculate; export async function setPayrollCompanyScope(c,id){await c.query(\"SELECT set_config('app.payroll_company_id',$1,true)\",[String(id)]);} export async function payrollScopedQuery(company,sql,args){const client=await state().calculate.connect();try{await client.query('BEGIN READ ONLY');await setPayrollCompanyScope(client,company);const result=await client.query(sql,args);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}}";
 const approver="const state=()=>{if(!globalThis.__payrollIntegrated)throw Error('INTEGRATED_DB_NOT_READY');return globalThis.__payrollIntegrated;}; export const devApprovalDedicatedEnabled=()=>!!state().approve;export const getDevApprovalPool=()=>state().approve;export async function setDevApprovalCompanyScope(c,id){await c.query(\"SELECT set_config('app.payroll_company_id',$1,true)\",[String(id)]);}";
 const prod="export const payrollProdDedicatedRequired=()=>false;export const payrollReadOnlyReady=()=>false;export const payrollProdSharedReadOnlyEnabled=()=>false;export const payrollDedicatedEnabled=()=>false;export const getPayrollPool=()=>{throw Error('PROD_POOL_FORBIDDEN');};export async function payrollScopedQuery(){throw Error('PROD_POOL_FORBIDDEN');}export async function setPayrollCompanyScope(){throw Error('PROD_POOL_FORBIDDEN');}";
 const map={db,payroll,approver,prod};
 return {name:'payroll-integrated-disposable-only',setup(build){
  build.onResolve({filter:/^@workspace\/db$/},()=>({path:'db',namespace:'payroll-integrated'}));
  build.onResolve({filter:/^\.\/payroll-db$/},()=>({path:'payroll',namespace:'payroll-integrated'}));
  build.onResolve({filter:/^\.\/payroll-dev-approval-db$/},()=>({path:'approver',namespace:'payroll-integrated'}));
  build.onResolve({filter:/^\.\/payroll-prod-db$/},()=>({path:'prod',namespace:'payroll-integrated'}));
  build.onLoad({filter:/.*/,namespace:'payroll-integrated'},args=>({contents:map[args.path],loader:'js'}));
 }};
}
try {
 for(const [rel,expected] of Object.entries({...manifest.sourceSha256,...manifest.dependencySha256})){
  const bytes=fs.readFileSync(path.join(legacy,rel));
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('SOURCE_HASH_MISMATCH:'+rel);
 }
 for(const rel of [...manifest.sourceFiles,...manifest.unchangedDependencies])for(const variant of variants){
  const dest=path.join(stage,variant,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(legacy,rel),dest);
 }
 execFileSync('patch',['--batch','--fuzz=0','-p1','-i',here+'/legacy-transaction-bound.patch'],{cwd:path.join(stage,'patched'),stdio:'pipe'});
 if(suite==='triggers'){
  const contract=JSON.parse(fs.readFileSync(here+'/dev-selected-guards-provenance.json','utf8'));
  const priorPatch=execFileSync('git',['show',contract.previousPatchCommit+':scripts/payroll-atomic-rehearsal/legacy-transaction-bound.patch'],{cwd:root});
  if(crypto.createHash('sha256').update(priorPatch).digest('hex')!==contract.previousPatchSha256)throw Error('PREVIOUS_PATCH_HASH_MISMATCH');
  const file=path.join(stage,'previous.patch');fs.writeFileSync(file,priorPatch);
  execFileSync('patch',['--batch','--fuzz=0','-p1','-i',file],{cwd:path.join(stage,'previous'),stdio:'pipe'});
 }
 const schema=root+'/lib/db/src/schema/accounting.ts';
 const stubs={
  '@workspace/db':`export * from ${JSON.stringify(schema)}; export const db=globalThis.__nativePayrollDb;`,
  'seed':`export function ensureAccountingSettings(){throw Error('UNEXPECTED_GLOBAL_SEED');} export function applyAccountingEnumPatches(){throw Error('UNEXPECTED_GLOBAL_ENUM_PATCH');}`,
  'logger':`export const logger={info(){},warn(){},error(){}};`,
  // Only the notification plumbing is replaced, not financial writes. This
  // preserves the original global outbox SQL against real disposable PG.
  'outbox':`import {sql} from 'drizzle-orm'; export async function writeToOutbox(p){await globalThis.__nativePayrollDb.execute(sql\`INSERT INTO financial_outbox_events(event_type,payload,entry_id,company_id) VALUES (\${p.eventType},\${JSON.stringify(p)},\${p.entryId},\${p.companyId})\`);}`,
  'background':`export function scheduleSpotCheck(){}; export function lockAccountingEntry(){}; export function queueIntegrityError(){throw Error('UNEXPECTED_GLOBAL_ERROR_QUEUE');}`,
 };
 function boundaryPlugin(){return {name:'disposable-fixture-boundaries',setup(b){
  b.onResolve({filter:/.*/},args=>{
   if(args.path==='@workspace/db')return {path:'@workspace/db',namespace:'fixture'};
   if(args.path.endsWith('/accountingSeed.js'))return {path:'seed',namespace:'fixture'};
   if(args.path.endsWith('/logger.js'))return {path:'logger',namespace:'fixture'};
   if(args.path.endsWith('/accounting/outboxProcessor.js'))return {path:'outbox',namespace:'fixture'};
   if(/\/(jobs\/ledgerConsistencyCheck|ledgerImmutability|errorContainment)\.js$/.test(args.path))return {path:'background',namespace:'fixture'};
   if(args.path.startsWith('.')&&args.importer.startsWith(stage)){
    const resolved=path.resolve(path.dirname(args.importer),args.path);
    if(!fs.existsSync(resolved)&&!fs.existsSync(resolved.replace(/\.js$/,'.ts')))return {path:resolved,namespace:'unavailable'};
   }
   return null;
  });
  b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:stubs[a.path],loader:'js',resolveDir:api}));
  b.onLoad({filter:/.*/,namespace:'unavailable'},a=>({contents:`throw Error('UNEXPECTED_UNMIGRATED_DEPENDENCY'); export const unavailable=true;`,loader:'js'}));
 }};}
 const builds=suite==='triggers'?[[baselineLib,baseOut],[fixedLib,fixedOut],[previousLib,previousOut]]:['packaged','integrated'].includes(suite)?[[baselineLib,baseOut]]:[[baselineLib,baseOut],[fixedLib,fixedOut]];
 for(const [lib,out] of builds){
  await build({stdin:{contents:`export {postEntryWithClient} from ${JSON.stringify(lib+'/accounting.ts')}; export {PayrollJournalService} from ${JSON.stringify(lib+'/payroll/PayrollJournalService.ts')};`,resolveDir:api,loader:'ts'},outfile:out,bundle:true,platform:'node',format:'esm',logLevel:'silent',external:['drizzle-orm','drizzle-orm/*','pg'],nodePaths:[api+'/node_modules',root+'/node_modules'],plugins:[boundaryPlugin()]});
 }
 let artifactHash=null;
 if(['packaged','integrated'].includes(suite)){
  const {buildNativePayrollArtifact}=await import('../payroll-native-runtime/build-artifact.mjs');
  const artifact=await buildNativePayrollArtifact(legacy);
  fs.writeFileSync(fixedOut,artifact.bytes,{flag:'wx',mode:0o600});
  artifactHash=artifact.manifest.sha256;
  console.log('CLOSED_NATIVE_ARTIFACT_BUILT',artifactHash,'BYTES',artifact.bytes.length,'FINANCIAL_MOCKS',false);
 }
 let helpers=fs.readFileSync(routes+'/payroll-accounting-handoff.test.ts','utf8').split('\ndescribe(')[0].replace(/^import \{ describe, expect, it \} from "vitest";\n/,'');
 let harness=fs.readFileSync(here+(suite==='native'?'/native-postgres-tests.ts':'/application-postgres-tests.ts'),'utf8');
 if(suite==='triggers'){
  const marker=' await reset();\n const plan=prepareReviewedPayrollAccrual(fixture());';
  const at=harness.indexOf(marker);if(at<0)throw Error('FIXTURE_SETUP_CONTRACT_CHANGED');
  harness=harness.slice(0,at)+fs.readFileSync(here+'/trigger-compatibility-tests.ts','utf8');
 }
 if(suite==='financial-setup'){
  const marker=' await reset();\n const plan=prepareReviewedPayrollAccrual(fixture());';
  const at=harness.indexOf(marker);if(at<0)throw Error('FIXTURE_SETUP_CONTRACT_CHANGED');
  harness=harness.slice(0,at)+fs.readFileSync(here+'/../payroll-financial-period/postgres-tests.ts','utf8');
 }
 if(suite==='permissions'||suite==='packaged'){
  const marker=' await reset();\n const plan=prepareReviewedPayrollAccrual(fixture());';
  const at=harness.indexOf(marker);if(at<0)throw Error('FIXTURE_SETUP_CONTRACT_CHANGED');
  harness=harness.slice(0,at)+fs.readFileSync(here+'/permission-contract-tests.ts','utf8')+'\n'+harness.slice(at);
  // The intentionally corrupting writer can no longer UPDATE account_id.
  // Require that exact PostgreSQL ACL denial instead of a later read-back error.
  const oldTamper="return posted;}}),/JOURNAL_LINES_CHANGED/);await unchanged();ok('APPLICATION rejects wrong journal lines before settling kasbon');";
  const newTamper="return posted;}}),(e)=>{let x:any=e;for(let n=0;n<5&&x;n++,x=x.cause)if(x.code==='42501')return true;return false;});await unchanged();ok('APPLICATION limited writer is denied account-line mutation before settlement, with full rollback');";
  if(!harness.includes(oldTamper))throw Error('TAMPER_TEST_CONTRACT_CHANGED');
  harness=harness.replace(oldTamper,newTamper);

 }
 if(['packaged','integrated'].includes(suite)){
  const originalImport="const patched=await import('__FIXED__');";
  if(!harness.includes(originalImport)||!artifactHash)throw Error('PACKAGED_FIXTURE_CONTRACT_CHANGED');
  const verifiedImport=`
const nativeLoader=await import('./payroll-accounting-native-runtime');
const previousPackageEnv={APP_ENV:process.env.APP_ENV,PAYROLL_DEV_ATOMIC_ROUTE_MOUNT_ENABLED:process.env.PAYROLL_DEV_ATOMIC_ROUTE_MOUNT_ENABLED,PAYROLL_DEV_ATOMIC_POSTING_ENABLED:process.env.PAYROLL_DEV_ATOMIC_POSTING_ENABLED};
let verifiedPackagedWriter;
try {
 process.env.APP_ENV='development';process.env.PAYROLL_DEV_ATOMIC_ROUTE_MOUNT_ENABLED='true';process.env.PAYROLL_DEV_ATOMIC_POSTING_ENABLED='true';
 verifiedPackagedWriter=await nativeLoader.loadDevPayrollNativeArtifact('__FIXED__',${JSON.stringify(artifactHash)});
 assert.deepEqual(Object.keys(verifiedPackagedWriter).sort(),['postAccrualJournal','transactionalAccrualVersion']);
 assert.equal(Object.isFrozen(verifiedPackagedWriter),true);
} finally { for(const [k,v] of Object.entries(previousPackageEnv)){if(v===undefined)delete process.env[k];else process.env[k]=v;} }
const patched={PayrollJournalService:verifiedPackagedWriter};
console.log('VERIFIED_PACKAGE_LOADER_USED',true,'HTTP_SESSION_TESTED',false);
`;
  harness=harness.replace(originalImport,verifiedImport);
 }
 if(suite==='integrated'){
  const marker=' await reset();\n const plan=prepareReviewedPayrollAccrual(fixture());';
  const at=harness.indexOf(marker);if(at<0)throw Error('INTEGRATED_FIXTURE_SETUP_CONTRACT_CHANGED');
  harness=harness.slice(0,at)+fs.readFileSync(root+'/scripts/payroll-calculate/integrated-accounting-postgres-tests.ts','utf8');
 }
 if(suite==='packaged'){
  const marker=" console.log('APPLICATION_REAL_POSTGRES_CHECKS_PASS'";
  const at=harness.indexOf(marker);if(at<0)throw Error('OTHER_DEDUCTION_CASE_LOCATION_CHANGED');
  harness=harness.slice(0,at)+fs.readFileSync(root+'/scripts/payroll-other-deductions/postgres-tests.ts','utf8')+'\n'+fs.readFileSync(root+'/scripts/payroll-kasbon-cross-period/postgres-tests.ts','utf8')+'\n'+fs.readFileSync(root+'/scripts/payroll-legacy-installments/postgres-tests.ts','utf8')+'\n'+harness.slice(at);
 }
 harness=harness.replaceAll('__ROOT__',root).replaceAll('__BASE__',baseOut).replaceAll('__FIXED__',fixedOut).replaceAll('__PREVIOUS__',previousOut);
 fs.writeFileSync(entry,helpers+'\n'+harness,{flag:'wx',mode:0o600});
 await build({entryPoints:[entry],outfile:output,bundle:true,platform:'node',format:'esm',logLevel:'silent',nodePaths:[api+'/node_modules',root+'/node_modules'],external:['pg','express','drizzle-orm','drizzle-orm/*',baseOut,fixedOut,previousOut],plugins:suite==='integrated'?[integratedBoundaryPlugin()]:[],banner:{js:`import {createRequire as createNodeRequire} from 'node:module'; const require=createNodeRequire(import.meta.url);`}});
 await import(pathToFileURL(output).href);
} finally {
 for(const f of artifactFiles)fs.rmSync(f,{force:true});fs.rmSync(stage,{recursive:true,force:true});
}
