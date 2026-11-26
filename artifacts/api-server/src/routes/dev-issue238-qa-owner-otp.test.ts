import express from "express";
import {createPublicKey, verify} from "node:crypto";
import {beforeAll,afterAll,beforeEach,afterEach,describe,it,expect,vi} from "vitest";
import type {Server} from "node:http";
const auth=vi.hoisted(()=>({
  enabled:vi.fn(),session:vi.fn(),user:vi.fn(),
}));
vi.mock("./dev-auth",()=>({
  isSignedOtpDevEnabled:auth.enabled,
  getProductionSession:auth.session,
  getProductionUser:auth.user,
}));
import qaRouter from "./dev-issue238-qa-owner-otp";
const KEYS=["APP_ENV","BIZPORTAL_ISSUE238_OWNER_OTP_DEV",
  "BIZPORTAL_ISSUE238_OWNER_ORIGIN_DEV","BIZPORTAL_SESSION_SECRET"];
const original=Object.fromEntries(KEYS.map(k=>[k,process.env[k]]));
let server:Server,base:string;
const identity={id:"owner-qa-1",email:"owner@example.invalid",role:"super_admin",companyId:null};
const path="/api/auth/dev/issue238-qa";
async function get(url:string) {
  const r=await fetch(base+url);return {status:r.status,body:await r.json() as Record<string,any>};
}
async function post(body:unknown,origin=base) {
  const r=await fetch(base+path+"/approve",{
    method:"POST",headers:{"content-type":"application/json",origin},body:JSON.stringify(body),
  });return {status:r.status,body:await r.json() as Record<string,any>};
}
describe("issue238 purpose-separated signed Owner OTP QA consent",()=>{
  beforeAll(async()=>{
    const app=express();app.use(express.json());app.use("/api",qaRouter);
    server=app.listen(0,"127.0.0.1");
    await new Promise<void>(resolve=>server.once("listening",resolve));
    const addr=server.address();if(!addr || typeof addr==="string") throw Error("No socket");
    base="http://127.0.0.1:"+addr.port;
  });
  afterAll(async()=>{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));});
  beforeEach(()=>{
    process.env.APP_ENV="development";
    process.env.BIZPORTAL_ISSUE238_OWNER_OTP_DEV="true";
    process.env.BIZPORTAL_SESSION_SECRET="x".repeat(60);
    process.env.BIZPORTAL_ISSUE238_OWNER_ORIGIN_DEV="https://dev-bizportal.cstlogistic.co.id";
    auth.enabled.mockReturnValue(true);
    auth.session.mockImplementation(()=>({id:identity.id,email:identity.email,
      issuedAt:Date.now()-2000,expiresAt:Date.now()+120000}));
    auth.user.mockResolvedValue(identity);
  });
  afterEach(()=>{
    vi.clearAllMocks();
    for(const k of KEYS){if(original[k]===undefined)delete process.env[k];else process.env[k]=original[k];}
  });
  const test="issue238-pg17-lock-expiry-concurrency-qa.sh";
  const commandId="11111111-1111-4111-8111-111111111111";
  const jobId="22222222-2222-4222-8222-222222222222";
  const challenge=()=>path+"/challenge?test="+encodeURIComponent(test)+
    "&commandId="+commandId+"&jobId="+jobId;
  it("disabled by default",async()=>{
    delete process.env.BIZPORTAL_ISSUE238_OWNER_OTP_DEV;
    expect((await get(challenge())).status).toBe(404);
    expect((await get(path+"/public-key")).status).toBe(404);
  });
  it("no owner session and non-owner denied",async()=>{
    auth.session.mockReturnValue(null);
    expect((await get(challenge())).status).toBe(401);
    auth.session.mockReturnValue({id:identity.id,email:identity.email,issuedAt:Date.now(),expiresAt:Date.now()+1000});
    auth.user.mockResolvedValue({...identity,role:"admin"});
    expect((await get(path+"/public-key")).status).toBe(401);
  });
  it("expired OTP session denied",async()=>{
    auth.session.mockReturnValue({id:identity.id,email:identity.email,
      issuedAt:Date.now()-11*60000,expiresAt:Date.now()+1000});
    expect((await get(challenge())).status).toBe(401);
  });
  it("rejects unlisted tests",async()=>{
    expect((await get(path+"/challenge?test=production.sql")).status).toBe(400);
  });
  it("denies unbound or malformed command/job IDs rather than inventing claims",async()=>{
    expect((await get(path+"/challenge?test="+test)).status).toBe(400);
    expect((await get(path+"/challenge?test="+test+"&commandId=CMD-fake&jobId=JOB-fake")).status).toBe(400);
    expect((await get(path+"/challenge?test="+test+"&commandId="+commandId)).status).toBe(400);
    const good=await get(challenge());
    expect(good.status).toBe(200);
    expect(good.body.claims.command_id).toBe(commandId);
    expect(good.body.claims.job_id).toBe(jobId);
  });
  it("rejects tampered command or job even when the nonce is unchanged",async()=>{
    const good=await get(challenge());
    expect(good.status).toBe(200);
    for(const field of ["command_id","job_id"]){
      const wrong={...good.body,claims:{...good.body.claims,
        [field]:"33333333-3333-4333-8333-333333333333"},
        approvalText:"SETUJUI QA #238 DEV"};
      const result=await post(wrong,process.env.BIZPORTAL_ISSUE238_OWNER_ORIGIN_DEV);
      expect(result.status).toBe(403);
    }
  });
  it("requires explicit same-origin POST and valid challenge",async()=>{
    const response=await get(challenge());
    expect(response.status).toBe(200);
    const {claims,expiresAt,consentProof}=response.body;
    const input={claims,expiresAt,consentProof,approvalText:"SETUJUI QA #238 DEV"};
    expect((await post(input,"https://untrusted.example")).status).toBe(403);
    expect((await post({...input,approvalText:"approve"},process.env.BIZPORTAL_ISSUE238_OWNER_ORIGIN_DEV)).status).toBe(400);
    expect((await post({...input,claims:{...claims,test:"unreviewed.sh"}},process.env.BIZPORTAL_ISSUE238_OWNER_ORIGIN_DEV)).status).toBe(400);
    expect((await post({...input,claims:{...claims,nonce:"NONCE-"+ "b".repeat(32)}},process.env.BIZPORTAL_ISSUE238_OWNER_ORIGIN_DEV)).status).toBe(403);
  });
  it("valid consent signs claims using separate Ed25519 public verifier",async()=>{
    const issued=await get(challenge());
    expect(issued.status).toBe(200);
    const approve=await post({...issued.body,approvalText:"SETUJUI QA #238 DEV"},
      process.env.BIZPORTAL_ISSUE238_OWNER_ORIGIN_DEV);
    expect(approve.status).toBe(200);
    const pub=await get(path+"/public-key");
    expect(pub.status).toBe(200);
    const request=approve.body.request;
    const sorted=Object.fromEntries(Object.keys(request.claims).sort().map(k=>[k,request.claims[k]]));
    const ok=verify(null,Buffer.from(JSON.stringify(sorted),"ascii"),
      createPublicKey(pub.body.publicKeyPem),Buffer.from(request.owner_signature,"base64"));
    expect(ok).toBe(true);
    expect(request.claims.operation).toBe("issue238-pg17-disposable-qa");
    expect(request.claims.environment).toBe("dev");
  });
});
