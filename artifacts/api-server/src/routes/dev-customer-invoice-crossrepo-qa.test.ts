// DEV-only cross-repository contract. Original Portal source is pinned by CI checkout.
import express from "express";
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import type { Server } from "node:http";

const a=vi.hoisted(()=>({otp:vi.fn(()=>true),session:vi.fn(),user:vi.fn()}));
vi.mock("./dev-auth",()=>({
  isSignedOtpDevEnabled:a.otp,
  getProductionSession:a.session,
  getProductionUser:a.user,
}));
import issuer,{getCustomerInvoiceAttestationPublicKeyDev} from "./dev-customer-invoice-attestation";
import {
  mintPortalInvoiceChallenge,verifyIndependentBizPortalSuperAdminProof,
} from "../../../../vendor/customer-portal/server/dev-bizportal-invoice-attestation.mjs";

const email="qa@example.invalid",actorId="qa-bizportal-owner";
const context={portalUser:{id:12,role:"admin",email},invoiceId:77,companyId:1,canonicalActorId:actorId};
let server:Server,origin:string;

describe("actual BizPortal HTTP issuer -> pinned original Customer Portal verifier",()=>{
  beforeAll(async()=>{
    const app=express();
    app.use("/api",issuer);
    server=app.listen(0,"127.0.0.1");
    await new Promise<void>(resolve=>server.once("listening",resolve));
    const addr=server.address();
    if(!addr||typeof addr==="string")throw Error("NO_QA_SERVER");
    origin="http://127.0.0.1:"+addr.port;
  });
  afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});
  beforeEach(()=>{
    vi.clearAllMocks();
    a.otp.mockReturnValue(true);
    process.env.APP_ENV="development";
    process.env.SESSION_SECRET="qa-portal-session-secret-32-character-minimum";
    process.env.BIZPORTAL_SESSION_SECRET="qa-bizportal-independent-session-secret-32";
    process.env.BIZPORTAL_CUSTOMER_INVOICE_ATTEST_DEV="true";
    process.env.CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV="true";
    process.env.CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV="true";
    process.env.CUSTOMER_PORTAL_REQUIRE_BIZPORTAL_ATTEST_DEV="true";
    process.env.CUSTOMER_PORTAL_BIZPORTAL_ATTEST_SPKI_DEV=getCustomerInvoiceAttestationPublicKeyDev();
    a.session.mockReturnValue({id:actorId,email,expiresAt:Date.now()+60000});
    a.user.mockResolvedValue({id:actorId,email,role:"super_admin",companyId:null});
  });
  async function request(challenge:string) {
    const r=await fetch(origin+"/api/auth/dev/customer-invoice-attestation?challenge="+encodeURIComponent(challenge),{
      headers:{Cookie:"qa=signed",Accept:"application/json"},
    });
    return {status:r.status,body:await r.json()};
  }
  it("accepts genuine signed HTTP proof and rejects other company, invoice or actor",async()=>{
    const challenge=mintPortalInvoiceChallenge(context);
    const r=await request(challenge);
    expect(r.status).toBe(200);
    expect(verifyIndependentBizPortalSuperAdminProof({...context,challenge,proof:r.body.proof})).toBe(true);
    for(const change of [{companyId:3},{invoiceId:78},{canonicalActorId:"other"}]) {
      expect(verifyIndependentBizPortalSuperAdminProof({...context,...change,challenge,proof:r.body.proof})).toBe(false);
    }
  });
  it("fails closed for absent signed OTP session or non-superadmin",async()=>{
    const challenge=mintPortalInvoiceChallenge(context);
    a.session.mockReturnValue(null);
    expect((await request(challenge)).status).toBe(401);
    a.session.mockReturnValue({id:actorId,email,expiresAt:Date.now()+60000});
    a.user.mockResolvedValue({id:actorId,email,role:"admin",companyId:null});
    expect((await request(challenge)).status).toBe(401);
  });
});
