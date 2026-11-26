/** DEV-only Owner consent UI for Issue #238. No QA dispatch and no secrets exposed. */
import {randomBytes} from "node:crypto";
import {Router} from "express";
import {getProductionSession,getProductionUser,isSignedOtpDevEnabled} from "./dev-auth";
import {isIssue238OwnerOtpDevEnabled} from "./dev-issue238-qa-owner-otp";

const router=Router();
const TESTS=[
 "issue238-pg17-lock-expiry-concurrency-qa.sh",
 "issue238-pgcron164-nonsuperuser-crash-qa.sh",
 "issue238-pgcron164-scheduler-crash-qa.sh",
] as const;
router.get("/auth/dev/issue238-qa/consent",async(req,res)=>{
 res.setHeader("Cache-Control","no-store");
 res.setHeader("X-Content-Type-Options","nosniff");
 res.setHeader("X-Frame-Options","DENY");
 if (!isIssue238OwnerOtpDevEnabled() || !isSignedOtpDevEnabled())
   return res.status(404).json({error:"Not found"});
 try {
  const session=getProductionSession(req);
  if(!session || Date.now()-session.issuedAt>600000 || session.issuedAt>Date.now())
    return res.status(401).json({error:"Fresh Owner OTP session required"});
  const actor=await getProductionUser(session);
  if(!actor || actor.id!==session.id || actor.email!==session.email ||
     actor.role!=="super_admin" || (actor.companyId!==null && actor.companyId!==1))
    return res.status(401).json({error:"Owner session required"});
  const nonce=randomBytes(18).toString("base64");
  res.setHeader("Content-Security-Policy",
    "default-src 'none'; script-src 'nonce-"+nonce+"'; style-src 'nonce-"+nonce+
    "'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  const base="/api/auth/dev/issue238-qa";
  const options=TESTS.map((t,i)=>'<option value="'+i+'">'+t+'</option>').join("");
  const script=`(()=>{
    const tests=${JSON.stringify(TESTS)};
    const button=document.getElementById("approve");
    const status=document.getElementById("status");
    const select=document.getElementById("test");
    const commandId=document.getElementById("commandId");
    const jobId=document.getElementById("jobId");
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    button.addEventListener("click",async()=>{
      button.disabled=true;status.textContent="Memeriksa sesi Owner...";
      try{
        const chosen=tests[Number(select.value)];
        if(!chosen) throw Error("Invalid test");
        const command=commandId.value.trim();
        const job=jobId.value.trim();
        if(!uuid.test(command)||!uuid.test(job)) throw Error("ID command dan job dari AI Core harus berupa UUID yang sah");
        if(!window.confirm("Setujui QA #238 DEV untuk command "+command+" dan job "+job+"? Tidak menjalankan pengujian.")) return;
        const challenge=await fetch("${base}/challenge?test="+encodeURIComponent(chosen)
          +"&commandId="+encodeURIComponent(command)+"&jobId="+encodeURIComponent(job),
          {credentials:"same-origin",cache:"no-store"});
        if(!challenge.ok) throw Error("OTP Owner tidak sah atau kedaluwarsa");
        const input=await challenge.json();
        const approval=await fetch("${base}/approve",{
          method:"POST",credentials:"same-origin",
          headers:{"content-type":"application/json"},
          body:JSON.stringify({...input,approvalText:"SETUJUI QA #238 DEV"})
        });
        if(!approval.ok) throw Error("Persetujuan ditolak");
        const receipt=await approval.json();
        if(receipt.purpose!=="issue238-pg17-disposable-qa"||!receipt.request)
          throw Error("Bukti tidak valid");
        status.textContent="Bukti persetujuan Owner telah dibuat. Belum terkirim ke runner; PostgreSQL belum dijalankan.";
      }catch(e){status.textContent=e instanceof Error?e.message:"Persetujuan gagal";}
      finally{button.disabled=false;}
    });
  })();`;
  return res.status(200).type("html").send(`<!doctype html><html lang="id"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Persetujuan Owner QA #238</title>
    <style nonce="${nonce}">body{max-width:630px;margin:38px auto;padding:0 20px;font:16px/1.5 system-ui;color:#26354a}select,input,button{display:block;margin:12px 0;padding:12px;width:100%;box-sizing:border-box;font:inherit}button{background:#174b88;color:white;border:0;border-radius:5px;cursor:pointer}button:disabled{opacity:.5}small{color:#566}</style>
    </head><body><h1>Persetujuan Owner — QA #238</h1>
    <p>Hanya CST-DEV, tiga pengujian PostgreSQL sementara. Tidak mengubah PROD atau Invoice #108.</p>
    <label for="test">Pilih pengujian</label><select id="test">${options}</select>
    <p>Masukkan identitas job dari <strong>klaim AI Core yang telah diautentikasi</strong>; bukan ID buatan sendiri. Bukti ini saja tidak menjalankan QA.</p>
    <label for="commandId">Command ID AI Core (UUID)</label>
    <input id="commandId" type="text" autocomplete="off" spellcheck="false" placeholder="UUID command yang diverifikasi" required>
    <label for="jobId">Job/Task ID AI Core (UUID)</label>
    <input id="jobId" type="text" autocomplete="off" spellcheck="false" placeholder="UUID task yang diverifikasi" required>
    <button id="approve" type="button">Setujui QA #238 DEV</button>
    <p id="status" role="status" aria-live="polite">Belum ada persetujuan.</p>
    <small>Halaman ini hanya membuat bukti bertanda tangan, belum mengirim ke pelaksana. Pengujian PostgreSQL tidak akan berjalan dari tombol ini.</small>
    <script nonce="${nonce}">${script}</script></body></html>`);
 }catch{return res.status(503).json({error:"Owner consent unavailable"});}
});
export default router;
