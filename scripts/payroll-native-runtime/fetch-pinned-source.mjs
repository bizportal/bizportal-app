/** CI-only acquisition of the SAME five previously verified public source files.
 * Never downloads a branch tip, executes the old app, or reads a credential.
 * Existing native builder independently rechecks all SHA256s before patch/build.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_SOURCE_COMMIT='2705d4c720fb7aa5d34f72ba60ef55be4dd91d7d';
export const PUBLIC_SOURCE_BASE='https://raw.githubusercontent.com/Travelintrips/CST-BIZPORTAL/'+PUBLIC_SOURCE_COMMIT+'/.upstream-cst-super-app/';
export const FILES=Object.freeze([
 'artifacts/api-server/src/lib/accounting.ts',
 'artifacts/api-server/src/lib/payroll/PayrollJournalService.ts',
 'artifacts/api-server/src/lib/currencyTolerance.ts',
 'artifacts/api-server/src/lib/payroll/payrollSettlementGuards.ts',
 'artifacts/api-server/src/lib/advance/AdvanceErrors.ts',
]);
export const MAX_FILE_BYTES=2*1024*1024;
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export function checkedHashes(manifest){
 if(!manifest||typeof manifest!=='object'||!manifest.sourceSha256||!manifest.dependencySha256)
  throw Error('PINNED_SOURCE_MANIFEST_INVALID');
 const pairs=[...Object.entries(manifest.sourceSha256),...Object.entries(manifest.dependencySha256)];
 if(pairs.length!==FILES.length||new Set(pairs.map(([k])=>k)).size!==FILES.length||
    pairs.some(([k,v])=>!FILES.includes(k)||typeof v!=='string'||!/^[0-9a-f]{64}$/.test(v)))
  throw Error('PINNED_SOURCE_MANIFEST_INVALID');
 return new Map(pairs);
}
export async function checkedBytes(response,expectedHash){
 if(!response||response.status!==200||response.redirected||!response.body)
  throw Error('PINNED_SOURCE_DOWNLOAD_REJECTED');
 const length=response.headers.get('content-length');
 if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_FILE_BYTES))
  throw Error('PINNED_SOURCE_DOWNLOAD_TOO_LARGE');
 const reader=response.body.getReader();let count=0;const chunks=[];
 try{
  while(true){const {done,value}=await reader.read();if(done)break;
   count+=value.byteLength;if(count>MAX_FILE_BYTES)throw Error('PINNED_SOURCE_DOWNLOAD_TOO_LARGE');
   chunks.push(Buffer.from(value));}
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 const bytes=Buffer.concat(chunks);
 if(!bytes.length||sha(bytes)!==expectedHash)throw Error('PINNED_SOURCE_HASH_MISMATCH');
 return bytes;
}
export async function fetchPinnedPayrollSource(destination,transport=globalThis.fetch){
 if(typeof destination!=='string'||!path.isAbsolute(destination))throw Error('EXPLICIT_SOURCE_DESTINATION_REQUIRED');
 const parent=fs.realpathSync(path.dirname(destination));
 const target=path.join(parent,path.basename(destination));
 if(path.resolve(destination)!==target||fs.existsSync(target))throw Error('NEW_SOURCE_DESTINATION_REQUIRED');
 const manifest=JSON.parse(fs.readFileSync(path.resolve(here,'../payroll-atomic-rehearsal/provenance.json'),'utf8'));
 const hashes=checkedHashes(manifest);
 // Exclusive creation ensures failures only remove the directory we created.
 fs.mkdirSync(target,{mode:0o700});
 try{
  for(const rel of FILES){
   const response=await transport(PUBLIC_SOURCE_BASE+rel,{redirect:'error',credentials:'omit',
    signal:AbortSignal.timeout(20000),headers:{Accept:'text/plain'}});
   const bytes=await checkedBytes(response,hashes.get(rel));
   const output=path.join(target,rel);
   fs.mkdirSync(path.dirname(output),{recursive:true,mode:0o700});
   fs.writeFileSync(output,bytes,{flag:'wx',mode:0o600});
  }
  return Object.freeze({sourceCommit:PUBLIC_SOURCE_COMMIT,verifiedFiles:FILES.length,
    liveCredentialsUsed:false,oldApplicationExecuted:false});
 }catch(error){fs.rmSync(target,{recursive:true,force:true});throw error;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const result=await fetchPinnedPayrollSource(process.argv[2]);
 console.log(JSON.stringify(result));
}
