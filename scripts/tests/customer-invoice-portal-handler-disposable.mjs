import assert from "node:assert/strict";
import path from "node:path";
import {createHash,createPrivateKey,createPublicKey,hkdfSync,randomBytes,sign} from "node:crypto";
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
const QA_PORTAL_SECRET="only-disposable-qa-portal-secret-material-2026";
const QA_BIZ_SECRET="only-disposable-qa-bizportal-secret-material-2026";
process.env.SESSION_SECRET=QA_PORTAL_SECRET;
process.env.BIZPORTAL_SESSION_SECRET=QA_BIZ_SECRET;
process.env.CUSTOMER_PORTAL_BIZPORTAL_ATTEST_SPKI_DEV="";
const qaSeed=hkdfSync("sha256",Buffer.from(QA_BIZ_SECRET,"utf8"),
 Buffer.from("CST_BIZPORTAL_DEV_SESSION_DERIVED_KEY_V1"),
 Buffer.from("CUSTOMER_INVOICE_ED25519_ATTESTATION_V1"),32);
const qaPrivateKey=createPrivateKey({
 key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),Buffer.from(qaSeed)]),
 format:"der",type:"pkcs8",
});
process.env.CUSTOMER_PORTAL_BIZPORTAL_ATTEST_SPKI_DEV=createPublicKey(qaPrivateKey)
 .export({type:"spki",format:"der"}).toString("base64");
function makeIndependentQaProof(challenge,invoiceId){
 const signed={
  v:1,purpose:"cst-customer-invoice-owner",aud:"CST_CUSTOMER_PORTAL_DEV",
  actorId:"synthetic-owner",email:"qa-invoice@example.invalid",
  companyId:1,invoiceId,
  challengeDigest:createHash("sha256").update(challenge,"utf8").digest("hex"),
  nonce:randomBytes(16).toString("hex"),
  iat:Date.now(),exp:Date.now()+60000,
 };
 const body=Buffer.from(JSON.stringify(signed)).toString("base64url");
 return body+"."+sign(null,Buffer.from("CST_BIZPORTAL_CUSTOMER_INVOICE_DEV_V1\n"+body),qaPrivateKey).toString("base64url");
}
const {Pool}=pg;
const pool=new Pool({connectionString:process.env.CUSTOMER_INVOICE_DISPOSABLE_DB_URL,ssl:false,max:1});
const user={id:12,email:"qa-invoice@example.invalid",name:"QA Admin",role:"admin"};
async function invoke(id,valid=true) {
 const responses=[];
 const challenge=mintPortalInvoiceChallenge({
  portalUser:user,companyId:1,invoiceId:id,
 });
 const issuedProof=makeIndependentQaProof(challenge,id);
 // Negative case changes the invoice binding without falsifying the signature.
 const proof=valid?issuedProof:makeIndependentQaProof(challenge,id+1);
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
 const denied=await invoke(199,false);
 assert.equal(denied,null);
 const remaining=await rows("select invoice_status::text as status from sales_documents where id=199");
 assert.equal(remaining[0].status,"to_invoice");
 assert.equal((await rows("select id from accounting_entries where source_id=199 and source='sales_invoice'")).length,0);
 console.log("ORIGINAL_PORTAL_HANDLER_DENIED_PROOF_ROLLBACK_PASS");
 console.log("ORIGINAL_PORTAL_WRONG_INVOICE_SIGNED_PROOF_DENIED_PASS");
}finally {await pool.end()}
