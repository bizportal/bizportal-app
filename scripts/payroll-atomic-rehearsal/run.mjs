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
if(!['native','application'].includes(suite))throw Error('UNKNOWN_REHEARSAL_SUITE');
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
const artifactFiles=[entry,output,baseOut,fixedOut];
if(artifactFiles.some(p=>fs.existsSync(p)))throw Error('SCRATCH_ALREADY_EXISTS');
const baselineLib=path.join(stage,'baseline',sourceLib),fixedLib=path.join(stage,'patched',sourceLib);
try {
 for(const [rel,expected] of Object.entries({...manifest.sourceSha256,...manifest.dependencySha256})){
  const bytes=fs.readFileSync(path.join(legacy,rel));
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('SOURCE_HASH_MISMATCH:'+rel);
 }
 for(const rel of [...manifest.sourceFiles,...manifest.unchangedDependencies])for(const variant of ['baseline','patched']){
  const dest=path.join(stage,variant,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(legacy,rel),dest);
 }
 execFileSync('patch',['--batch','--fuzz=0','-p1','-i',here+'/legacy-transaction-bound.patch'],{cwd:path.join(stage,'patched'),stdio:'pipe'});
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
 for(const [lib,out] of [[baselineLib,baseOut],[fixedLib,fixedOut]]){
  await build({stdin:{contents:`export {postEntryWithClient} from ${JSON.stringify(lib+'/accounting.ts')}; export {PayrollJournalService} from ${JSON.stringify(lib+'/payroll/PayrollJournalService.ts')};`,resolveDir:api,loader:'ts'},outfile:out,bundle:true,platform:'node',format:'esm',logLevel:'silent',external:['drizzle-orm','drizzle-orm/*','pg'],nodePaths:[api+'/node_modules',root+'/node_modules'],plugins:[boundaryPlugin()]});
 }
 let helpers=fs.readFileSync(routes+'/payroll-accounting-handoff.test.ts','utf8').split('\ndescribe(')[0].replace(/^import \{ describe, expect, it \} from "vitest";\n/,'');
 const harness=fs.readFileSync(here+(suite==='application'?'/application-postgres-tests.ts':'/native-postgres-tests.ts'),'utf8')
  .replaceAll('__ROOT__',root).replaceAll('__BASE__',baseOut).replaceAll('__FIXED__',fixedOut);
 fs.writeFileSync(entry,helpers+'\n'+harness,{flag:'wx',mode:0o600});
 await build({entryPoints:[entry],outfile:output,bundle:true,platform:'node',format:'esm',logLevel:'silent',nodePaths:[api+'/node_modules',root+'/node_modules'],external:['pg','drizzle-orm','drizzle-orm/*',baseOut,fixedOut],banner:{js:`import {createRequire as createNodeRequire} from 'node:module'; const require=createNodeRequire(import.meta.url);`}});
 await import(pathToFileURL(output).href);
} finally {
 for(const f of artifactFiles)fs.rmSync(f,{force:true});fs.rmSync(stage,{recursive:true,force:true});
}
