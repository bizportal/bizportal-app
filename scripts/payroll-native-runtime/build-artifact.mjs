/** Build-time only: exact AST slices of the SHA-pinned existing accrual engine.
 * No live env, credential, SQL connection, scheduler or test database is loaded.
 * Forbidden global capabilities THROW; they are not successful mock responses.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../..'), api=root+'/artifacts/api-server';
const require=createRequire(api+'/package.json');
const ts=createRequire(root+'/package.json')('typescript');
const {build,version:esbuildVersion}=require('esbuild');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const read=p=>{
 const stat=fs.lstatSync(p);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4*1024*1024)throw Error('NATIVE_SOURCE_FILE_REJECTED');
 return fs.readFileSync(p);
};
const contract=JSON.parse(read(root+'/scripts/payroll-atomic-rehearsal/provenance.json'));
const sourceLib='artifacts/api-server/src/lib';
const accountingPath=sourceLib+'/accounting.ts';
const payrollPath=sourceLib+'/payroll/PayrollJournalService.ts';
const currencyPath=sourceLib+'/currencyTolerance.ts';
function parsed(source,name){return ts.createSourceFile(name,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);}
function selectFunctions(source,names){
 const tree=parsed(source,'accounting.ts');
 return names.map(name=>{
  const found=tree.statements.filter(s=>ts.isFunctionDeclaration(s)&&s.name?.text===name);
  if(found.length!==1)throw Error('NATIVE_FUNCTION_CONTRACT_CHANGED:'+name);
  return found[0].getText(tree);
 }).join('\n\n');
}
function payrollMethod(source){
 const tree=parsed(source,'PayrollJournalService.ts');
 const declarations=tree.statements.filter(ts.isVariableStatement).flatMap(s=>[...s.declarationList.declarations]);
 const found=declarations.filter(s=>ts.isIdentifier(s.name)&&s.name.text==='PayrollJournalService');
 if(found.length!==1||!found[0].initializer||!ts.isObjectLiteralExpression(found[0].initializer))throw Error('NATIVE_SERVICE_CONTRACT_CHANGED');
 const properties=found[0].initializer.properties;
 const method=properties.filter(p=>ts.isMethodDeclaration(p)&&p.name.getText(tree)==='postAccrualJournal');
 const version=properties.filter(p=>ts.isPropertyAssignment(p)&&p.name.getText(tree)==='transactionalAccrualVersion');
 if(method.length!==1||version.length!==1||!version[0].getText(tree).includes('payroll-accrual-atomic-v1'))throw Error('NATIVE_ACCRUAL_CONTRACT_CHANGED');
 return {method:method[0].getText(tree),version:version[0].getText(tree)};
}
const boundaries=`
export function forbidden(){throw Error('PAYROLL_NATIVE_GLOBAL_CAPABILITY_DENIED');}
export const db=new Proxy(Object.freeze({}),{get:forbidden,set:forbidden});
export const postEntry=forbidden,ensureAccountingSettings=forbidden,applyAccountingEnumPatches=forbidden;
export const writeToOutbox=forbidden,scheduleSpotCheck=forbidden,lockAccountingEntry=forbidden,queueIntegrityError=forbidden;
// Deliberately generic runtime diagnostics: never forward SQL, salaries or error objects.
const report=level=>console.error(JSON.stringify({code:'PAYROLL_NATIVE_DIAGNOSTIC',level}));
export const logger=Object.freeze({info:()=>report('info'),warn:()=>report('warn'),error:()=>report('error')});
`;

export async function buildNativePayrollArtifact(legacyRoot){
 if(!legacyRoot||!path.isAbsolute(legacyRoot))throw Error('EXPLICIT_LEGACY_SOURCE_REQUIRED');
 const stage=fs.mkdtempSync(path.join(os.tmpdir(),'payroll-runtime-native-'));
 const sourceHashes={...contract.sourceSha256,...contract.dependencySha256};
 try {
  for(const [rel,expected] of Object.entries(sourceHashes)){
   const bytes=read(path.join(legacyRoot,rel));
   if(sha(bytes)!==expected)throw Error('NATIVE_SOURCE_HASH_MISMATCH:'+rel);
   const target=path.join(stage,rel);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});
  }
  const patchBytes=read(root+'/scripts/payroll-atomic-rehearsal/legacy-transaction-bound.patch');
  const patchFile=path.join(stage,'transaction.patch');fs.writeFileSync(patchFile,patchBytes,{mode:0o600});
  execFileSync('patch',['--batch','--fuzz=0','-p1','-i',patchFile],{cwd:stage,stdio:'pipe'});
  const accounting=read(path.join(stage,accountingPath)).toString('utf8');
  const payroll=read(path.join(stage,payrollPath)).toString('utf8');
  const currency=read(path.join(stage,currencyPath)).toString('utf8');
  const nativeFunctions=selectFunctions(accounting,['requireAccountingCompanyId','postLedgerEvent','round2','_nextEntryNumber','_postEntryCore','postEntryWithClient']);
  const requireJournal=selectFunctions(payroll,['requireJournal']);
  const method=payrollMethod(payroll);
  const schemaFile=root+'/lib/db/src/schema/accounting.ts';
  const schemaImport=JSON.stringify(schemaFile);
  const accountingModule=`import {accountingEntriesTable,accountingEntryLinesTable} from ${schemaImport};
import {eq,sql} from 'drizzle-orm'; import {createHash} from 'node:crypto';
import {validateMultiCurrencyBalance} from 'payroll:currency';
import {db,logger,applyAccountingEnumPatches} from 'payroll:boundaries';
type DbClient=any;\n${nativeFunctions}`;
  const entry=`import {sql} from 'drizzle-orm'; import {db,postEntry} from 'payroll:boundaries';
import {postEntryWithClient} from 'payroll:accounting';
import {AccountingConfigError} from 'payroll:errors';
type DbClient=any;\n${requireJournal}
const native={${method.version},${method.method}};
export const nativeArtifactContract='payroll-native-accrual-artifact-v1';
export const PayrollJournalService=Object.freeze({transactionalAccrualVersion:native.transactionalAccrualVersion,
 async postAccrualJournal(mapping:any,params:any,client:any){
  if(process.env.APP_ENV!=='development'||process.env.PAYROLL_DEV_ATOMIC_POSTING_ENABLED!=='true')throw Error('PAYROLL_NATIVE_DEV_DISABLED');
  if(!client||client===db||['execute','select','insert','update'].some(k=>typeof client[k]!=='function'))throw Error('PAYROLL_NATIVE_EXPLICIT_TRANSACTION_REQUIRED');
  return native.postAccrualJournal(mapping,params,client);
 }});`;
  const modules={'payroll:entry':entry,'payroll:accounting':accountingModule,'payroll:currency':currency,
    'payroll:errors':read(path.join(stage,sourceLib+'/advance/AdvanceErrors.ts')).toString('utf8'),
    'payroll:boundaries':boundaries};
  const result=await build({entryPoints:['payroll:entry'],absWorkingDir:root,bundle:true,platform:'node',target:'node22',format:'esm',
   write:false,metafile:true,logLevel:'silent',minify:false,sourcemap:false,legalComments:'none',
   nodePaths:[api+'/node_modules',root+'/node_modules'],
   plugins:[{name:'explicit-accrual-only-runtime',setup(b){
    b.onResolve({filter:/.*/},args=>{
     if(Object.hasOwn(modules,args.path))return {path:args.path,namespace:'native-accrual'};
     if(args.path==='node:crypto')return {path:args.path,external:true};
     if(args.namespace==='native-accrual'&&args.path.startsWith('.')){
      if(['./accounting/outboxProcessor.js','./jobs/ledgerConsistencyCheck.js'].includes(args.path))return {path:'payroll:boundaries',namespace:'native-accrual'};
      throw Error('NATIVE_DEPENDENCY_NOT_ALLOWED:'+args.path);
     }
     return null;
    });
    b.onLoad({filter:/.*/,namespace:'native-accrual'},args=>({contents:modules[args.path],loader:'ts',resolveDir:api}));
   }}]});
  if(result.outputFiles.length!==1)throw Error('NATIVE_ARTIFACT_MUST_BE_SINGLE_FILE');
  const bytes=result.outputFiles[0].contents;
  const output=Object.values(result.metafile.outputs)[0];
  if(bytes.length>4*1024*1024||JSON.stringify(output.exports.sort())!==JSON.stringify(['PayrollJournalService','nativeArtifactContract']))throw Error('NATIVE_EXPORT_CONTRACT_REJECTED');
  if(output.imports.some(i=>!i.external||i.path!=='node:crypto'))throw Error('NATIVE_UNVERIFIED_RUNTIME_IMPORT');
  const canonicalInputs={};
  for(const name of Object.keys(result.metafile.inputs)){
   if(name.startsWith('native-accrual:'))continue;
   const abs=path.resolve(root,name);
   if(!abs.startsWith(root+path.sep))throw Error('NATIVE_BUILD_INPUT_ESCAPES_WORKTREE');
   canonicalInputs[name]=sha(read(abs));
  }
  const manifest={format:'payroll-native-accrual-artifact-v1',artifact:'native-accrual.mjs',sha256:sha(bytes),bytes:bytes.length,
   sourceHashes,patchSha256:sha(patchBytes),patchedAccountingSha256:sha(accounting),patchedPayrollSha256:sha(payroll),
   exactSelectedFunctionsSha256:sha(nativeFunctions),exactAccrualMethodSha256:sha(method.method),
   generatedAdapterSha256:sha(entry+accountingModule+boundaries),
   lockfileSha256:sha(read(root+'/pnpm-lock.yaml')),builderSha256:sha(read(fileURLToPath(import.meta.url))),esbuildVersion,typescriptVersion:ts.version,
   imports:output.imports,exports:output.exports,canonicalInputs,
   financialBodies:'verbatim-AST-slices-of-pinned-patched-source',globalCapabilities:'throw-only',
   liveDatabaseUsed:false,productionActivated:false};
  return {bytes,manifest};
 } finally {fs.rmSync(stage,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [legacy,output]=process.argv.slice(2);
 if(!output||!path.isAbsolute(output))throw Error('EXPLICIT_OUTPUT_DIRECTORY_REQUIRED');
 const {bytes,manifest}=await buildNativePayrollArtifact(legacy);
 fs.mkdirSync(output,{recursive:true,mode:0o700});
 fs.writeFileSync(path.join(output,'native-accrual.mjs'),bytes,{flag:'wx',mode:0o600});
 fs.writeFileSync(path.join(output,'native-accrual.manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({nativeArtifactBuilt:true,sha256:manifest.sha256,bytes:bytes.length,financialSourceReused:true,liveDatabaseUsed:false}));
}
