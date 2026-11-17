import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {FILES,PUBLIC_SOURCE_BASE,PUBLIC_SOURCE_COMMIT,MAX_FILE_BYTES,checkedHashes,checkedBytes,fetchPinnedPayrollSource} from './fetch-pinned-source.mjs';
const digest=b=>createHash('sha256').update(b).digest('hex');
const manifest=()=>({sourceSha256:Object.fromEntries(FILES.slice(0,2).map(f=>[f,'a'.repeat(64)])),
 dependencySha256:Object.fromEntries(FILES.slice(2).map(f=>[f,'b'.repeat(64)]))});
const response=(b,options={})=>new Response(b,{status:200,...options});
test('fixed public commit and exactly five existing source paths',()=>{
 assert.match(PUBLIC_SOURCE_COMMIT,/^[0-9a-f]{40}$/);assert.equal(FILES.length,5);
 assert.match(PUBLIC_SOURCE_BASE,new RegExp('/'+PUBLIC_SOURCE_COMMIT+'/'));
 assert.equal(checkedHashes(manifest()).size,5);
});
for(const name of ['missing','extra','duplicate','path-escape','bad-hash'])test('manifest rejects '+name,()=>{
 const m=manifest();
 if(name==='missing')delete m.sourceSha256[FILES[0]];
 if(name==='extra')m.sourceSha256['extra.ts']='a'.repeat(64);
 if(name==='duplicate')m.dependencySha256[FILES[0]]='a'.repeat(64);
 if(name==='path-escape'){delete m.sourceSha256[FILES[0]];m.sourceSha256['../escape.ts']='a'.repeat(64);}
 if(name==='bad-hash')m.sourceSha256[FILES[0]]='not-a-hash';
 assert.throws(()=>checkedHashes(m),/MANIFEST_INVALID/);
});
test('content hash is verified, not inferred from HTTP 200',async()=>{
 const b=Buffer.from('synthetic source\n');assert.deepEqual(await checkedBytes(response(b),digest(b)),b);
 await assert.rejects(checkedBytes(response(b),'c'.repeat(64)),/HASH_MISMATCH/);
});
test('empty and non-successful downloads rejected',async()=>{
 await assert.rejects(checkedBytes(response(''),digest('')),/HASH_MISMATCH/);
 await assert.rejects(checkedBytes(new Response('not found',{status:404}),digest('not found')),/DOWNLOAD_REJECTED/);
});
test('redirect is rejected even with matching bytes',async()=>{
 const r=response('synthetic');Object.defineProperty(r,'redirected',{value:true});
 await assert.rejects(checkedBytes(r,digest('synthetic')),/DOWNLOAD_REJECTED/);
});
test('large declared response rejected before body consumption',async()=>{
 await assert.rejects(checkedBytes(response('x',{headers:{'content-length':String(MAX_FILE_BYTES+1)}}),digest('x')),/TOO_LARGE/);
});
test('streaming download is bounded without content-length',async()=>{
 await assert.rejects(checkedBytes(response(new Uint8Array(MAX_FILE_BYTES+1)),'a'.repeat(64)),/TOO_LARGE/);
});
test('relative or preexisting destination cannot be overwritten',async()=>{
 await assert.rejects(fetchPinnedPayrollSource('relative'),/EXPLICIT_SOURCE_DESTINATION/);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'payroll-source-test-'));
 try{fs.writeFileSync(path.join(dir,'untouched'),'sentinel');
  await assert.rejects(fetchPinnedPayrollSource(dir),/NEW_SOURCE_DESTINATION/);
  assert.equal(fs.readFileSync(path.join(dir,'untouched'),'utf8'),'sentinel');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('symlinked destination parent is not followed',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'payroll-source-test-'));
 try{fs.mkdirSync(path.join(dir,'actual'));fs.symlinkSync(path.join(dir,'actual'),path.join(dir,'link'));
  await assert.rejects(fetchPinnedPayrollSource(path.join(dir,'link','new')),/NEW_SOURCE_DESTINATION/);
  assert.equal(fs.existsSync(path.join(dir,'actual','new')),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('hash failure cleans only newly-created scratch and never sends authorization',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'payroll-source-test-'));let requests=0;
 try{const target=path.join(dir,'new');
  await assert.rejects(fetchPinnedPayrollSource(target,async(url,options)=>{
   requests++;assert.equal(url,PUBLIC_SOURCE_BASE+FILES[0]);assert.equal(options.redirect,'error');
   assert.equal(options.credentials,'omit');assert.deepEqual(options.headers,{Accept:'text/plain'});
   return response('wrong source');
  }),/HASH_MISMATCH/);
  assert.equal(requests,1);assert.equal(fs.existsSync(target),false);assert.equal(fs.existsSync(dir),true);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('network errors clean scratch without claiming success',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'payroll-source-test-'));
 try{const target=path.join(dir,'new');
  await assert.rejects(fetchPinnedPayrollSource(target,async()=>{throw Error('test-network-failure');}),/test-network-failure/);
  assert.equal(fs.existsSync(target),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
