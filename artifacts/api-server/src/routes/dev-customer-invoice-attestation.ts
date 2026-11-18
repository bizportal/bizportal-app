/**
 * Customer Invoice DEV: proof of an INDEPENDENT signed BizPortal Super Admin
 * session. No password exchange, no shared session cookie, no new login or
 * persistent private key. Only this BizPortal server holds its session secret.
 * The Portal pins the PUBLIC Ed25519 key separately.
 *
 * Intended browser flow: Portal creates signed Invoice challenge -> browser
 * opens this BizPortal endpoint as a top-level navigation (SameSite=Lax
 * session cookie works) -> signed proof goes to the trusted Portal origin via
 * postMessage (not an URL query string). Portal requires its OWN signed admin
 * session as well as this proof when POSTing mark_invoiced.
 */
import {
  createHash, createPrivateKey, createPublicKey, hkdfSync,
  randomBytes, sign,
} from "node:crypto";
import { Router, type Request, type Response } from "express";
import {
  getProductionSession, getProductionUser, isSignedPasswordDevEnabled,
} from "./dev-auth";

const router = Router();
const PROOF_DOMAIN = "CST_BIZPORTAL_CUSTOMER_INVOICE_DEV_V1\n";
const PURPOSE = "cst-customer-invoice-owner";
const AUDIENCE = "CST_CUSTOMER_PORTAL_DEV";
const MAX_AGE_MS = 90_000;
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function isCustomerInvoiceAttestationDevEnabled(): boolean {
  return process.env.APP_ENV?.trim().toLowerCase() === "development" &&
    isSignedPasswordDevEnabled() &&
    process.env.BIZPORTAL_CUSTOMER_INVOICE_ATTEST_DEV === "true";
}

function getSigningKey() {
  const secret = (process.env.BIZPORTAL_SESSION_SECRET ?? process.env.SESSION_SECRET)?.trim();
  if (!secret || secret.length < 32) throw Error("DEV_ATTESTATION_SIGNING_UNAVAILABLE");
  const raw = hkdfSync("sha256", Buffer.from(secret, "utf8"),
    Buffer.from("CST_BIZPORTAL_DEV_SESSION_DERIVED_KEY_V1"),
    Buffer.from("CUSTOMER_INVOICE_ED25519_ATTESTATION_V1"), 32);
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(raw)]),
    format: "der", type: "pkcs8",
  });
}

/** For setup only. This is a PUBLIC verifier, never an authorization grant. */
export function getCustomerInvoiceAttestationPublicKeyDev(): string {
  if (!isCustomerInvoiceAttestationDevEnabled()) throw Error("DEV_ATTESTATION_DISABLED");
  return (createPublicKey(getSigningKey()).export({ type: "spki", format: "der" }) as Buffer)
    .toString("base64");
}

function canonicalChallenge(raw: string): {
  companyId: number; invoiceId: number; portalEmail: string;
} | null {
  if (typeof raw !== "string" || raw.length < 60 || raw.length > 1600 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const [body, signature] = raw.split(".");
    if (!body || !signature || !/^[A-Za-z0-9_-]{30,}$/.test(signature)) return null;
    const decoded = Buffer.from(body, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== body) return null;
    const data = JSON.parse(decoded) as Record<string, unknown>;
    const companyId = Number(data.companyId);
    const invoiceId = Number(data.invoiceId);
    if (data.v !== 1 || data.purpose !== "cst-portal-invoice-challenge" ||
        ![1, 3].includes(companyId) ||
        !Number.isSafeInteger(invoiceId) || invoiceId < 1 ||
        !Number.isSafeInteger(Number(data.portalUserId)) ||
        Number(data.portalUserId) < 1 ||
        typeof data.portalEmail !== "string" ||
        data.portalEmail.length < 3 || data.portalEmail.length > 320 ||
        typeof data.nonce !== "string" || !/^[a-f0-9]{32}$/.test(data.nonce) ||
        typeof data.iat !== "number" || typeof data.exp !== "number" ||
        data.exp <= Date.now() || data.exp > Date.now() + MAX_AGE_MS ||
        data.iat > Date.now() + 5_000 || data.exp - data.iat > MAX_AGE_MS) return null;
    return {companyId, invoiceId, portalEmail:data.portalEmail.trim().toLowerCase()};
  } catch { return null; }
}

function createProof(args: {
  actorId: string; email: string; challenge: string;
  invoiceId: number; companyId: number;
}): string {
  const now = Date.now();
  const claims = {
    v:1, purpose:PURPOSE, aud:AUDIENCE,
    actorId:args.actorId, email:args.email,
    companyId:args.companyId, invoiceId:args.invoiceId,
    challengeDigest:createHash("sha256").update(args.challenge, "utf8").digest("hex"),
    nonce:randomBytes(16).toString("hex"),
    iat:now, exp:now + 60_000,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign(null, Buffer.from(PROOF_DOMAIN + body), getSigningKey())
    .toString("base64url");
  return body + "." + signature;
}

router.get("/auth/dev/customer-invoice-attestation", async (
  request:Request, response:Response,
):Promise<void> => {
  response.setHeader("Cache-Control","no-store");
  response.setHeader("Referrer-Policy","no-referrer");
  response.setHeader("X-Content-Type-Options","nosniff");
  response.setHeader("X-Frame-Options","DENY");
  if (!isCustomerInvoiceAttestationDevEnabled()) {
    response.status(404).json({error:"Not found"});
    return;
  }
  const challenge = typeof request.query.challenge === "string"
    ? request.query.challenge : "";
  const claims = canonicalChallenge(challenge);
  if (!claims) {
    response.status(400).json({error:"Invalid Invoice authorization challenge"});
    return;
  }
  try {
    // IMPORTANT: not getDevSession() or email matching. Cookie signature and
    // the original BizPortal user are checked via its original auth code.
    const session = getProductionSession(request);
    const actor = session ? await getProductionUser(session) : null;
    if (!actor || actor.id !== session?.id ||
        actor.email.trim().toLowerCase() !== claims.portalEmail ||
        actor.role !== "super_admin" || actor.companyId !== null) {
      response.status(401).json({error:"Signed BizPortal Super Admin session required"});
      return;
    }
    const proof = createProof({
      actorId:actor.id,email:actor.email.trim().toLowerCase(),
      challenge,companyId:claims.companyId,invoiceId:claims.invoiceId,
    });
    if (request.headers.accept?.includes("application/json")) {
      response.json({proof,expiresInSeconds:60});
      return;
    }
    // No credential/proof in URLs, redirect, referer or logs. postMessage
    // only to an operator-configured exact Portal origin, never "*".
    const target = (process.env.BIZPORTAL_CUSTOMER_PORTAL_ORIGIN_DEV ?? "").trim();
    let origin:URL;
    try { origin = new URL(target); }
    catch { response.status(503).json({error:"Portal origin not configured"}); return; }
    if (origin.origin !== target ||
        !(origin.protocol === "https:" ||
        (origin.protocol === "http:" && origin.hostname === "127.0.0.1"))) {
      response.status(503).json({error:"Portal origin not trusted"});
      return;
    }
    const nonce=randomBytes(16).toString("base64url");
    response.setHeader("Content-Security-Policy",
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; "+
      "script-src 'nonce-"+nonce+"'");
    response.status(200).type("html").send(
      "<!doctype html><html lang=\"id\"><meta charset=\"utf-8\">"+
      "<title>Verifikasi BizPortal</title><body>Verifikasi otorisasi selesai."+
      "<script nonce=\""+nonce+"\">"+
      "window.opener?.postMessage({type:'CST_INVOICE_BIZPORTAL_ATTEST_V1',"+
      "proof:"+JSON.stringify(proof)+",challenge:"+JSON.stringify(challenge)+"},"+
      JSON.stringify(target)+");window.close();</script></body></html>");
  } catch (error) {
    request.log?.error?.({error},"DEV independent BizPortal session attestation failed");
    response.status(503).json({error:"BizPortal verification temporarily unavailable"});
  }
});

export default router;
