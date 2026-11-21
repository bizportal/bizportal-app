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
  getProductionSession, getProductionUser, isSignedOtpDevEnabled,
} from "./dev-auth";

const router = Router();
const PROOF_DOMAIN = "CST_BIZPORTAL_CUSTOMER_INVOICE_DEV_V1\n";
const PURPOSE = "cst-customer-invoice-owner";
const AUDIENCE = "CST_CUSTOMER_PORTAL_DEV";
const MAX_AGE_MS = 90_000;
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function isCustomerInvoiceAttestationDevEnabled(): boolean {
  return process.env.APP_ENV?.trim().toLowerCase() === "development" &&
    isSignedOtpDevEnabled() &&
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
  reviewDigest: string | null;
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
    const reviewDigest=typeof data.reviewDigest==="string"
      && /^[a-f0-9]{64}$/.test(data.reviewDigest)?data.reviewDigest:null;
    return {companyId, invoiceId,
      portalEmail:data.portalEmail.trim().toLowerCase(),reviewDigest};
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

// Data is never copied into URL, query string or token; Owner sees the
// authoritative Portal source via this strictly pinned, short-lived ticket.
function esc(value:unknown):string {
  return String(value??"").replace(/[&<>"']/g,
    ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]??""));
}
function idr(value:unknown):string {
  const str=String(value??"");
  if(!/^\d{1,14}\.\d{2}$/.test(str))throw Error("DEV_REVIEW_AMOUNT_INVALID");
  const [whole,decimal]=str.split(".");
  return "Rp "+whole.replace(/\B(?=(\d{3})+(?!\d))/g,".")+","+decimal;
}
async function fetchPinnedReview(target:string,ticket:string,claims:{
  companyId:number;invoiceId:number;reviewDigest:string|null;
}) {
  if(!claims.reviewDigest || !/^[a-f0-9]{64}$/.test(claims.reviewDigest))
    throw Error("DEV_OWNER_REVIEW_DIGEST_MISSING");
  const url=target+"/api/portal/dev/invoice-owner-handoff/"+ticket+"/review";
  const result=await fetch(url,{
    method:"GET",headers:{accept:"application/json"},cache:"no-store",
    redirect:"error",signal:AbortSignal.timeout(2500),
  });
  if(!result.ok)throw Error("DEV_OWNER_REVIEW_UNAVAILABLE");
  const data=await result.json() as {snapshot?:Record<string,unknown>;digest?:string};
  const value=data?.snapshot;
  if(!value || typeof value!=="object" || Array.isArray(value) ||
      Number(value.schemaVersion)!==1 ||
      value.companyId!==claims.companyId ||
      value.invoiceId!==claims.invoiceId ||
      value.currency!=="IDR" ||
      typeof value.customerName!=="string" || !value.customerName.trim() ||
      typeof value.documentNumber!=="string" || !value.documentNumber.trim() ||
      !["to_invoice","invoiced"].includes(String(value.invoiceStatus)) ||
      !/^\d{1,3}\.\d{3}$/.test(String(value.ppnRatePercent??""))) {
    throw Error("DEV_OWNER_REVIEW_INVALID");
  }
  // Require exact same byte-serialized canonical snapshot held in Portal's
  // HMAC challenge. A mismatched/tampered summary fails before Owner sees
  // a usable approval form, even though this transport uses HTTPS.
  const digest=createHash("sha256").update(JSON.stringify(value),"utf8").digest("hex");
  if(digest!==claims.reviewDigest || data.digest!==claims.reviewDigest)
    throw Error("DEV_OWNER_REVIEW_DIGEST_MISMATCH");
  // Validate all money strings without guessing or recalculating tax.
  for(const key of ["subtotal","ppn","total"])idr(value[key]);
  return value;
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
    // The Portal issuer can be a DIFFERENT person from the BizPortal Owner
    // approving this exact challenge. Never equate Portal issuer email with
    // the cryptographically authenticated Owner's email.
    // The signed BizPortal session stays pinned to its own active DB account.
    if (!actor || actor.id !== session?.id ||
        actor.email.trim().toLowerCase() !== session.email ||
        actor.role !== "super_admin" ||
        (actor.companyId !== null && Number(actor.companyId) !== claims.companyId)) {
      response.status(401).json({error:"Signed BizPortal Super Admin session required"});
      return;
    }
    const proof = createProof({
      actorId:actor.id,email:actor.email.trim().toLowerCase(),
      challenge,companyId:claims.companyId,invoiceId:claims.invoiceId,
    });
    const handoff = typeof request.query.handoff === "string"
      ? request.query.handoff : "";
    // When signed financial review is mandatory, the original bare popup
    // must not mint a financial authorization without showing source details.
    if (!handoff && process.env.BIZPORTAL_CUSTOMER_INVOICE_SIGNED_REVIEW_SNAPSHOT_DEV === "true") {
      response.status(409).json({error:"Ringkasan Invoice Owner wajib diverifikasi sebelum persetujuan."});
      return;
    }
    if (handoff) {
      if (process.env.BIZPORTAL_CUSTOMER_INVOICE_HANDOFF_DEV !== "true" ||
          process.env.BIZPORTAL_CUSTOMER_INVOICE_SIGNED_REVIEW_SNAPSHOT_DEV !== "true" ||
          !claims.reviewDigest ||
          !/^[A-Za-z0-9_-]{43}$/.test(handoff)) {
        response.status(404).json({error:"Invoice handoff not available"});
        return;
      }
      // A signed-in Owner can review the transaction on their OWN device.
      // Explicit button press sends only the short-lived signed proof, not
      // the Owner's cookie, session token, password or email OTP.
      const target = (process.env.BIZPORTAL_CUSTOMER_PORTAL_ORIGIN_DEV ?? "").trim();
      let origin:URL;
      try {origin=new URL(target);}
      catch {response.status(503).json({error:"Portal origin not configured"});return;}
      if (origin.origin !== target ||
          !(origin.protocol === "https:" ||
            (origin.protocol === "http:" && origin.hostname === "127.0.0.1"))) {
        response.status(503).json({error:"Portal origin not trusted"});
        return;
      }
      const summary=await fetchPinnedReview(target,handoff,claims);
      response.setHeader("Content-Security-Policy",
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; "+
        "form-action "+target);
      response.status(200).type("html").send(
        "<!doctype html><html lang=\"id\"><meta charset=\"utf-8\">"+
        "<title>Persetujuan Invoice</title><body>"+
        "<h1>Persetujuan Invoice</h1>"+
        "<p>Perusahaan: "+esc(summary.companyName)+"</p>"+
        "<p>Nomor dokumen: "+esc(summary.documentNumber)+"</p>"+
        "<p>Customer: "+esc(summary.customerName)+"</p>"+
        "<p>Nilai sebelum pajak: "+esc(idr(summary.subtotal))+"</p>"+
        "<p>PPN "+esc(summary.ppnRatePercent)+"%: "+esc(idr(summary.ppn))+"</p>"+
        "<p>Total tagihan: <strong>"+esc(idr(summary.total))+"</strong></p>"+
        "<p>Persetujuan hanya berlaku untuk rincian ini. "+
        "Jika angka berubah, sistem menolak penerbitan.</p>"+
        "<form method=\"POST\" action=\""+target+
          "/api/portal/dev/invoice-owner-handoff/"+handoff+"\">"+
        "<input type=\"hidden\" name=\"proof\" value=\""+proof+"\">"+
        "<button type=\"submit\">Setujui satu kali</button></form>"+
        "</body></html>");
      return;
    }
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
