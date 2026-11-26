/**
 * Cross-source PR231 / PR155 / original PR142 financial integration.
 * Runs only against disposable invoice_synthetic PG16 with QA-only roles.
 * Email delivery and actual hosted browser OTP are intentionally NOT tested.
 */
import assert from "node:assert/strict";
import path from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath,pathToFileURL} from "node:url";
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const require=createRequire(path.join(ROOT,"artifacts/api-server/package.json"));
const pg=require("pg");
const express=require("express");
const env=process.env;
const uri=env.CUSTOMER_INVOICE_DISPOSABLE_DB_URL;
const ownerFile=env.CUSTOMER_INVOICE_DISPOSABLE_OWNER_PATH;
assert(uri&&new URL(uri).hostname==="127.0.0.1"&&new URL(uri).pathname==="/invoice_synthetic");
assert(ownerFile?.endsWith("/portalInvoiceAdapter.mjs"));
assert(env.APP_ENV==="development"&&env.NODE_ENV==="development");
for(const name of [
 "CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV",
 "CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV",
 "CUSTOMER_PORTAL_REQUIRE_BIZPORTAL_ATTEST_DEV",
 "CUSTOMER_PORTAL_INVOICE_CROSS_DEVICE_HANDOFF_DEV",
 "CUSTOMER_PORTAL_INVOICE_SIGNED_REVIEW_SNAPSHOT_DEV",
 "CUSTOMER_PORTAL_INVOICE_TAX_SOURCE_ROWLOCK_DEV",
 "BIZPORTAL_CUSTOMER_INVOICE_ATTEST_DEV",
 "BIZPORTAL_CUSTOMER_INVOICE_HANDOFF_DEV",
 "BIZPORTAL_CUSTOMER_INVOICE_SIGNED_REVIEW_SNAPSHOT_DEV"
]) assert(env[name]==="true","MISSING_TEST_FLAG_"+name);
env.SESSION_SECRET="only-disposable-portal-hmac-key-qa-with-32-bytes";
env.BIZPORTAL_SESSION_SECRET="only-disposable-owner-signer-test-key-with-32-bytes";
const {handleAdminInvoices}=await import(pathToFileURL(
 path.join(ROOT,"artifacts/api-server/.qa-modern-invoice-handler.mjs")).href);
const {postCustomerInvoiceWithOriginalOwner}=await import(pathToFileURL(ownerFile).href);
const signer=await import(pathToFileURL(
 path.join(ROOT,"artifacts/api-server/.qa-modern-otp-signer.mjs")).href);
const portalRoot=path.join(ROOT,"vendor/customer-portal/server");
const {mintPortalInvoiceChallenge,verifyIndependentBizPortalSuperAdminProof}=await import(
 pathToFileURL(path.join(portalRoot,"dev-bizportal-invoice-attestation.mjs")).href);
const handoff=await import(pathToFileURL(
 path.join(portalRoot,"dev-invoice-owner-handoff.mjs")).href);
const finance=await import(pathToFileURL(
 path.join(portalRoot,"dev-invoice-owner-review-snapshot.mjs")).href);
const {notifyAdmins}=await import(pathToFileURL(
 path.join(ROOT,"vendor/customer-portal/server/notification-service.mjs")).href);
const pool=new pg.Pool({connectionString:uri,ssl:false,max:2});
// The currently active CST-DEV B2 user RLS allows the matched canonical
// Owner to issue from their Portal Admin session. It DOES NOT permit a
// separate regular staff Admin until separate B5 company policy is approved.
// Use the same synthetic global Owner portal account for both companies.
const issuers={
 1:{id:501,email:"qa-owner@example.invalid",role:"admin",name:"Synthetic Global Owner as Portal Admin"},
 3:{id:501,email:"qa-owner@example.invalid",role:"admin",name:"Synthetic Global Owner as Portal Admin"}
};
async function rows(sql,params=[]){return (await pool.query(sql,params)).rows;}
const app=express();
app.get("/api/portal/dev/invoice-owner-handoff/:ticket/review",(request,response)=>{
 try{
  response.status(200).json(handoff.readInvoiceOwnerHandoffReview({
   ticket:request.params.ticket
  }));
 }catch{
  response.status(403).json({error:"QA_CLOSED_TICKET"});
 }
});
app.post("/api/portal/dev/invoice-owner-handoff/:ticket",
 express.urlencoded({extended:false}),(request,response)=>{
 try{
  if(!handoff.isTrustedInvoiceOwnerHandoffPost(request))
   throw Error("UNTRUSTED_POST");
  handoff.submitInvoiceOwnerHandoff({
    ticket:request.params.ticket,
    proof:request.body.proof,
    verify:verifyIndependentBizPortalSuperAdminProof,
  });
  response.status(200).send("SIGNED_OWNER_ACCEPTED");
 }catch{
  response.status(403).send("SIGNED_OWNER_REJECTED");
 }
});
app.use("/api",signer.default);
const server=app.listen(0,"127.0.0.1");
await new Promise(resolve=>server.once("listening",resolve));
const address=server.address();
assert(address&&typeof address!=="string"&&Number.isSafeInteger(address.port));
const origin="http://127.0.0.1:"+address.port;
env.BIZPORTAL_CUSTOMER_PORTAL_ORIGIN_DEV=origin;
env.CUSTOMER_PORTAL_BIZPORTAL_AUTH_ORIGIN_DEV=origin;
env.CUSTOMER_PORTAL_BIZPORTAL_ATTEST_SPKI_DEV=
 signer.getCustomerInvoiceAttestationPublicKeyDev();

async function signedApproval(id,companyId,{denyRole=false}={}){
 const issuer=issuers[companyId];
 assert(issuer);
 handoff.resetInvoiceOwnerHandoffsForQa();
 const source=await finance.readInvoiceOwnerReviewSnapshot(
   (statement,values)=>pool.query(statement,values),id);
 const digest=finance.invoiceOwnerReviewDigest(source);
 const challenge=mintPortalInvoiceChallenge({
  portalUser:issuer,invoiceId:id,companyId,reviewDigest:digest
 });
 const request=handoff.createInvoiceOwnerHandoff({
  issuer,invoiceId:id,companyId,challenge,
  reviewSnapshot:source,bizportalOrigin:origin
 });
 if(denyRole)env.QA_BIZPORTAL_ROLE_OVERRIDE="admin";
 let response;
 try{
  response=await fetch(request.approvalUrl,{
   headers:{cookie:"qa_otp=valid"},redirect:"error"
  });
 }finally{delete env.QA_BIZPORTAL_ROLE_OVERRIDE;}
 if(denyRole){
  assert.equal(response.status,401,"non-Owner cannot approve");
  return null;
 }
 assert.equal(response.status,200,"Original BizPortal HTTP signer must display canonical review");
 const html=await response.text();
 assert(html.includes("Setujui satu kali"));
 assert(html.includes(source.customerName));
 assert(html.includes("Total tagihan"));
 const match=html.match(/name="proof" value="([^"]+)"/);
 assert(match?.[1]&&match[1].length>100);
 const submitted=await fetch(origin+"/api/portal/dev/invoice-owner-handoff/"+request.ticket,{
  method:"POST",headers:{
   origin,"sec-fetch-site":"same-site",
   "content-type":"application/x-www-form-urlencoded",
  },
  body:new URLSearchParams({proof:match[1]}).toString(),redirect:"error"
 });
 assert.equal(submitted.status,200,"signed proof validated by Portal handoff");
 const approved=handoff.takeInvoiceOwnerHandoff({
  ticket:request.ticket,issuer,invoiceId:id
 });
 assert.equal(approved.ready,true);
 assert.equal(approved.bizportalInvoiceChallenge,challenge);
 assert.equal(approved.bizportalInvoiceProof,match[1]);
 assert.throws(()=>handoff.takeInvoiceOwnerHandoff({
  ticket:request.ticket,issuer,invoiceId:id
 }));
 console.log("MODERN_OWNER_SIGNED_SOURCE_HTTP_HANDOFF_PASS",companyId,id);
 return approved;
}
async function publish(id,companyId,approval){
 const output=[];
 try{
  await handleAdminInvoices({
   request:{method:"POST",body:{
    action:"mark_invoiced",
    bizportalInvoiceChallenge:approval.bizportalInvoiceChallenge,
    bizportalInvoiceProof:approval.bizportalInvoiceProof
   },headers:{}},
   response:{},user:issuers[companyId],invoiceId:id,
   sendJson:(_res,status,value)=>output.push({status,value}),
   sendError:(_res,status,message)=>{
    throw Object.assign(new Error(message),{statusCode:status});
   },
   postSalesInvoiceWithClient:postCustomerInvoiceWithOriginalOwner,
   verifySignedBizPortalProof:verifyIndependentBizPortalSuperAdminProof,
  });
  assert.equal(output.length,1);
  assert.equal(output[0].status,200);
  return output[0].value;
 }catch(error){
  console.error("MODERN_OWNER_DISPOSABLE_ISSUE_FAILED",companyId,id,
   String(error?.message),error?.code,error?.statusCode,error?.detail);
  throw error;
 }
}
async function verifyPosted(id,companyId){
 const gl=await rows(
  "select id,status::text status,total_debit,total_credit from public.accounting_entries "+
  "where company_id=$1 and source='sales_invoice' and source_id=$2",
  [companyId,id]
 );
 assert.equal(gl.length,1);
 assert.equal(gl[0].status,"posted");
 assert.equal(Number(gl[0].total_debit),111);
 assert.equal(Number(gl[0].total_credit),111);
 const entryId=Number(gl[0].id);
 const lines=await rows(
  "select count(*)::int n,coalesce(sum(debit),0) debit,coalesce(sum(credit),0) credit "+
  "from public.accounting_entry_lines where entry_id=$1",[entryId]);
 assert.equal(lines[0].n,3);
 assert.equal(Number(lines[0].debit),111);
 assert.equal(Number(lines[0].credit),111);
 const ar=await rows(
  "select gl_entry_id,gross_amount from public.ar_subledger "+
  "where invoice_id=$1 and company_id=$2",[id,companyId]);
 assert.equal(ar.length,1);assert.equal(Number(ar[0].gl_entry_id),entryId);
 assert.equal(Number(ar[0].gross_amount),111);
 const tax=await rows(
  "select tax_amount from public.transaction_taxes "+
  "where transaction_id=$1 and company_id=$2 and transaction_type='sales_invoice'",
  [id,companyId]);
 assert.equal(tax.length,1);assert.equal(Number(tax[0].tax_amount),11);
 const audit=await rows(
  "select id from public.audit_accounting_events where journal_id=$1 and company_id=$2",
  [entryId,companyId]);
 assert.equal(audit.length,1);
 const outbox=await rows(
  "select id from public.financial_outbox_events where entry_id=$1 and company_id=$2",
  [entryId,companyId]);
 assert.equal(outbox.length,1);
 // Exercise the ACTUAL Portal notification-service on the original
 // company RLS client, not a synthetic notification mock. Every company's
 // invoice must reach the authorized issuer but not an unassigned Admin.
 const notif=await rows(
  "select portal_customer_id,payload->>'audience' as audience from public.portal_customer_notifications where event_key=$1 order by portal_customer_id",
  ["sales-invoice:"+id+":invoiced"]);
 assert(notif.length>=1,"Issuer must receive an internal Invoice notification");
 const ids=notif.map(x=>Number(x.portal_customer_id));
 assert(ids.includes(501),"Matching global Owner as Portal issuer must be notified");
 assert(!ids.includes(504),"Unassigned Portal Admin must not receive company Invoice");
 if(companyId===1)assert(!ids.includes(503),"Diva-only Admin must not receive CST Invoice");
 console.log("MODERN_ISSUER_SCOPED_INVOICE_NOTIFICATION_NO_UNASSIGNED_ADMIN_PASS",companyId,id);
 console.log("MODERN_ORIGINAL_GL_PPN_AR_AUDIT_OUTBOX_PASS",companyId,id);
}
async function verifyCompanyPaymentRecipients(id,companyId) {
  // Only test internal Portal inbox routing with the original notification
  // code and synthetic Portal-service DB client. No payment, email, WA or
  // real bank state is changed here. Real payment mutation E2E is separate.
  for(const [suffix,type,status] of [
    ["submitted","sales_payment_submitted","pending"],
    ["paid","sales_payment_status_changed","paid"],
  ]) {
    const key="sales-payment:"+id+":"+suffix;
    const client=await pool.connect();
    try {
      await client.query("begin");
      const db=client.query.bind(client);
      const message=await notifyAdmins(db,{
        scopeCompanyId:companyId,
        eventKey:key,type,
        title:"Synthetic payment company notification",
        message:"Synthetic payment status "+status,
        resourceType:"payment",resourceId:id,
        payload:{paymentId:id,invoiceId:id,paymentStatus:status},
      });
      assert.equal(message,true);
      // Replayed event must remain exactly-once in original inbox.
      assert.equal(await notifyAdmins(db,{
        scopeCompanyId:companyId,
        eventKey:key,type,
        title:"Synthetic payment company notification",
        message:"Synthetic payment status "+status,
        resourceType:"payment",resourceId:id,
        payload:{paymentId:id,invoiceId:id,paymentStatus:status},
      }),true);
      await client.query("commit");
    } catch(error) {
      await client.query("rollback").catch(()=>{});
      throw error;
    } finally {client.release();}
    const got=await rows(
      "select portal_customer_id from public.portal_customer_notifications "+
      "where event_key=$1 order by portal_customer_id",[key]);
    const ids=got.map(r=>Number(r.portal_customer_id));
    assert.deepEqual(ids,companyId===1?[501]:[501,503]);
    assert(!ids.includes(504),"Unassigned admin must not see payment");
    if(companyId===1)assert(!ids.includes(503),"Diva-only admin must not see CST payment");
    console.log("MODERN_PAYMENT_SCOPED_OWNER_AND_COMPANY_STAFF_NOTIFICATION_PASS",
      companyId,id,suffix);
  }
}
async function verifyUnissued(id){
 const invoice=await rows("select invoice_status::text as status from public.sales_documents where id=$1",[id]);
 assert.equal(invoice.length,1);
 assert.equal(invoice[0].status,"to_invoice");
 const related=[
  ["accounting_entries","source_id"],
  ["ar_subledger","invoice_id"],
  ["transaction_taxes","transaction_id"]
 ];
 for(const [table,key] of related){
  const result=await rows(
   "select count(*)::int n from public."+table+" where "+key+"=$1",[id]);
  assert.equal(result[0].n,0,"No "+table+" after rejected issue");
 }
}
try{
 for(const companyId of [1,3]){
  const id=companyId===1?201:203;
  const role=companyId===1?
   "bizportal_customer_invoice_cst_writer_dev":
   "bizportal_customer_invoice_diva_writer_dev";
  const ruri=new URL(uri);
  ruri.username=role;ruri.password="synthetic-only-pass";
  const direct=new pg.Client({connectionString:ruri.toString(),ssl:false});
  await direct.connect();
  try{
   const identity=(await direct.query(
    "select current_user::text db_role,session_user::text session_role,"+
    "row_security_active('public.sales_documents'::regclass) rls")).rows[0];
   assert.equal(identity.db_role,role);
   assert.equal(identity.session_role,role);
   assert.equal(identity.rls,true);
   const other=await direct.query(
    "select count(*)::int n from public.sales_documents where company_id=$1",
    [companyId===1?3:1]);
   assert.equal(other.rows[0].n,0);
   console.log("MODERN_DIRECT_ROLE_RLS_NON_BYPASS_PASS",companyId);
  }finally{await direct.end();}
  const approval=await signedApproval(id,companyId);
  const issued=await publish(id,companyId,approval);
  assert.equal(issued.id,id);
  assert.equal(issued.invoiceStatus,"invoiced");
  await verifyPosted(id,companyId);
  await verifyCompanyPaymentRecipients(id,companyId);
  const again=await signedApproval(id,companyId);
  await publish(id,companyId,again);
  await verifyPosted(id,companyId);
  console.log("MODERN_SAME_SOURCE_REPLAY_IDEMPOTENT_PASS",companyId,id);
 }
 assert.equal(await signedApproval(205,1,{denyRole:true}),null);
 await verifyUnissued(205);
 console.log("MODERN_NON_OWNER_OTP_ROLE_DENIED_PASS");
 const wrong=await signedApproval(201,1);
 await assert.rejects(()=>publish(205,1,wrong));
 await verifyUnissued(205);
 console.log("MODERN_WRONG_INVOICE_PROOF_ROLLBACK_PASS");
 console.log("MODERN_ORIGINAL_OWNER_POSTGRES16_INTEGRATION_PASS");
}finally{
 await pool.end();
 await new Promise(resolve=>server.close(resolve));
}
