/** CST-DEV only: one explicit Owner OTP-session approval for disposable Issue #238 PG17 QA.
 * Deliberately not interchangeable with Customer Invoice attestations.
 * This module never executes QA, changes database roles, or sends OTP.
 */
import {
  createHash, createHmac, createPrivateKey, createPublicKey, hkdfSync,
  randomBytes, sign,
} from "node:crypto";
import {Router, type Request, type Response} from "express";
import {getProductionSession, getProductionUser, isSignedOtpDevEnabled} from "./dev-auth";

const router = Router();
const PURPOSE = "issue238-pg17-disposable-qa";
const PROJECT = "xssrfshdrtdfupgqwfdw";
const WORKER = "openclaw-vps-main";
const SQL_SHA = "0c7815ee6e9ffc9950ee1d7e5680e6debf8e11cd840074dd2991ec49fe6d79c4";
const IMAGE_SHA = "d9e2aef79dfb5d2737351a0010bb9d645726b331d42d4e25b87b31cff85d58d7";
const TESTS = [
  "issue238-pg17-lock-expiry-concurrency-qa.sh",
  "issue238-pgcron164-nonsuperuser-crash-qa.sh",
  "issue238-pgcron164-scheduler-crash-qa.sh",
] as const;
const MAX_SESSION_AGE_MS = 10 * 60_000;
const EXACT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// A durable AI Core command and task ID must already exist and be identified
// before Owner signs. This endpoint does not authenticate their DB existence.
function validWorkIds(commandId: unknown, jobId: unknown): commandId is string {
  return typeof commandId === "string" && typeof jobId === "string" &&
    EXACT_UUID.test(commandId) && EXACT_UUID.test(jobId);
}
const MAX_CHALLENGE_AGE_MS = 60_000;
const HKDF_SALT = "CST_BIZPORTAL_ISSUE238_DEV_V1";
const KEY_INFO = "ISSUE238_OWNER_ED25519_ATTESTATION_V1";
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function isIssue238OwnerOtpDevEnabled(): boolean {
  return process.env.APP_ENV?.trim().toLowerCase() === "development" &&
    isSignedOtpDevEnabled() &&
    process.env.BIZPORTAL_ISSUE238_OWNER_OTP_DEV === "true";
}

function sessionSecret(): string {
  const secret = (process.env.BIZPORTAL_SESSION_SECRET ?? process.env.SESSION_SECRET)?.trim();
  if (!secret || secret.length < 32) throw new Error("SIGNER_UNAVAILABLE");
  return secret;
}
function signingKey() {
  const seed = hkdfSync("sha256", Buffer.from(sessionSecret(), "utf8"),
    Buffer.from(HKDF_SALT), Buffer.from(KEY_INFO), 32);
  return createPrivateKey({key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]),
    type: "pkcs8", format: "der"});
}
function canonical(value: Record<string, unknown>): Buffer {
  const keys = Object.keys(value).sort();
  return Buffer.from(JSON.stringify(Object.fromEntries(keys.map(k => [k,value[k]]))), "ascii");
}
function error(res: Response, status: number, reason: string) {
  res.setHeader("Cache-Control","no-store");
  res.status(status).json({error:reason});
}
async function owner(req: Request) {
  if (!isIssue238OwnerOtpDevEnabled()) return null;
  const session = getProductionSession(req);
  if (!session || !Number.isFinite(session.issuedAt) ||
      session.issuedAt > Date.now() ||
      Date.now() - session.issuedAt > MAX_SESSION_AGE_MS) return null;
  const actor = await getProductionUser(session);
  if (!actor || actor.id !== session.id || actor.email !== session.email ||
      actor.role !== "super_admin" || (actor.companyId !== null && actor.companyId !== 1)) return null;
  return {session, actor};
}
function sameOrigin(req: Request): boolean {
  const origin = req.get("origin");
  const configured = process.env.BIZPORTAL_ISSUE238_OWNER_ORIGIN_DEV;
  return Boolean(origin && configured && origin === configured && /^https:\/\//.test(configured));
}
function makeClaims(test: string, now: number, commandId: string, jobId: string) {
  if (!TESTS.includes(test as typeof TESTS[number])) throw new Error("UNLISTED_TEST");
  if (!validWorkIds(commandId, jobId)) throw new Error("DURABLE_WORK_IDS_REQUIRED");
  return {
    command_id:commandId,
    job_id:jobId,
    nonce:"NONCE-"+randomBytes(16).toString("hex"),
    worker_id:WORKER, operation:PURPOSE, environment:"dev",
    project_ref:PROJECT, sql_sha256:SQL_SHA, image_sha256:IMAGE_SHA,
    test, issued_at:Math.floor(now/1000), expires_at:Math.floor(now/1000)+90,
  };
}
function challengeMac(claims: ReturnType<typeof makeClaims>, actorId: string, expiry: number) {
  return createHmac("sha256",sessionSecret())
    .update("issue238-qa-consent-v1\n")
    .update(actorId+"\n"+expiry+"\n")
    .update(canonical(claims)).digest("hex");
}

router.get("/auth/dev/issue238-qa/public-key", async(req,res)=>{
  res.setHeader("Cache-Control","no-store");
  try {
    if (!isIssue238OwnerOtpDevEnabled()) return error(res,404,"Not found");
    if (!await owner(req)) return error(res,401,"Owner OTP session required");
    const spki = createPublicKey(signingKey()).export({format:"pem",type:"spki"}).toString();
    res.status(200).json({purpose:PURPOSE,algorithm:"Ed25519",publicKeyPem:spki,
      fingerprintSha256:createHash("sha256").update(spki).digest("hex")});
  } catch {error(res,503,"Verifier unavailable");}
});

router.get("/auth/dev/issue238-qa/challenge", async(req,res)=>{
  res.setHeader("Cache-Control","no-store");
  try {
    if (!isIssue238OwnerOtpDevEnabled()) return error(res,404,"Not found");
    const identity=await owner(req);
    if (!identity) return error(res,401,"Owner OTP session required");
    const requested = typeof req.query.test==="string" ? req.query.test : "";
    if (!TESTS.includes(requested as typeof TESTS[number])) return error(res,400,"Invalid QA test");
    const commandId=typeof req.query.commandId==="string" ? req.query.commandId : "";
    const jobId=typeof req.query.jobId==="string" ? req.query.jobId : "";
    if (!validWorkIds(commandId,jobId)) return error(res,400,"Verified AI Core command and job UUIDs required");
    const claims=makeClaims(requested,Date.now(),commandId,jobId);
    const expiresAt=Date.now()+MAX_CHALLENGE_AGE_MS;
    const consentProof=challengeMac(claims,identity.actor.id,expiresAt);
    res.status(200).json({claims,expiresAt,consentProof,
      approvalText:"SETUJUI QA #238 DEV",ownerEmail:identity.actor.email,
      warning:"Disposable PostgreSQL 17 only. No PROD or Invoice writes."});
  } catch {error(res,503,"Challenge unavailable");}
});

router.post("/auth/dev/issue238-qa/approve", async(req,res)=>{
  res.setHeader("Cache-Control","no-store");
  try {
    if (!isIssue238OwnerOtpDevEnabled()) return error(res,404,"Not found");
    if (!sameOrigin(req) || req.get("content-type")?.split(";")[0].trim()!=="application/json")
      return error(res,403,"Same-origin consent required");
    const identity=await owner(req);
    if (!identity) return error(res,401,"Owner OTP session required");
    const body=req.body;
    if (!body || typeof body!=="object" || body.approvalText!=="SETUJUI QA #238 DEV")
      return error(res,400,"Explicit approval required");
    const {claims,expiresAt,consentProof}=body;
    if (!claims || typeof claims!=="object" || Array.isArray(claims) ||
        !Number.isSafeInteger(expiresAt) || expiresAt < Date.now() ||
        expiresAt > Date.now()+MAX_CHALLENGE_AGE_MS ||
        typeof consentProof!=="string" || !/^[a-f0-9]{64}$/.test(consentProof))
      return error(res,400,"Invalid challenge");
    if (typeof claims.test!=="string" || !TESTS.includes(claims.test as typeof TESTS[number]))
      return error(res,400,"Unlisted QA test");
    if (!validWorkIds(claims.command_id,claims.job_id)) return error(res,400,"Invalid durable work IDs");
    const expected=makeClaims(String(claims.test),Date.now(),claims.command_id,claims.job_id);
    const fields=Object.keys(expected);
    if (Object.keys(claims).length!==fields.length ||
        fields.some(k=>!(k in claims)) ||
        fields.some(k=>!["command_id","job_id","nonce","issued_at","expires_at"].includes(k) &&
          claims[k] !== (expected as Record<string,unknown>)[k]))
      return error(res,400,"Out-of-scope claims");
    if (typeof claims.nonce!=="string" || !/^NONCE-[a-f0-9]{32}$/.test(claims.nonce) ||
      !Number.isSafeInteger(claims.issued_at) || !Number.isSafeInteger(claims.expires_at) ||
      claims.issued_at > Math.floor(Date.now()/1000) ||
      Math.floor(Date.now()/1000)-claims.issued_at>60 ||
      claims.expires_at !== claims.issued_at+90)
      return error(res,400,"Expired or invalid claims");
    const expectedMac=challengeMac(claims,identity.actor.id,expiresAt);
    const {timingSafeEqual}=await import("node:crypto");
    if (!timingSafeEqual(Buffer.from(consentProof,"hex"),Buffer.from(expectedMac,"hex")))
      return error(res,403,"Unverified challenge");
    // The issuer has a durable exclusive nonce ledger; this signer only proves
    // authenticated Owner intent for the exact claims and cannot execute anything.
    const signature=sign(null,canonical(claims),signingKey()).toString("base64");
    res.status(200).json({request:{claims,owner_signature:signature},
      purpose:PURPOSE,expiresAt,ownerId:identity.actor.id});
  } catch {error(res,503,"Approval unavailable");}
});

export default router;
