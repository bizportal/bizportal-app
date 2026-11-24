import { Router, type Request, type Response } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import {
  getProductionSession,
  getProductionUser,
  isSignedOtpDevEnabled,
} from "./dev-auth";
import { getDevBankSheetReaderFromConfiguredSource } from "../lib/bankSheetScopedReader";

/**
 * Explicitly opt-in, READ ONLY release evidence endpoint for PR147.
 * Real signed OTP cookie only, revalidated against canonical DB on each call.
 * Never authorize with the legacy DEV email allowlist or user-supplied role.
 * No mutation, token issuance, session export, or application approval.
 */
const router = Router();

router.get("/pr147/verify-super-admin", async (req: Request, res: Response): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  if (
    process.env.APP_ENV !== "development"
    || process.env.PR147_SIGNED_VERIFY_ENABLED_DEV !== "true"
  ) {
    res.status(404).json({ code: "PR147_VERIFICATION_DISABLED" });
    return;
  }
  if (!isSignedOtpDevEnabled()) {
    res.status(503).json({ code: "PR147_SIGNED_OTP_UNAVAILABLE" });
    return;
  }
  const session = getProductionSession(req);
  if (!session) {
    res.status(401).json({ code: "PR147_SIGNED_SESSION_REQUIRED" });
    return;
  }

  let actor: Awaited<ReturnType<typeof getProductionUser>> = null;
  let actorLookupFailure = false;
  // Only retry the exact same signed-session database read once. Never
  // substitute email-only login, simulate a role, or bypass DB revalidation.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      actor = await getProductionUser(session);
      actorLookupFailure = false;
      break;
    } catch (error) {
      actorLookupFailure = true;
      if (attempt === 2) {
        const code = String((error as { code?: unknown })?.code ?? "");
        const safeCodes = new Set(["08001","08006","08P01","28P01","42501","42P01","53300","57P03","ETIMEDOUT","ECONNREFUSED","SELF_SIGNED_CERT_IN_CHAIN"]);
        req.log?.warn?.({
          event: "PR147_ACTOR_REVALIDATION_UNAVAILABLE",
          pgCode: safeCodes.has(code) ? code : "OTHER",
          attempts: attempt,
        }, "PR147 signed-owner actor lookup unavailable");
        break;
      }
      await new Promise<void>(resolve => setTimeout(resolve, 350));
    }
  }
  if (actorLookupFailure) {
    res.status(503).json({ code: "PR147_ACTOR_REVALIDATION_UNAVAILABLE" });
    return;
  }
  if (!actor || actor.role.trim().toLowerCase() !== "super_admin") {
    res.status(403).json({ code: "PR147_SUPER_ADMIN_REQUIRED" });
    return;
  }
  // A company-bound account may not escalate into an all-company release
  // verifier. Owner Super Admin must have explicit global scope (null).
  if (actor.companyId !== null) {
    res.status(403).json({ code: "PR147_GLOBAL_OWNER_SCOPE_REQUIRED" });
    return;
  }

  try {
    const companyResults: Array<{ companyId: number; status: "PASS"; configCount: number }> = [];
    for (const companyId of [1, 3]) {
      const reader = await getDevBankSheetReaderFromConfiguredSource(companyId);
      const principal = await reader.query<{
        actor: string; session_actor: string; sheet_rls: boolean;
        bank_rls: boolean; can_read: boolean; can_write: boolean;
      }>(`SELECT current_user AS actor, session_user AS session_actor,
          row_security_active('public.bank_sheet_configs'::regclass) AS sheet_rls,
          row_security_active('public.company_bank_accounts'::regclass) AS bank_rls,
          has_table_privilege(current_user,'public.bank_sheet_configs','SELECT') AS can_read,
          has_table_privilege(current_user,'public.bank_sheet_configs','INSERT,UPDATE,DELETE') AS can_write`);
      const status = principal.rows[0];
      const expected = companyId === 1 ? "bizportal_finance_cst_login_dev" : "bizportal_finance_diva_login_dev";
      if (!status || ![expected, expected + ".xssrfshdrtdfupgqwfdw"].includes(status.actor)
          || status.actor !== status.session_actor || !status.sheet_rls
          || !status.bank_rls || !status.can_read || status.can_write) {
        throw new Error("PR147_READER_SECURITY_GATE_FAILED");
      }
      const result = await reader.query<{ company_id: number }>(
        "SELECT company_id FROM public.bank_sheet_configs ORDER BY company_id",
      );
      if (result.rows.some(row => Number(row.company_id) !== companyId)
          || (companyId === 1 && result.rows.length !== 2)) {
        throw new Error("PR147_COMPANY_SCOPE_GATE_FAILED");
      }
      companyResults.push({ companyId, status: "PASS", configCount: result.rows.length });
    }

    const receiptId = randomUUID();
    // Audit evidence contains neither cookie/session data nor bank details.
    req.log?.info?.({
      event: "PR147_SIGNED_SUPER_ADMIN_READER_PASS",
      receiptId,
      companyCounts: companyResults.map(c => ({ companyId: c.companyId, configCount: c.configCount })),
      productionCutoverApproved: false,
    }, "PR147 signed owner verification evidence");
    res.status(200).json({
      receiptId,
      code: "PR147_SIGNED_SUPER_ADMIN_READER_PASS",
      evidenceLevel: "REAL_SIGNED_USER_AND_READ_ONLY_DATABASE",
      verifiedAt: new Date().toISOString(),
      checks: { signedSuperAdmin: "PASS", tenantRls: "PASS", writeDenied: "PASS" },
      companies: companyResults,
      historicalMutationsPreserved: "OWNER_APPROVED_NO_CHANGE_POLICY",
      productionCutoverApproved: false,
    });
  } catch {
    // Never return backend URLs, password-bearing driver errors, or bank data.
    req.log?.warn?.({
      event: "PR147_READONLY_E2E_NOT_VERIFIED",
      productionCutoverApproved: false,
    }, "PR147 signed owner verification blocked");
    res.status(503).json({ code: "PR147_READONLY_E2E_NOT_VERIFIED", productionCutoverApproved: false });
  }
});

/**
 * Self-contained DEV verification UI. Served only by the separate candidate
 * API so no release of the existing BizPortal frontend is required.
 * CSP nonce and same-origin fetch ensure session cookies remain in-browser.
 */
router.get("/pr147/verify-page", async (req: Request, res: Response): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  if (process.env.APP_ENV !== "development"
      || process.env.PR147_SIGNED_VERIFY_ENABLED_DEV !== "true") {
    res.status(404).send("Not found");
    return;
  }
  if (!isSignedOtpDevEnabled()) {
    res.status(503).send("Signed DEV OTP unavailable");
    return;
  }
  // Public presentation only: never disclose user/tenant data here.
  // Actual verification still requires the real signed OTP session and
  // independently revalidates the DB-backed Super Admin actor.
  const nonce = randomBytes(16).toString("base64");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  res.status(200).send(`<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Verifikasi BizPortal DEV — PR147</title>
<style>body{font-family:system-ui,sans-serif;background:#f6f7fb;color:#1b2433;max-width:650px;margin:5vh auto;padding:24px}
main{background:white;border:1px solid #dce1eb;border-radius:16px;padding:26px}
h1{font-size:24px}p{line-height:1.6}button{background:#2447b2;color:white;border:0;border-radius:8px;padding:13px 20px;font-weight:700;cursor:pointer}
button:disabled{opacity:.55}input{display:block;width:100%;box-sizing:border-box;margin:8px 0 14px;padding:11px;border:1px solid #b2bccb;border-radius:8px}label{font-weight:600;font-size:14px}section{margin-top:20px;padding:14px;background:#f2f5fb;border-radius:8px}section button{margin:6px 0 16px}pre{white-space:pre-wrap;word-break:break-word;background:#eef1f6;border-radius:8px;padding:15px}
small{color:#526176}</style></head><body><main>
<h1>Verifikasi Super Admin — PR #147</h1>
<p>Khusus BizPortal DEV. Akun Anda diverifikasi melalui sesi OTP resmi. Pemeriksaan hanya membaca konfigurasi CST dan Diva serta hak RLS, tanpa mengubah jurnal, mutasi, atau password.</p>
<button id="run" type="button">Jalankan verifikasi baca-saja</button>
<section id="otp" hidden>
<p>Sesi aplikasi di hostname ini belum tersedia. Login sekali menggunakan OTP email BizPortal DEV resmi. Jangan mengirim OTP melalui chat.</p>
<label for="email">Email Super Admin</label><input id="email" type="email" autocomplete="username" maxlength="320" required placeholder="Email terdaftar">
<button id="sendOtp" type="button">Kirim OTP email</button>
<label for="otpCode">Kode OTP</label><input id="otpCode" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="6 digit">
<button id="verifyOtp" type="button">Verifikasi OTP dan lanjutkan</button>
</section>
<p id="status" role="status" aria-live="polite"></p><pre id="result" hidden></pre>
<small>Hasil PASS pemeriksaan ini tidak otomatis mengizinkan deployment PROD.</small></main>
<script nonce="${nonce}">
const runButton=document.getElementById("run"),status=document.getElementById("status");
const otpSection=document.getElementById("otp"),result=document.getElementById("result");
const email=document.getElementById("email"),otpCode=document.getElementById("otpCode");
async function runVerification(){
 if(runButton.disabled)return;
 runButton.disabled=true;status.textContent="Memverifikasi…";result.hidden=true;
 try{
  const response=await fetch("/api/pr147/verify-super-admin",{credentials:"include",cache:"no-store"});
  const payload=await response.json();
  if(response.status===401){
   otpSection.hidden=false;status.textContent="Belum ada sesi OTP yang valid pada domain BizPortal DEV ini.";
  }else{
   status.textContent=response.ok?"PASS: sesi Super Admin asli dan Finance CST/Diva berhasil diverifikasi.":"BELUM PASS (HTTP "+response.status+"): pemeriksaan berhenti dengan aman.";
   result.textContent=JSON.stringify(payload,null,2);result.hidden=false;
   if(response.ok)otpSection.hidden=true;
  }
 }catch{status.textContent="API kandidat tidak dapat dihubungi; tidak ada data yang diubah."}
 finally{runButton.disabled=false}
}
runButton.addEventListener("click",runVerification);
document.getElementById("sendOtp").addEventListener("click",async()=>{
 const value=email.value.trim().toLowerCase();
 if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value)){status.textContent="Isi email Super Admin yang valid.";return;}
 const button=document.getElementById("sendOtp");button.disabled=true;
 try{
  const response=await fetch("/api/auth/email-otp/send",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:value})});
  status.textContent=response.ok?"Jika email Super Admin terdaftar, OTP akan dikirim melalui email.":"OTP belum dapat diminta (HTTP "+response.status+").";
 }catch{status.textContent="Layanan OTP belum terjangkau."}
 finally{button.disabled=false}
});
document.getElementById("verifyOtp").addEventListener("click",async()=>{
 const value=email.value.trim().toLowerCase(),code=otpCode.value.trim();
 if(!/^[0-9]{6}$/.test(code)){status.textContent="Masukkan kode OTP enam digit.";return;}
 const button=document.getElementById("verifyOtp");button.disabled=true;
 try{
  const response=await fetch("/api/auth/email-otp/verify",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:value,code})});
  otpCode.value="";
  if(!response.ok){status.textContent="OTP belum berhasil diverifikasi (HTTP "+response.status+").";return;}
  status.textContent="OTP valid. Menjalankan verifikasi CST dan Diva…";
  await runVerification();
 }catch{otpCode.value="";status.textContent="Verifikasi OTP tidak terjangkau."}
 finally{button.disabled=false}
});
</script></body></html>`);
});

export default router;
