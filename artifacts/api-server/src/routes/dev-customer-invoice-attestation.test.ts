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
  "BIZPORTAL_SIGNED_PASSWORD_ENABLED_DEV",
];
const originals=Object.fromEntries(KEYS.map(k=>[k,process.env[k]]));
const email="qa-bizportal-super@example.invalid", id="qa-signed-bizportal-actor";
const issuedChallenge=(alter:Record<string,unknown>={})=>{
  const now=Date.now();
  const claim={
    v:1,purpose:"cst-portal-invoice-challenge",invoiceId:77,companyId:1,
    portalUserId:15,portalEmail:email,iat:now,exp:now+90_000,
    nonce:"a".repeat(32),...alter,
  };
  return Buffer.from(JSON.stringify(claim)).toString("base64url")+"."+"a".repeat(43);
};
const PROOF_DOMAIN="CST_BIZPORTAL_CUSTOMER_INVOICE_DEV_V1\n";
let base:string,server:Server;
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
    delete process.env.BIZPORTAL_SIGNED_PASSWORD_ENABLED_DEV;
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
  it("fails closed if legacy password and signed OTP modes overlap",async()=>{
    process.env.BIZPORTAL_SIGNED_PASSWORD_ENABLED_DEV="true";
    const r=await get(issuedChallenge(),{accept:"application/json"});
    expect(r.res.status).toBe(404);
    expect(m.getProductionSession).not.toHaveBeenCalled();
    expect(m.getProductionUser).not.toHaveBeenCalled();
    expect(()=>getCustomerInvoiceAttestationPublicKeyDev()).toThrow("DEV_ATTESTATION_DISABLED");
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
  it.each([
    ["wrong role",{role:"admin"}],
    ["company-limited",{companyId:3}],
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
  it("never issues proof on PROD even with a valid signed cookie",async()=>{
    process.env.APP_ENV="production";
    const r=await get(issuedChallenge(),{accept:"application/json"});
    expect(r.res.status).toBe(404);
  });
});
