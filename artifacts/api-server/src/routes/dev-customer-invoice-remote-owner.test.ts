// @ts-nocheck — actual two local HTTP servers, signed Ed25519, no Supabase DB.
import express from "express";
import type {Server} from "node:http";
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({
  signedAuthEnabled:vi.fn(()=>true),
  getProductionSession:vi.fn(),getProductionUser:vi.fn(),
}));
vi.mock("./dev-auth",()=>({
  isSignedOtpDevEnabled:mocks.signedAuthEnabled,
  getProductionSession:mocks.getProductionSession,
  getProductionUser:mocks.getProductionUser,
}));
import router,{getCustomerInvoiceAttestationPublicKeyDev} from "./dev-customer-invoice-attestation";
import {mintPortalInvoiceChallenge} from "../../../../vendor/customer-portal/server/dev-bizportal-invoice-attestation.mjs";
import {receiveDevRemoteOwnerProof,readDevRemoteOwnerProof,resetDevRemoteOwnerReceiptsForTest}
 from "../../../../vendor/customer-portal/server/dev-invoice-owner-receipt.mjs";

const issuer={id:46,role:"admin",email:"staff.cst@example.invalid"};
const owner={id:"owner-real-otp",email:"owner.cst@example.invalid",role:"super_admin",companyId:null};
const KEYS=["APP_ENV","SESSION_SECRET","BIZPORTAL_SESSION_SECRET",
 "BIZPORTAL_CUSTOMER_INVOICE_ATTEST_DEV","BIZPORTAL_CUSTOMER_INVOICE_REMOTE_OWNER_DEV",
 "BIZPORTAL_CUSTOMER_PORTAL_ORIGIN_DEV","BIZPORTAL_API_ORIGIN_DEV",
 "CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV","CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV",
 "CUSTOMER_PORTAL_REQUIRE_BIZPORTAL_ATTEST_DEV","CUSTOMER_PORTAL_REMOTE_OWNER_OTP_DEV",
 "CUSTOMER_PORTAL_BIZPORTAL_ATTEST_SPKI_DEV"];
const originals=Object.fromEntries(KEYS.map(k=>[k,process.env[k]]));
let signer:Server,receiver:Server,signerOrigin:string,receiverOrigin:string;
async function start(app) {
 const server=app.listen(0,"127.0.0.1");
 await new Promise<void>(resolve=>server.once("listening",resolve));
 const a=server.address(); if(!a||typeof a==="string")throw Error("NO_LOCAL_SERVER");
 return {server,origin:"http://127.0.0.1:"+a.port};
}
async function get(challenge:string) {
 return fetch(signerOrigin+"/api/auth/dev/customer-invoice-attestation?remote=1&challenge="+encodeURIComponent(challenge),
 {headers:{Cookie:"SIGNED_OWNER_SESSION",Accept:"text/html"}});
}
async function approve(challenge:string,extras={}) {
 return fetch(signerOrigin+"/api/auth/dev/customer-invoice-attestation/remote",
 {method:"POST",headers:{"Content-Type":"application/json",Origin:signerOrigin,
   Cookie:"SIGNED_OWNER_SESSION",...extras},
 body:JSON.stringify({challenge})});
}
describe("cross-device single Owner OTP: BizPortal HTTPS-like local HTTP -> Portal Ed25519 receipt",()=>{
 beforeAll(async()=>{
   const portalApp=express();portalApp.use(express.json({limit:"5kb"}));
   portalApp.post("/api/portal/dev/remote-owner-invoice/receipt",(req,res)=>{
      try {receiveDevRemoteOwnerProof(req.body);res.status(202).json({accepted:true});}
      catch{res.status(403).json({error:"Forbidden"});}
   });
   ({server:receiver,origin:receiverOrigin}=await start(portalApp));
   const bizApp=express();bizApp.use(express.json({limit:"5kb"}));
   bizApp.use((req,_res,next)=>{req.log={error:vi.fn()};next();});
   bizApp.use("/api",router);
   ({server:signer,origin:signerOrigin}=await start(bizApp));
 });
 afterAll(async()=>{
   await new Promise<void>(resolve=>signer.close(()=>resolve()));
   await new Promise<void>(resolve=>receiver.close(()=>resolve()));
 });
 beforeEach(()=>{
  vi.clearAllMocks();resetDevRemoteOwnerReceiptsForTest();
  process.env.APP_ENV="development";
  process.env.SESSION_SECRET="portal-qa-hmac-secret-32-plus-chars";
  process.env.BIZPORTAL_SESSION_SECRET="bizportal-qa-otp-secret-32-plus-chars";
  process.env.BIZPORTAL_CUSTOMER_INVOICE_ATTEST_DEV="true";
  process.env.BIZPORTAL_CUSTOMER_INVOICE_REMOTE_OWNER_DEV="true";
  process.env.BIZPORTAL_API_ORIGIN_DEV=signerOrigin;
  process.env.BIZPORTAL_CUSTOMER_PORTAL_ORIGIN_DEV=receiverOrigin;
  process.env.CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV="true";
  process.env.CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV="true";
  process.env.CUSTOMER_PORTAL_REQUIRE_BIZPORTAL_ATTEST_DEV="true";
  process.env.CUSTOMER_PORTAL_REMOTE_OWNER_OTP_DEV="true";
  mocks.signedAuthEnabled.mockReturnValue(true);
  mocks.getProductionSession.mockImplementation(req=>
    req.headers.cookie==="SIGNED_OWNER_SESSION"
      ? {id:owner.id,email:owner.email,expiresAt:Date.now()+60000}:null);
  mocks.getProductionUser.mockResolvedValue(owner);
  process.env.CUSTOMER_PORTAL_BIZPORTAL_ATTEST_SPKI_DEV=getCustomerInvoiceAttestationPublicKeyDev();
 });
 afterEach(()=>{
  resetDevRemoteOwnerReceiptsForTest();
  for(const key of KEYS)originals[key]===undefined?delete process.env[key]:process.env[key]=originals[key];
 });
 it.each([1,3])("requires an explicit Owner click before accepting company %i",async companyId=>{
  const challenge=mintPortalInvoiceChallenge({portalUser:issuer,invoiceId:77,companyId,
    invoiceSnapshot:{documentNumber:"SO-QA-77",grandTotal:"125000.00"}});
  const r=await get(challenge);
  expect(r.status).toBe(200);
  const html=await r.text();
  expect(html).toContain("Setujui satu kali");
  expect(html).toContain("SO-QA-77");
  expect(html).toContain("125.000");
  expect(html).not.toContain("owner-real-otp");
  expect(readDevRemoteOwnerProof({challenge,portalUser:issuer,invoiceId:77})).toEqual({approved:false});
  const approved=await approve(challenge);
  expect(approved.status).toBe(200);
  expect(await approved.json()).toEqual({approved:true});
  const receipt=readDevRemoteOwnerProof({challenge,portalUser:issuer,invoiceId:77});
  expect(receipt.approved).toBe(true);
  expect(typeof receipt.proof).toBe("string");
  // Requester never gains access to an Owner cookie, signed OTP or password.
  expect(receipt.proof).not.toContain("SIGNED_OWNER_SESSION");
 });
 it("denies a wrong cross-origin POST and leaves no approval",async()=>{
  const challenge=mintPortalInvoiceChallenge({portalUser:issuer,invoiceId:77,companyId:1,
    invoiceSnapshot:{documentNumber:"SO-QA-77",grandTotal:"125000.00"}});
  expect((await approve(challenge,{Origin:"https://evil.invalid"})).status).toBe(403);
  expect(readDevRemoteOwnerProof({challenge,portalUser:issuer,invoiceId:77})).toEqual({approved:false});
 });
 it("requires independently signed session and canonical Super Admin",async()=>{
  const challenge=mintPortalInvoiceChallenge({portalUser:issuer,invoiceId:77,companyId:1,
    invoiceSnapshot:{documentNumber:"SO-QA-77",grandTotal:"125000.00"}});
  mocks.getProductionSession.mockReturnValue(null);
  expect((await approve(challenge)).status).toBe(401);
  mocks.getProductionSession.mockReturnValue({id:owner.id,email:owner.email,expiresAt:Date.now()+60000});
  mocks.getProductionUser.mockResolvedValue({...owner,role:"admin"});
  expect((await approve(challenge)).status).toBe(401);
 });
 it("rejects Owner with wrong company scope",async()=>{
  const challenge=mintPortalInvoiceChallenge({portalUser:issuer,invoiceId:77,companyId:1,
    invoiceSnapshot:{documentNumber:"SO-QA-77",grandTotal:"125000.00"}});
  mocks.getProductionUser.mockResolvedValue({...owner,companyId:3});
  expect((await approve(challenge)).status).toBe(401);
 });
 it("closes remote path when the DEV flag is OFF",async()=>{
  const challenge=mintPortalInvoiceChallenge({portalUser:issuer,invoiceId:77,companyId:1,
    invoiceSnapshot:{documentNumber:"SO-QA-77",grandTotal:"125000.00"}});
  delete process.env.BIZPORTAL_CUSTOMER_INVOICE_REMOTE_OWNER_DEV;
  expect((await get(challenge)).status).toBe(404);
  expect((await approve(challenge)).status).toBe(404);
 });
 it("refuses tampered challenge even with a signed Owner cookie",async()=>{
  expect((await approve("x.y")).status).toBe(400);
 });
});
