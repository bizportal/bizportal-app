/** Build/integrity checks only; explicitly supplied source, no database/network. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildNativePayrollArtifact} from './build-artifact.mjs';
const legacy=process.argv[2];
let passed=0;
const ok=name=>{passed++;console.log('PASS NATIVE_PACKAGE',name);};
const first=await buildNativePayrollArtifact(legacy);
const second=await buildNativePayrollArtifact(legacy);
assert.equal(first.manifest.sha256,second.manifest.sha256);
assert.deepEqual(first.bytes,second.bytes);ok('same pinned inputs produce identical self-contained bytes');
assert.ok(first.manifest.imports.every(i=>i.external&&i.path==='node:crypto'));
assert.deepEqual(first.manifest.exports,['PayrollJournalService','nativeArtifactContract']);
assert.equal(first.manifest.financialBodies,'verbatim-AST-slices-of-pinned-patched-source');
assert.equal(first.manifest.globalCapabilities,'throw-only');ok('only approved builtin import and accrual exports');
assert.equal(Buffer.from(first.bytes).includes(Buffer.from('__nativePayrollDb')),false);
assert.equal(Buffer.from(first.bytes).includes(Buffer.from('POSTGRES_PASSWORD')),false);
ok('no fixture global database or synthetic credential is embedded');
const native=await import('data:text/javascript;base64,'+Buffer.from(first.bytes).toString('base64'));
assert.equal(native.nativeArtifactContract,'payroll-native-accrual-artifact-v1');
assert.equal(Object.isFrozen(native.PayrollJournalService),true);
assert.deepEqual(Object.keys(native.PayrollJournalService).sort(),['postAccrualJournal','transactionalAccrualVersion']);
ok('actual generated artifact imports without initializing any pool');
const original={APP_ENV:process.env.APP_ENV,PAYROLL_DEV_ATOMIC_POSTING_ENABLED:process.env.PAYROLL_DEV_ATOMIC_POSTING_ENABLED};
try{
 process.env.APP_ENV='production';process.env.PAYROLL_DEV_ATOMIC_POSTING_ENABLED='true';
 await assert.rejects(native.PayrollJournalService.postAccrualJournal({},{}),/DEV_DISABLED/);ok('actual artifact is unavailable in production');
 process.env.APP_ENV='development';process.env.PAYROLL_DEV_ATOMIC_POSTING_ENABLED='false';
 await assert.rejects(native.PayrollJournalService.postAccrualJournal({},{}),/DEV_DISABLED/);ok('posting flag off prevents native invocation');
 process.env.PAYROLL_DEV_ATOMIC_POSTING_ENABLED='true';
 await assert.rejects(native.PayrollJournalService.postAccrualJournal({},{}),/EXPLICIT_TRANSACTION_REQUIRED/);
 await assert.rejects(native.PayrollJournalService.postAccrualJournal({},{},{}),/EXPLICIT_TRANSACTION_REQUIRED/);ok('missing caller transaction cannot select global fallback');
 let queries=0;
 const fake={execute(){queries++;throw Error('SYNTHETIC_TRANSACTION_FAILURE');},select(){throw Error('UNEXPECTED');},insert(){throw Error('UNEXPECTED');},update(){throw Error('UNEXPECTED');}};
 await assert.rejects(native.PayrollJournalService.postAccrualJournal({},{companyId:1},fake),/SYNTHETIC_TRANSACTION_FAILURE/);
 assert.equal(queries,1);ok('transaction failure propagates without another pool or retry');
 queries=0;
 await assert.rejects(native.PayrollJournalService.postAccrualJournal({},{companyId:1,totalOtherDeductions:1},fake),/OTHER_DEDUCTION_MAPPING_REQUIRED/);
 assert.equal(queries,0);ok('nonzero other deduction without explicit mapping rejected before SQL');
 await assert.rejects(native.PayrollJournalService.postAccrualJournal({otherDeductionPayableAccountId:15},{companyId:1,totalOtherDeductions:-1},fake),/OTHER_DEDUCTION_MAPPING_REQUIRED/);
 assert.equal(queries,0);ok('negative other deduction rejected before SQL');

}finally{for(const [key,value] of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
await assert.rejects(buildNativePayrollArtifact('relative-source'),/EXPLICIT_LEGACY_SOURCE_REQUIRED/);ok('unqualified source roots rejected');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'payroll-native-build-negative-'));
try{
 for(const rel of Object.keys(first.manifest.sourceHashes)){
  const file=path.join(scratch,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(path.join(legacy,rel),file);
 }
 const target=path.join(scratch,'artifacts/api-server/src/lib/accounting.ts');
 fs.appendFileSync(target,'\n// altered synthetic source\n');
 await assert.rejects(buildNativePayrollArtifact(scratch),/NATIVE_SOURCE_HASH_MISMATCH/);ok('changed legacy source rejected before artifact creation');
 fs.unlinkSync(target);fs.symlinkSync(path.join(legacy,'artifacts/api-server/src/lib/accounting.ts'),target);
 await assert.rejects(buildNativePayrollArtifact(scratch),/NATIVE_SOURCE_FILE_REJECTED/);ok('source-file symlink rejected before copying');
}finally{fs.rmSync(scratch,{recursive:true,force:true});}
console.log('NATIVE_PACKAGE_BUILD_CHECKS_PASS',passed,'ARTIFACT_SHA256',first.manifest.sha256,'BYTES',first.bytes.length,'LIVE_DATABASE_USED',false);
