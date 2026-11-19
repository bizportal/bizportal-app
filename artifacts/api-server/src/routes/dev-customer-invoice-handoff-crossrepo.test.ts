// @ts-nocheck — synthetic cross-repository DEV handoff, no live accounts.
import express from "express";
import {createHash} from "node:crypto";
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import type {Server} from "node:http";
const auth=vi.hoisted(()=>({otp:vi.fn(()=>true),session:vi.fn(),user:vi.fn()}));
vi.mock("./dev-auth",()=>({
  isSignedOtpDevEnabled:auth.otp,
  getProductionSession:auth.session,
  getProductionUser:auth.user,
}));
import signer,{getCustomerInvoiceAttestationPublicKeyDev} from "./dev-customer-invoice-attestation";
import {
  mintPortalInvoiceChallenge,verifyIndependentBizPortalSuperAdminProof,
} from "../../../../vendor/customer-portal/server/dev-bizportal-invoice-attestation.mjs";
import {
  createInvoiceOwnerHandoff,submitInvoiceOwnerHandoff,takeInvoiceOwnerHandoff,
  resetInvoiceOwnerHandoffsForQa,readInvoiceOwnerHandoffReview,
} from "../../../../vendor/customer-portal/server/dev-invoice-owner-handoff.mjs";
import {
  buildInvoiceOwnerReviewSnapshot,invoiceOwnerReviewDigest,
} from "../../../../vendor/customer-portal/server/dev-invoice-owner-review-snapshot.mjs";

const portalSecret="synthetic-portal-session-secret-only-for-test-20261119";
const ownerSecret="synthetic-bizportal-session-secret-only-for-test-20261119";
const issuer={id:17,role:"admin",email:"qa.issuer@example.invalid"};
const owner={id:"qa-owner",role:"super_admin",email:"qa.owner@example.invalid",companyId:null};
const devEnv={APP_ENV:"development",CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV:"true",
  CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV:"true",
  CUSTOMER_PORTAL_REQUIRE_BIZPORTAL_ATTEST_DEV:"true",
  CUSTOMER_PORTAL_INVOICE_CROSS_DEVICE_HANDOFF_DEV:"true",
  CUSTOMER_PORTAL_INVOICE_SIGNED_REVIEW_SNAPSHOT_DEV:"true"};
const orig=Object.fromEntries([
 "APP_ENV","SESSION_SECRET","BIZPORTAL_SESSION_SECRET",
 "BIZPORTAL_CUSTOMER_INVOICE_ATTEST_DEV","BIZPORTAL_CUSTOMER_INVOICE_HANDOFF_DEV",
 "BIZPORTAL_CUSTOMER_INVOICE_SIGNED_REVIEW_SNAPSHOT_DEV",
 "CUSTOMER_PORTAL_INVOICE_SIGNED_REVIEW_SNAPSHOT_DEV",
 "BIZPORTAL_CUSTOMER_PORTAL_ORIGIN_DEV","CUSTOMER_PORTAL_BIZPORTAL_ATTEST_SPKI_DEV",
 "CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV","CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV",
 "CUSTOMER_PORTAL_REQUIRE_BIZPORTAL_ATTEST_DEV"
].map(k=>[k,process.env[k]]));
const reviewSource=(companyId:number)=>({
 id:77,company_id:companyId,doc_number:"SO-QA-77",
 customer_name:"Synthetic Owner Review Customer",
 total_amount:"100.00",tax_amount:"11.00",grand_total:"111.00",
 tax_rate_id:companyId===1?1:9,selected_tax_id:companyId===1?1:9,
 tax_company_id:companyId,selected_tax_rate:"11.000",
 selected_tax_account_id:companyId===1?49109:49199,
 ppn_output_account_id:companyId===1?49109:49199,
 selected_tax_active:true,tax_treatment:"taxable",
 status:"confirmed",invoice_status:"to_invoice",cancelled_at:null,
});
let server:Server,origin:string;
describe("two-device one-Owner OTP signed handoff -> original Portal verifier",()=>{
 beforeAll(async()=>{
   const app=express();
   app.use("/api",signer);
   // QA-only synthetic Portal read endpoint. The exact same Portal
   // ticket service and crypto source files run under the pinned worktree.
   app.get("/api/portal/dev/invoice-owner-handoff/:ticket/review",(req,res)=>{
     try {res.json(readInvoiceOwnerHandoffReview({ticket:req.params.ticket,env:devEnv}));}
     catch{res.status(403).json({error:"Not available"});}
   });
   server=app.listen(0,"127.0.0.1");
   await new Promise(r=>server.once("listening",r));
   const address=server.address();
   if(!address||typeof address==="string")throw Error("HTTP_SERVER_UNAVAILABLE");
   origin="http://127.0.0.1:"+address.port;
 });
 afterAll(async()=>{
   await new Promise(r=>server.close(()=>r()));
   for(const [k,v] of Object.entries(orig)){
     if(v===undefined)delete process.env[k];else process.env[k]=v;
   }
 });
 beforeEach(()=>{
   resetInvoiceOwnerHandoffsForQa();
   process.env.APP_ENV="development";
   process.env.SESSION_SECRET=portalSecret;
   process.env.BIZPORTAL_SESSION_SECRET=ownerSecret;
   process.env.BIZPORTAL_CUSTOMER_INVOICE_ATTEST_DEV="true";
   process.env.BIZPORTAL_CUSTOMER_INVOICE_HANDOFF_DEV="true";
   process.env.BIZPORTAL_CUSTOMER_INVOICE_SIGNED_REVIEW_SNAPSHOT_DEV="true";
   process.env.CUSTOMER_PORTAL_INVOICE_SIGNED_REVIEW_SNAPSHOT_DEV="true";
   process.env.BIZPORTAL_CUSTOMER_PORTAL_ORIGIN_DEV=origin;
   process.env.CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV="true";
   process.env.CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV="true";
   process.env.CUSTOMER_PORTAL_REQUIRE_BIZPORTAL_ATTEST_DEV="true";
   process.env.CUSTOMER_PORTAL_BIZPORTAL_ATTEST_SPKI_DEV=getCustomerInvoiceAttestationPublicKeyDev();
   auth.otp.mockReturnValue(true);
   auth.session.mockReturnValue({id:owner.id,email:owner.email,expiresAt:Date.now()+90_000});
   auth.user.mockResolvedValue(owner);
 });
 it.each([1,3])("different device Owner approves company %i with one signed proof and no second Admin",async(companyId)=>{
   const reviewSnapshot=buildInvoiceOwnerReviewSnapshot(reviewSource(companyId));
   const challenge=mintPortalInvoiceChallenge({portalUser:issuer,invoiceId:77,companyId,
     reviewDigest:invoiceOwnerReviewDigest(reviewSnapshot)});
   const ticket=createInvoiceOwnerHandoff({
     issuer,invoiceId:77,companyId,challenge,bizportalOrigin:origin,reviewSnapshot,env:devEnv,
   });
   const response=await fetch(ticket.approvalUrl,{headers:{Cookie:"signed-qa-owner-session=true"}});
   expect(response.status).toBe(200);
   const html=await response.text();
   expect(html).toContain("Setujui satu kali");
   expect(html).toContain("Perusahaan: "+reviewSnapshot.companyName);
   expect(html).toContain("Synthetic Owner Review Customer");
   expect(html).toContain("Rp 111,00");
   expect(html).not.toContain("postMessage");
   const proof=html.match(/name="proof" value="([^"]+)"/)?.[1];
   expect(proof).toBeTruthy();
   const parsed=verifyIndependentBizPortalSuperAdminProof({
     challenge,proof,portalUser:issuer,invoiceId:77,companyId,
   });
   expect(parsed).toEqual({actorId:owner.id,email:owner.email});
   expect(submitInvoiceOwnerHandoff({
     ticket:ticket.ticket,proof,verify:verifyIndependentBizPortalSuperAdminProof,
     env:devEnv,
   })).toEqual({accepted:true});
   expect(takeInvoiceOwnerHandoff({
     ticket:ticket.ticket,issuer,invoiceId:77,env:devEnv,
   })).toEqual({ready:true,bizportalInvoiceChallenge:challenge,bizportalInvoiceProof:proof});
   expect(()=>takeInvoiceOwnerHandoff({
     ticket:ticket.ticket,issuer,invoiceId:77,env:devEnv,
   })).toThrow();
 });
 it("rejects signed Owner proof after company tampering",async()=>{
   const reviewSnapshot=buildInvoiceOwnerReviewSnapshot(reviewSource(1));
   const challenge=mintPortalInvoiceChallenge({portalUser:issuer,invoiceId:77,companyId:1,
     reviewDigest:invoiceOwnerReviewDigest(reviewSnapshot)});
   const ticket=createInvoiceOwnerHandoff({
     issuer,invoiceId:77,companyId:1,challenge,bizportalOrigin:origin,reviewSnapshot,env:devEnv,
   });
   const response=await fetch(ticket.approvalUrl,{headers:{Cookie:"signed-qa-owner-session=true"}});
   const proof=(await response.text()).match(/name="proof" value="([^"]+)"/)?.[1];
   expect(verifyIndependentBizPortalSuperAdminProof({challenge,proof,portalUser:issuer,
     invoiceId:77,companyId:3})).toBe(false);
 });
});
