"use strict";
/**
 * CST-DEV ONLY. One-shot hosted PostgreSQL LOGIN canary with guaranteed
 * NOLOGIN/password NULL restoration; consumes root-decrypted JSON on stdin.
 * Never logs secret, SCRAM verifier, DSN, or raw DB errors.
 * Execute from the existing Portal DEV container (has postgres admin DSN).
 * No financial table write, AR activation, or Portal feature change.
 */
const assert=require("node:assert/strict");
const fs=require("node:fs");
const crypto=require("node:crypto");
const {Client}=require("pg");
const PROJECT="xssrfshdrtdfupgqwfdw";
const POOLER="aws-1-ap-southeast-2.pooler.supabase.com";
const CA_SHA="700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7";
const ROLES=[
 {role:"bizportal_customer_invoice_cst_writer_dev",company:1,key:"CUSTOMER_PORTAL_CST_INVOICE_WRITER_DSN_DEV"},
 {role:"bizportal_customer_invoice_diva_writer_dev",company:3,key:"CUSTOMER_PORTAL_DIVA_INVOICE_WRITER_DSN_DEV"},
];
const flags=[
 "CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV",
 "CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV",
 "CUSTOMER_PORTAL_REQUIRE_BIZPORTAL_ATTEST_DEV",
 "CUSTOMER_PORTAL_TAX_ATOMIC_POST_DEV",
 "CUSTOMER_PORTAL_OUTBOX_SAFE_CONSUME_DEV",
];
function block(reason){throw Object.assign(Error("INVOICE_DEV_CANARY_"+reason),{code:"CANARY_STOP"});}
function verifier(secret) {
 const salt=crypto.randomBytes(16);
 const salted=crypto.pbkdf2Sync(secret,salt,4096,32,"sha256");
 const client=crypto.createHmac("sha256",salted).update("Client Key").digest();
 const stored=crypto.createHash("sha256").update(client).digest();
 const server=crypto.createHmac("sha256",salted).update("Server Key").digest();
 const result="SCRAM-SHA-256$4096:"+salt.toString("base64")+
  "$"+stored.toString("base64")+":"+server.toString("base64");
 salted.fill(0);client.fill(0);stored.fill(0);server.fill(0);
 return result;
}
function parseDirect(raw,rule){
 if(typeof raw!=="string" || raw.length>4096)block("BAD_WRITER_DSN");
 let u;try{u=new URL(raw)}catch{block("BAD_DSN_URL")}
 const params=[...u.searchParams.keys()];
 if(u.protocol!=="postgresql:" || u.hostname!==POOLER || u.port!=="5432" ||
    u.pathname!=="/postgres" || u.username!==rule.role+"."+PROJECT ||
    !u.password || u.password.length<64 ||
    params.length!==2 || new Set(params).size!==2 ||
    u.searchParams.get("sslmode")!=="verify-full" ||
    u.searchParams.get("sslrootcert")!=="/opt/cst-dev-finance-tls/supabase-root-2021.crt")
  block("WRONG_COMPANY_DSN_OR_TLS");
 u.search="";
 return {clean:u.toString(),password:u.password};
}
const required={
 APP_ENV:"development",SUPABASE_PROJECT_REF:PROJECT,
};
function loadPayload(raw){
 let o;try{o=JSON.parse(raw)}catch{block("INVALID_CREDENTIAL_PAYLOAD")}
 if(!o || typeof o!=="object" || Array.isArray(o) ||
    Object.keys(o).length!==4 ||
    Object.entries(required).some(([k,v])=>o[k]!==v))block("WRONG_CREDENTIAL_SCOPE");
 return ROLES.map(r=>({...r,...parseDirect(o[r.key],r)}));
}
async function connect(config,ca) {
 const client=new Client({
  connectionString:config,
  ssl:{ca,rejectUnauthorized:true,servername:POOLER},
  connectionTimeoutMillis:8000,query_timeout:10000,
  application_name:"cst_invoice_dev_canary_no_financial_writes",
 });
 await client.connect();return client;
}
async function main(){
 if(process.env.APP_ENV!=="development" || process.env.NODE_ENV!=="development" ||
   flags.some(k=>process.env[k]==="true"))block("ACTIVE_FINANCIAL_FLAGS");
 const adminRaw=process.env.SUPABASE_DATABASE_URL_DEV;
 if(!adminRaw)block("ADMIN_DSN_NOT_CONFIGURED");
 const au=new URL(adminRaw);
 if(au.hostname!==POOLER || au.port!=="5432" ||
    au.pathname!=="/postgres" || au.username!=="postgres."+PROJECT)
   block("WRONG_ADMIN_DATABASE_PROJECT");
 au.search="";
 const caBuffer=Buffer.from(process.env.CST_INVOICE_PUBLIC_CA_B64||"","base64");
 if(crypto.createHash("sha256").update(caBuffer).digest("hex")!==CA_SHA)
   block("UNVERIFIED_SUPABASE_CA");
 const ca=caBuffer.toString("utf8");
 caBuffer.fill(0);
 const credentials=loadPayload(fs.readFileSync(0,"utf8"));
 if(credentials[0].password===credentials[1].password)block("PASSWORD_REUSE");

 const admin=await connect(au.toString(),ca);
 let canaryStarted=false,lockHeld=false;
 try{
  const rootRole=await admin.query(`SELECT current_user::text AS effective,
    session_user::text AS login,
    (SELECT rolcreaterole FROM pg_roles WHERE rolname=current_user) AS createrole`);
  const me=rootRole.rows[0];
  if(me.effective!=="postgres" || me.login!=="postgres" || !me.createrole)
    block("ADMIN_NOT_EXPECTED_POSTGRES_ROLE");
  const locks=await admin.query("SELECT pg_try_advisory_lock(149,2026) AS granted");
  if(!locks.rows[0].granted)block("OTHER_CANARY_RUNNING");
  lockHeld=true;

  const p=await admin.query(`SELECT count(*) FILTER(WHERE policyname LIKE 'cst_invoice_b1_%')::int AS b1,
      count(*) FILTER(WHERE policyname LIKE 'cst_invoice_b2_%')::int AS b2,
      count(*) FILTER(WHERE policyname LIKE 'cst_invoice_b3_%')::int AS b3,
      count(*) FILTER(WHERE policyname LIKE 'cst_invoice_b4_%')::int AS b4
      FROM pg_policies WHERE schemaname='public'`);
  if(JSON.stringify(p.rows[0])!==JSON.stringify({b1:68,b2:16,b3:8,b4:40}))
    block("COMPANY_RLS_COUNT_UNEXPECTED");
  const actors=await admin.query(`SELECT role_name::text,company_id,enabled
    FROM public.bizportal_customer_ar_source_actors_dev
    WHERE role_name::text IN ($1,$2)`,[ROLES[0].role,ROLES[1].role]);
  if(actors.rowCount!==2 || actors.rows.some(r=>r.enabled))
    block("ORIGINAL_AR_ACTOR_NOT_DORMANT");
  const before=await admin.query(`SELECT rolname,rolcanlogin,rolbypassrls,rolinherit,rolsuper,rolconnlimit
      FROM pg_roles WHERE rolname IN ($1,$2)`,[ROLES[0].role,ROLES[1].role]);
  if(before.rowCount!==2 || before.rows.some(r=>r.rolcanlogin || r.rolbypassrls ||
      r.rolinherit || r.rolsuper || r.rolconnlimit!==-1))
    block("NON_DORMANT_OR_PRIVILEGED_WRITER_PRECHECK");
  console.log("HOSTED_CST_DEV_B1_B4_AND_DORMANT_ROLE_PREFLIGHT_PASS");

  const expiry=new Date(Date.now()+7*60*1000).toISOString();
  canaryStarted=true;
  await admin.query("BEGIN");
  try{
    for(const c of credentials){
      const scram=verifier(c.password); // salted hash, never plaintext SQL
      if(!/^SCRAM-SHA-256\$4096:/.test(scram))block("SCRAM_HASH_INVALID");
      await admin.query(`ALTER ROLE ${c.role} WITH LOGIN PASSWORD '${scram}'
        VALID UNTIL '${expiry}' CONNECTION LIMIT 1`);
    }
    await admin.query("COMMIT");
  }catch(e){await admin.query("ROLLBACK").catch(()=>{});throw e}
  console.log("TEMPORARY_HOSTED_SCRAM_WRITER_AUTH_INSTALLED_NO_AR_OR_FINANCIAL_POST");
  for(const c of credentials){
    const conn=await connect(c.clean,ca);
    try{
      const state=await conn.query(`SELECT current_user::text AS effective,
        session_user::text AS login,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass,
        row_security_active('public.sales_documents'::regclass) AS sales_rls,
        row_security_active('public.accounting_entries'::regclass) AS gl_rls,
        row_security_active('public.ar_subledger'::regclass) AS ar_rls`);
      const r=state.rows[0];
      if(r.effective!==c.role || r.login!==c.role || r.bypass ||
        !r.sales_rls || !r.gl_rls || !r.ar_rls)
        block("SESSION_IDENTITY_OR_RLS_FAILED");
      const foreign=c.company===1?3:1;
      const invisible=await conn.query(`SELECT
        (SELECT count(*)::int FROM public.sales_documents WHERE company_id=$1) AS foreign_sales,
        (SELECT count(*)::int FROM public.accounting_entries WHERE company_id=$1) AS foreign_journals,
        (SELECT count(*)::int FROM public.ar_subledger WHERE company_id=$1) AS foreign_ar`,
        [foreign]);
      const scopes=invisible.rows[0];
      if(scopes.foreign_sales!==0 || scopes.foreign_journals!==0 || scopes.foreign_ar!==0)
        block("CROSS_COMPANY_VISIBILITY");
      const privileges=await conn.query(`SELECT
        has_column_privilege(current_user,'public.users','password_hash','SELECT') AS password_read,
        has_column_privilege(current_user,'public.sales_documents','grand_total','UPDATE') AS source_total_update,
        has_column_privilege(current_user,'public.users','role','UPDATE') AS admin_role_update`);
      if(Object.values(privileges.rows[0]).some(Boolean))
        block("PRIVILEGED_COLUMN_ACCESS");
      console.log("HOSTED_DEV_DIRECT_WRITER_TLS_RLS_NO_CROSS_COMPANY_PASS",c.company);
    }finally{await conn.end().catch(()=>{})}
  }
  console.log("HOSTED_CST_AND_DIVA_DIRECT_LOGIN_READONLY_CANARY_PASS");
 }finally{
  // Restore BOTH roles even when any assertion or connection fails.
  // If the admin connection has broken, the caller must immediately invoke
  // the independent Supabase NOLOGIN/password-NULL emergency rollback.
  if(canaryStarted){
    try{
      await admin.query("BEGIN");
      for(const c of ROLES) {
        await admin.query(`ALTER ROLE ${c.role} WITH NOLOGIN PASSWORD NULL
          CONNECTION LIMIT -1`);
      }
      await admin.query("COMMIT");
      const final=await admin.query(`SELECT rolname,rolcanlogin,rolconnlimit
        FROM pg_roles WHERE rolname IN ($1,$2)`,[ROLES[0].role,ROLES[1].role]);
      if(final.rowCount!==2 || final.rows.some(r=>r.rolcanlogin||r.rolconnlimit!==-1))
        block("RELOCK_READBACK_FAILED");
      console.log("HOSTED_DEV_BOTH_WRITERS_NOLOGIN_PASSWORD_NULL_RELOCK_PASS");
    }catch{
      try{await admin.query("ROLLBACK")}catch{}
      console.error("CRITICAL_STOP_CST_DEV_WRITER_RELOCK_REQUIRES_INDEPENDENT_SUPABASE_READBACK");
      process.exitCode=2;
    }
  }
  if(lockHeld){try{await admin.query("SELECT pg_advisory_unlock(149,2026)")}catch{}}
  try{await admin.end()}catch{}
 }
}
main().catch(e=>{
 console.error("CST_DEV_WRITER_CANARY_STOPPED",e?.code||"SAFE_PRECHECK_OR_TEST_FAILURE");
 process.exitCode ||= 1;
});
