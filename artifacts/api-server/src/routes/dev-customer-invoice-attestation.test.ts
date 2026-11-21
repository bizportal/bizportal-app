import express from "express";
import {createHash,createPublicKey,verify} from "node:crypto";
import type {Server} from "node:http";
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";

const m=vi.hoisted(()=>({
  signedAuthEnabled:vi.fn(),
  getProductionSession:vi.fn(),
  getProductionUser:vi.fn(),
}));
vi.mock("./dev-auth",()=>({
  isSignedOtpDevEnabled:m.signedAuthEnabled,
  getProductionSession:m.getProductionSession,
  getProductionUser:m.getProductionUser,
}));
import route,{
  getCustomerInvoiceAttestationPublicKeyDev,
} from "./dev-customer-invoice-attestation";

const KEYS=[
  "APP_ENV","SESSION_SECRET","BIZPORTAL_SESSION_SECRET",
  "BIZPORTAL_CUSTOMER_INVOICE_ATTEST_DEV","BIZPORTAL_CUSTOMER_PORTAL_ORIGIN_DEV",
  "BIZPORTAL_CUSTOMER_INVOICE_HANDOFF_DEV",
  "BIZPORTAL_CUSTOMER_INVOICE_SIGNED_REVIEW_SNAPSHOT_DEV",
];
const originals=Object.fromEntries(KEYS.map(k=>[k,process.env[k]]));
const email="qa-bizportal-super@example.invalid", id="qa-signed-bizportal-actor";
const issuerEmail="qa-portal-staff-issuer@example.invalid";
const issuedChallenge=(alter:Record<string,unknown>={})=>{
  const now=Date.now();
  const claim={
    v:1,purpose:"cst-portal-invoice-challenge",invoiceId:77,companyId:1,
    portalUserId:15,portalEmail:issuerEmail,iat:now,exp:now+90_000,
    nonce:"a".repeat(32),...alter,
  };
  return Buffer.from(JSON.stringify(claim)).toString("base64url")+"."+"a".repeat(43);
};
const PROOF_DOMAIN="CST_BIZPORTAL_CUSTOMER_INVOICE_DEV_V1\n";
let base:string,server:Server;
const sampleReview=(customerName="QA Customer")=>({
  schemaVersion:1,companyId:1,companyName:"PT Cahaya Sejati Teknologi",
  invoiceId:77,documentNumber:"SO-QA-77",customerName,currency:"IDR",
  subtotal:"100.00",ppn:"11.00",total:"111.00",
  ppnRatePercent:"11.000",taxId:1,taxAccountId:49109,
  taxTreatment:"taxable",documentStatus:"confirmed",invoiceStatus:"to_invoice",
});
let reviewResult={snapshot:sampleReview(),digest:""};
function setupOwnerReview(customerName="QA Customer") {
  const snapshot=sampleReview(customerName);
  const digest=createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  reviewResult={snapshot,digest};
  process.env.BIZPORTAL_CUSTOMER_INVOICE_HANDOFF_DEV="true";
  process.env.BIZPORTAL_CUSTOMER_INVOICE_SIGNED_REVIEW_SNAPSHOT_DEV="true";
  process.env.BIZPORTAL_CUSTOMER_PORTAL_ORIGIN_DEV=base;
  return digest;
}
async function get(challenge:string,options:{signed?:boolean;accept?:string}={}) {
  const u=base+"/api/auth/dev/customer-invoice-attestation?challenge="+encodeURIComponent(challenge);
  const res=await fetch(u,{headers:{
    ...(options.signed!==false?{Cookie:"bizportal_supabase_session=SIGNED_QA"}:{}),
    ...(options.accept?{Accept:options.accept}:{}),
  }});
  return {res,body:await res.text()};
}
describe("existing signed OTP BizPortal Super Admin -> Customer Invoice attestation",()=>{
  beforeAll(async()=>{
    const app=express();
    app.use((req,_res,next)=>{(req as any).log={error:vi.fn()};next();});
    app.use("/api",route);
    app.get("/api/portal/dev/invoice-owner-handoff/:ticket/review",
      (_req,res)=>res.json(reviewResult));
    server=app.listen(0,"127.0.0.1");
    await new Promise<void>(resolve=>server.once("listening",resolve));
    const address=server.address();
    if(!address||typeof address==="string")throw Error("TEST_SERVER_UNAVAILABLE");
    base="http://127.0.0.1:"+address.port;
  });
  afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});
  beforeEach(()=>{
    vi.clearAllMocks();
    process.env.APP_ENV="development";
    process.env.SESSION_SECRET="qa-original-bizportal-session-secret-32-plus-character-string";
    delete process.env.BIZPORTAL_SESSION_SECRET;
    process.env.BIZPORTAL_CUSTOMER_INVOICE_ATTEST_DEV="true";
    process.env.BIZPORTAL_CUSTOMER_PORTAL_ORIGIN_DEV="https://portal-qa.example.invalid";
    m.signedAuthEnabled.mockReturnValue(true);
    m.getProductionSession.mockImplementation(req=>
      req.headers.cookie==="bizportal_supabase_session=SIGNED_QA"
        ? {id,email,issuedAt:Date.now()-1000,expiresAt:Date.now()+10_000}
        : null);
    m.getProductionUser.mockResolvedValue({id,email,role:"super_admin",companyId:null});
  });
  afterEach(()=>{
    for(const k of KEYS){if(originals[k]===undefined)delete process.env[k];
    else process.env[k]=originals[k];}
  });
  it("strictly disabled unless DEV signed OTP + dedicated flag",async()=>{
    delete process.env.BIZPORTAL_CUSTOMER_INVOICE_ATTEST_DEV;
    const r=await get(issuedChallenge(),{accept:"application/json"});
    expect(r.res.status).toBe(404);
    expect(m.getProductionSession).not.toHaveBeenCalled();
  });
  it("refuses missing independently authenticated BizPortal cookie",async()=>{
    const r=await get(issuedChallenge(),{signed:false,accept:"application/json"});
    expect(r.res.status).toBe(401);
    expect(m.getProductionUser).not.toHaveBeenCalled();
  });
  it("issues an Ed25519 proof signed by BizPortal after revalidating its own session",async()=>{
    const challenge=issuedChallenge();
    const r=await get(challenge,{accept:"application/json"});
    expect(r.res.status).toBe(200);
    const {proof,expiresInSeconds}=JSON.parse(r.body);
    expect(expiresInSeconds).toBe(60);
    const [part,sig]=proof.split(".");
    const claims=JSON.parse(Buffer.from(part,"base64url").toString());
    expect(claims).toMatchObject({
      v:1,purpose:"cst-customer-invoice-owner",aud:"CST_CUSTOMER_PORTAL_DEV",
      actorId:id,email,companyId:1,invoiceId:77,
      challengeDigest:createHash("sha256").update(challenge).digest("hex"),
    });
    // A staff Admin opened the Portal challenge; an Owner signed it using
    // a completely different independently authenticated BizPortal account.
    expect(issuerEmail).not.toBe(email);
    const key=createPublicKey({
      key:Buffer.from(getCustomerInvoiceAttestationPublicKeyDev(),"base64"),
      format:"der",type:"spki",
    });
    expect(key.asymmetricKeyType).toBe("ed25519");
    expect(verify(null,Buffer.from(PROOF_DOMAIN+part),key,Buffer.from(sig,"base64url")))
      .toBe(true);
    expect(m.getProductionUser).toHaveBeenCalledTimes(1);
    expect(r.body).not.toContain("SESSION_SECRET");
  });
  it("allows an Owner scoped to the same company to approve one Invoice",async()=>{
    m.getProductionUser.mockResolvedValue({id,email,role:"super_admin",companyId:1});
    const r=await get(issuedChallenge(),{accept:"application/json"});
    expect(r.res.status).toBe(200);
    const claims=JSON.parse(Buffer.from(JSON.parse(r.body).proof.split(".")[0],"base64url").toString());
    expect(claims).toMatchObject({actorId:id,email,companyId:1,invoiceId:77});
  });
  it.each([
    ["wrong role",{role:"admin"}],
    ["wrong company scope",{companyId:3}],
    ["wrong email",{email:"other@example.invalid"}],
    ["different user ID",{id:"other"}],
  ])("refuses %s despite signed cookie",async(_label,change)=>{
    m.getProductionUser.mockResolvedValue({...{
      id,email,role:"super_admin",companyId:null,
    },...change});
    const r=await get(issuedChallenge(),{accept:"application/json"});
    expect(r.res.status).toBe(401);
  });
  it.each([
    ["wrong company",{companyId:2}],
    ["missing invoice",{invoiceId:0}],
    ["missing user",{portalUserId:null}],
    ["wrong email format",{portalEmail:"x".repeat(400)}],
    ["expired",{exp:0}],
    ["future expiration",{exp:Date.now()+300_000}],
    ["missing nonce",{nonce:"not-a-real-nonce"}],
  ])("rejects malformed challenge %s",async(_label,change)=>{
    const r=await get(issuedChallenge(change),{accept:"application/json"});
    expect(r.res.status).toBe(400);
    expect(m.getProductionSession).not.toHaveBeenCalled();
  });
  it("responds with strict target-origin postMessage when used as popup navigation",async()=>{
    const challenge=issuedChallenge(),r=await get(challenge);
    expect(r.res.status).toBe(200);
    expect(r.res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(r.res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(r.res.headers.get("Cache-Control")).toBe("no-store");
    expect(r.body).toContain("window.opener?.postMessage");
    expect(r.body).toContain("https://portal-qa.example.invalid");
    expect(r.body).not.toContain("targetOrigin:'*'");
  });
  it("rejects untrusted popup destination without leaking a signed proof",async()=>{
    process.env.BIZPORTAL_CUSTOMER_PORTAL_ORIGIN_DEV="https://evil.invalid/path";
    const r=await get(issuedChallenge());
    expect(r.res.status).toBe(503);
  });
  it("requires explicit Owner consent on own device for a signed source-specific handoff",async()=>{
    const digest=setupOwnerReview();
    const handoff="A".repeat(43);
    const challenge=issuedChallenge({reviewDigest:digest});
    const u=base+"/api/auth/dev/customer-invoice-attestation?challenge="+
      encodeURIComponent(challenge)+"&handoff="+handoff;
    const res=await fetch(u,{headers:{Cookie:"bizportal_supabase_session=SIGNED_QA"}});
    const html=await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain("form-action "+base);
    expect(html).toContain("Setujui satu kali");
    expect(html).toContain("QA Customer");
    expect(html).toContain("Rp 111,00");
    expect(html).toContain("PPN 11.000%");
    expect(html).toContain("/api/portal/dev/invoice-owner-handoff/"+handoff);
    expect(html).toContain("method=\"POST\"");
    expect(html).not.toContain("postMessage");
    expect(html).not.toContain("SESSION_SECRET");
    expect(html).not.toContain("bizportal_supabase_session");
  });
  it("fails closed if signed review flag or source digest is missing",async()=>{
    const digest=setupOwnerReview();
    const handoff="A".repeat(43);
    delete process.env.BIZPORTAL_CUSTOMER_INVOICE_SIGNED_REVIEW_SNAPSHOT_DEV;
    let u=base+"/api/auth/dev/customer-invoice-attestation?challenge="+
      encodeURIComponent(issuedChallenge({reviewDigest:digest}))+"&handoff="+handoff;
    expect((await fetch(u,{headers:{Cookie:"bizportal_supabase_session=SIGNED_QA"}})).status).toBe(404);
    process.env.BIZPORTAL_CUSTOMER_INVOICE_SIGNED_REVIEW_SNAPSHOT_DEV="true";
    u=base+"/api/auth/dev/customer-invoice-attestation?challenge="+
      encodeURIComponent(issuedChallenge())+"&handoff="+handoff;
    expect((await fetch(u,{headers:{Cookie:"bizportal_supabase_session=SIGNED_QA"}})).status).toBe(404);
  });
  it("blocks old bare OTP popup when source review is mandatory",async()=>{
    setupOwnerReview();
    const res=await get(issuedChallenge(),{accept:"application/json"});
    expect(res.res.status).toBe(409);
    expect(res.body).not.toContain("eyJ2");
  });
  it("rejects modified or untrusted source amount before consent form",async()=>{
    const digest=setupOwnerReview();
    reviewResult.snapshot={...reviewResult.snapshot,total:"999.00"};
    const u=base+"/api/auth/dev/customer-invoice-attestation?challenge="+
      encodeURIComponent(issuedChallenge({reviewDigest:digest}))+"&handoff="+"A".repeat(43);
    const res=await fetch(u,{headers:{Cookie:"bizportal_supabase_session=SIGNED_QA"}});
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("Setujui satu kali");
  });
  it("escapes customer name from the original Portal source before displaying on Owner device",async()=>{
    const digest=setupOwnerReview("<img src=x onerror=alert(1)>");
    const u=base+"/api/auth/dev/customer-invoice-attestation?challenge="+
      encodeURIComponent(issuedChallenge({reviewDigest:digest}))+"&handoff="+"A".repeat(43);
    const res=await fetch(u,{headers:{Cookie:"bizportal_supabase_session=SIGNED_QA"}});
    const html=await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
  });
  it("rejects malformed or query-injected handoff tickets",async()=>{
    const digest=setupOwnerReview();
    const u=base+"/api/auth/dev/customer-invoice-attestation?challenge="+
      encodeURIComponent(issuedChallenge({reviewDigest:digest}))+"&handoff="+encodeURIComponent("x<script>alert(1)");
    const res=await fetch(u,{headers:{Cookie:"bizportal_supabase_session=SIGNED_QA"}});
    expect(res.status).toBe(404);
  });
  it("never issues proof on PROD even with a valid signed cookie",async()=>{
    process.env.APP_ENV="production";
    const r=await get(issuedChallenge(),{accept:"application/json"});
    expect(r.res.status).toBe(404);
  });
});
