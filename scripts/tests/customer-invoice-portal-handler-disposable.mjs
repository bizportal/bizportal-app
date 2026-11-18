import assert from "node:assert/strict";
import path from "node:path";
import {createRequire} from "node:module";
import {pathToFileURL,fileURLToPath} from "node:url";
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const require=createRequire(path.join(ROOT,"artifacts/api-server/package.json"));
const pg=require("pg");
const {handleAdminInvoices}=await import(pathToFileURL(path.join(ROOT,"artifacts/api-server/.qa-billing-handler-bundle.mjs")).href);
const {postCustomerInvoiceWithOriginalOwner}=await import(pathToFileURL(process.env.CUSTOMER_INVOICE_DISPOSABLE_OWNER_PATH).href);
const {
 mintPortalInvoiceChallenge,
 verifyIndependentBizPortalSuperAdminProof,
}=await import(pathToFileURL(path.join(ROOT,"vendor/customer-portal/server/dev-bizportal-invoice-attestation.mjs")).href);
const express=require("express");
const {
 default:bizportalIssuer,
 getCustomerInvoiceAttestationPublicKeyDev,
}=await import(pathToFileURL(path.join(ROOT,"artifacts/api-server/.qa-invoice-issuer-bundle.mjs")).href);
const QA_PORTAL_SECRET="only-disposable-qa-portal-secret-material-2026";
const QA_BIZ_SECRET="only-disposable-qa-bizportal-secret-material-2026";
process.env.SESSION_SECRET=QA_PORTAL_SECRET;
process.env.BIZPORTAL_SESSION_SECRET=QA_BIZ_SECRET;
process.env.BIZPORTAL_CUSTOMER_INVOICE_ATTEST_DEV="true";
process.env.BIZPORTAL_CUSTOMER_PORTAL_ORIGIN_DEV="http://127.0.0.1";
process.env.CUSTOMER_PORTAL_BIZPORTAL_ATTEST_SPKI_DEV=getCustomerInvoiceAttestationPublicKeyDev();
const app=express();
app.use("/api",bizportalIssuer);
const server=app.listen(0,"127.0.0.1");
await new Promise(resolve=>server.once("listening",resolve));
const address=server.address();
assert(address&&typeof address==="object"&&Number.isSafeInteger(address.port));
async function genuineIssuerProof(challenge,{authorized=true,admin=false}={}){
 const url="http://127.0.0.1:"+address.port+
  "/api/auth/dev/customer-invoice-attestation?challenge="+encodeURIComponent(challenge);
 if(admin)process.env.QA_BIZPORTAL_ROLE_OVERRIDE="admin";
 try{
  const response=await fetch(url,{headers:{
   accept:"application/json",
   cookie:authorized?"qa_otp=valid":"",
  }});
  const payload=await response.json();
  return {status:response.status,proof:payload.proof??null};
 }finally {delete process.env.QA_BIZPORTAL_ROLE_OVERRIDE;}
}
const {Pool}=pg;
const pool=new Pool({connectionString:process.env.CUSTOMER_INVOICE_DISPOSABLE_DB_URL,ssl:false,max:1});
const user={id:12,email:"qa-invoice@example.invalid",name:"QA Admin",role:"admin"};
async function invoke(id,valid=true) {
 const responses=[];
 const challenge=mintPortalInvoiceChallenge({
  portalUser:user,companyId:1,invoiceId:id,
 });
 // Real BizPortal PR148 HTTP issuer signs the original Portal HMAC challenge.
 const sourceChallenge=valid?challenge:mintPortalInvoiceChallenge({
  portalUser:user,companyId:1,invoiceId:id+1,
 });
 const issuer=await genuineIssuerProof(sourceChallenge);
 assert.equal(issuer.status,200,"actual BizPortal issuer HTTP200 expected");
 const proof=issuer.proof;
 assert(typeof proof==="string"&&proof.length>100);
 const request={method:"POST",body:{
  action:"mark_invoiced",bizportalInvoiceChallenge:challenge,bizportalInvoiceProof:proof,
 },headers:{}};
 const response={};
 try{
  await handleAdminInvoices({request,response,user,invoiceId:id,
   sendJson:(_response,status,value)=>responses.push({status,value}),
   sendError:(_response,status,message)=>{throw Object.assign(new Error(message),{status})},
   postSalesInvoiceWithClient:postCustomerInvoiceWithOriginalOwner,
   verifySignedBizPortalProof:verifyIndependentBizPortalSuperAdminProof});
  assert.equal(responses.length,1);
  assert.equal(responses[0].status,200);
  return responses[0].value;
 }catch(error){
  if(valid)throw error;
  assert.equal(error.statusCode,403,error.message);
  return null;
 }
}
async function rows(sql,values=[]){return (await pool.query(sql,values)).rows}
try{
 const issued=await invoke(197);
 assert.equal(issued.id,197);
 assert.equal(issued.invoiceStatus,"invoiced");
 assert.equal(issued.companyId,1);
 console.log("ORIGINAL_PORTAL_HANDLER_SAME_TRANSACTION_COMMIT_PASS");
 console.log("ORIGINAL_PORTAL_HMAC_ED25519_SIGNED_PROOF_PASS");
 console.log("ORIGINAL_BIZPORTAL_HTTP_ISSUER_TO_PORTAL_VERIFIER_PASS");
 const gl=await rows("select e.id,e.total_debit,e.total_credit from accounting_entries e where e.source='sales_invoice' and e.source_id=197");
 assert.equal(gl.length,1);
 assert.equal(Number(gl[0].total_debit),100);
 assert.equal(Number(gl[0].total_credit),100);
 const ar=await rows("select company_id,invoice_id,gl_entry_id,gross_amount from ar_subledger where invoice_id=197");
 assert.equal(ar.length,1);
 assert.equal(Number(ar[0].gl_entry_id),Number(gl[0].id));
 const evidence=await rows("select payload from financial_outbox_events where entry_id=$1",[gl[0].id]);
 assert.equal(evidence.length,1);
 assert.equal(Number(evidence[0].payload.sourceId),197);
 const audits=await rows("select action from audit_accounting_events where journal_id=$1",[gl[0].id]);
 assert.equal(audits.length,1);
 assert.equal(audits[0].action,"SALES_INVOICE_ISSUED");
 const activities=await rows("select id from activity_logs where deduplication_key='sales-invoice-issued:197'");
 assert.equal(activities.length,1);
 console.log("PORTAL_JOURNAL_AR_AUDIT_OUTBOX_ACTIVITY_PASS");
 const replay=await invoke(197);
 assert.equal(replay.id,197);
 assert.equal((await rows("select id from accounting_entries where source_id=197 and source='sales_invoice'")).length,1);
 console.log("ORIGINAL_PORTAL_HANDLER_REPLAY_IDEMPOTENT_PASS");
 // The original HTTP issuer must fail closed without an OTP session or
 // when the authenticated actor is not a canonical Super Admin.
 const missingSessionChallenge=mintPortalInvoiceChallenge({
  portalUser:user,companyId:1,invoiceId:199,
 });
 const missingSession=await genuineIssuerProof(missingSessionChallenge,{authorized:false});
 assert.equal(missingSession.status,401);
 assert.equal(missingSession.proof,null);
 const wrongRole=await genuineIssuerProof(missingSessionChallenge,{admin:true});
 assert.equal(wrongRole.status,401);
 assert.equal(wrongRole.proof,null);
 console.log("ORIGINAL_BIZPORTAL_ISSUER_OTP_ABSENT_AND_WRONG_ROLE_REJECTED_PASS");
 const denied=await invoke(199,false);
 assert.equal(denied,null);
 const remaining=await rows("select invoice_status::text as status from sales_documents where id=199");
 assert.equal(remaining[0].status,"to_invoice");
 assert.equal((await rows("select id from accounting_entries where source_id=199 and source='sales_invoice'")).length,0);
 console.log("ORIGINAL_PORTAL_HANDLER_DENIED_PROOF_ROLLBACK_PASS");
 console.log("ORIGINAL_PORTAL_WRONG_INVOICE_SIGNED_PROOF_DENIED_PASS");
}finally {
 await pool.end();
 await new Promise(resolve=>server.close(resolve));
}
