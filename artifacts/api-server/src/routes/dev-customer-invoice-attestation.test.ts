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
  "BIZPORTAL_COMPANY_SELF_APPROVAL_DEV",
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
    app.use(express.json());
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
    process.env.BIZPORTAL_COMPANY_SELF_APPROVAL_DEV="true";
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
  it("returns existing PUBLIC Ed25519 verifier to signed CST Super Admin before attestation enabled", async () => {
    const originalVerifier = getCustomerInvoiceAttestationPublicKeyDev();
    delete process.env.BIZPORTAL_CUSTOMER_INVOICE_ATTEST_DEV;
    const res = await fetch(base + "/api/auth/dev/customer-invoice-attestation/public-key", {
      headers: {Cookie:"bizportal_supabase_session=SIGNED_QA"},
    });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string,unknown>;
    expect(data).toMatchObject({
      purpose:"customer-invoice-public-verifier-setup",
      algorithm:"Ed25519", attestationEnabled:false,
      publicKeySpkiDerBase64:originalVerifier,
    });
    const spki = Buffer.from(String(data.publicKeySpkiDerBase64),"base64");
    expect(createPublicKey({key:spki,format:"der",type:"spki"}).asymmetricKeyType).toBe("ed25519");
    expect(data.fingerprintSha256).toBe(createHash("sha256").update(spki).digest("hex"));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("vary")).toContain("Cookie");
    expect(JSON.stringify(data)).not.toContain(process.env.SESSION_SECRET);
    expect(JSON.stringify(data)).not.toContain(email);
    expect(JSON.stringify(data)).not.toContain("SIGNED_QA");
  });
  it("never publishes public verifier to unsigned or wrong-tenant sessions", async () => {
    const url=base + "/api/auth/dev/customer-invoice-attestation/public-key";
    let res=await fetch(url);
    expect(res.status).toBe(401);
    m.getProductionUser.mockResolvedValue({id,email,role:"admin",companyId:1});
    res=await fetch(url,{headers:{Cookie:"bizportal_supabase_session=SIGNED_QA"}});
    expect(res.status).toBe(401);
    m.getProductionUser.mockResolvedValue({id,email,role:"super_admin",companyId:3});
    res=await fetch(url,{headers:{Cookie:"bizportal_supabase_session=SIGNED_QA"}});
    expect(res.status).toBe(401);
  });
  it("refuses verifier setup in PROD or without signed OTP DEV configuration",async()=>{
    const url=base + "/api/auth/dev/customer-invoice-attestation/public-key";
    process.env.APP_ENV="production";
    let res=await fetch(url,{headers:{Cookie:"bizportal_supabase_session=SIGNED_QA"}});
    expect(res.status).toBe(404);
    process.env.APP_ENV="development";
    m.signedAuthEnabled.mockReturnValue(false);
    res=await fetch(url,{headers:{Cookie:"bizportal_supabase_session=SIGNED_QA"}});
    expect(res.status).toBe(404);
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
  const selfChallenge=(changes:Record<string,unknown>={})=>{
    const now=Date.now();
    const c={
      v:1,purpose:"cst-portal-company-self-approval",requestId:17,companyId:1,
      applicantId:9,portalUserId:9,portalEmail:email,
      iat:now,exp:now+90000,nonce:"b".repeat(32),...changes,
    };
    return Buffer.from(JSON.stringify(c)).toString("base64url")+"."+"a".repeat(43);
  };
  const selfGet=async(challenge:string,signed=true)=>{
    const res=await fetch(base+"/api/auth/dev/customer-company-self-approval?challenge="+
      encodeURIComponent(challenge),{headers:signed?{Cookie:"bizportal_supabase_session=SIGNED_QA"}:{}});
    return {res,html:await res.text()};
  };
  const extractConsent=(html:string)=>{
    const found=html.match(/const consentToken="([A-Za-z0-9_-]{43})"/);
    expect(found).not.toBeNull();
    return found![1];
  };
  const consentPost=async(challenge:string,consentToken:string,options:{
    origin?:string;site?:string;cookie?:string;
  }={})=>{
    return fetch(base+"/api/auth/dev/customer-company-self-approval",{
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "Sec-Fetch-Site":options.site??"same-origin",
        Origin:options.origin??base,
        Cookie:options.cookie??"bizportal_supabase_session=SIGNED_QA",
      },
      body:JSON.stringify({challenge,consentToken}),
    });
  };
  it("GET shows consent only, POST issues one purpose-separated proof after click",async()=>{
    const challenge=selfChallenge();
    const {res,html}=await selfGet(challenge);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(html).toContain("Persetujuan afiliasi CST");
    expect(html).toContain("Nomor permohonan: 17");
    expect(html).toContain("Verifikasi dan setujui satu kali");
    expect(html).toContain("addEventListener('click'");
    expect(html).not.toContain('"proof":');
    // The message TYPE is static client code; signed proof itself is absent on GET.
    expect(html).not.toMatch(/"proof":"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"/);
    expect(html).not.toContain(process.env.SESSION_SECRET);
    const consentToken=extractConsent(html);
    const post=await consentPost(challenge,consentToken);
    expect(post.status).toBe(200);
    const {proof,expiresInSeconds}=await post.json() as {proof:string;expiresInSeconds:number};
    expect(expiresInSeconds).toBe(60);
    const [part,sig]=proof.split(".");
    const claims=JSON.parse(Buffer.from(part,"base64url").toString());
    expect(claims).toMatchObject({
      purpose:"cst-company-affiliation-self-approval",aud:"CST_CUSTOMER_PORTAL_DEV",
      requestId:17,companyId:1,applicantId:9,portalUserId:9,
      actorId:id,email,challengeDigest:createHash("sha256").update(challenge).digest("hex"),
    });
    const pub=createPublicKey({
      key:Buffer.from(getCustomerInvoiceAttestationPublicKeyDev(),"base64"),
      format:"der",type:"spki",
    });
    expect(verify(null,Buffer.from("CST_BIZPORTAL_COMPANY_SELF_APPROVAL_DEV_V1\n"+part),
      pub,Buffer.from(sig,"base64url"))).toBe(true);
    expect(verify(null,Buffer.from(PROOF_DOMAIN+part),
      pub,Buffer.from(sig,"base64url"))).toBe(false);
    // The same one-time nonce is not reusable.
    expect((await consentPost(challenge,consentToken)).status).toBe(403);
  });
  it("POST rejects cross-origin, cross-site, tampered or sessionless consent",async()=>{
    const challenge=selfChallenge();
    const consentToken=extractConsent((await selfGet(challenge)).html);
    expect((await consentPost(challenge,consentToken,{site:"cross-site"})).status).toBe(403);
    expect((await consentPost(challenge,consentToken,{origin:"https://attacker.invalid"})).status).toBe(403);
    expect((await consentPost(challenge,consentToken,{cookie:""})).status).toBe(401);
    // A denied consent consumes its nonce; a fresh GET is required.
    expect((await consentPost(challenge,consentToken)).status).toBe(403);
    const second=extractConsent((await selfGet(challenge)).html);
    expect((await consentPost(selfChallenge({requestId:18}),second)).status).toBe(403);
  });
  it("self-affiliation requires fresh signed Super Admin session for the same applicant email",async()=>{
    let result=await selfGet(selfChallenge(),false);
    expect(result.res.status).toBe(401);
    m.getProductionSession.mockReturnValueOnce({
      id,email,issuedAt:Date.now()-301000,expiresAt:Date.now()+20000,
    });
    result=await selfGet(selfChallenge());
    expect(result.res.status).toBe(401);
    m.getProductionUser.mockResolvedValueOnce({id,email,role:"admin",companyId:1});
    result=await selfGet(selfChallenge());
    expect(result.res.status).toBe(401);
    m.getProductionUser.mockResolvedValueOnce({id,email,role:"super_admin",companyId:3});
    result=await selfGet(selfChallenge());
    expect(result.res.status).toBe(401);
    result=await selfGet(selfChallenge({portalEmail:"another@example.invalid"}));
    expect(result.res.status).toBe(401);
  });
  it("self-affiliation rejects malformed requests and remains disabled on PROD",async()=>{
    let r=await selfGet(selfChallenge({companyId:3}));
    expect(r.res.status).toBe(400);
    r=await selfGet(selfChallenge({applicantId:999}));
    expect(r.res.status).toBe(400);
    r=await selfGet(selfChallenge({exp:Date.now()-1}));
    expect(r.res.status).toBe(400);
    delete process.env.BIZPORTAL_COMPANY_SELF_APPROVAL_DEV;
    r=await selfGet(selfChallenge());
    expect(r.res.status).toBe(404);
    process.env.BIZPORTAL_COMPANY_SELF_APPROVAL_DEV="true";
    process.env.APP_ENV="production";
    r=await selfGet(selfChallenge());
    expect(r.res.status).toBe(404);
  });

});
