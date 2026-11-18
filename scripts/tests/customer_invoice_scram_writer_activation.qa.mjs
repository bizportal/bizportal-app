/**
 * Disposable PostgreSQL16/17 ONLY: test confidential credential activation.
 * Never run against hosted CST-DEV or PROD.
 * Roles are already created NOLOGIN with B1-B4 source/company RLS.
 * Passwords remain in-process; only a salted SCRAM verifier reaches SQL.
 */
import assert from "node:assert/strict";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import pg from "pg";

const { Client } = pg;
const ROLES = Object.freeze([
  { role: "bizportal_customer_invoice_cst_writer_dev", company: 1 },
  { role: "bizportal_customer_invoice_diva_writer_dev", company: 3 },
]);
function scramVerifier(password, salt=randomBytes(16)) {
  assert.equal(typeof password, "string");
  assert(password.length >= 48);
  const salted=pbkdf2Sync(password,salt,4096,32,"sha256");
  const clientKey=createHmac("sha256",salted).update("Client Key").digest();
  const storedKey=createHash("sha256").update(clientKey).digest();
  const serverKey=createHmac("sha256",salted).update("Server Key").digest();
  const result="SCRAM-SHA-256$4096:"+salt.toString("base64")
    +"$"+storedKey.toString("base64")+":"+serverKey.toString("base64");
  salted.fill(0);clientKey.fill(0);storedKey.fill(0);serverKey.fill(0);
  return result;
}
function assertDisposableEnvironment(url) {
  assert.equal(process.env.APP_ENV,"development");
  assert.equal(process.env.NODE_ENV,"development");
  const u=new URL(url);
  assert(["postgresql:","postgres:"].includes(u.protocol));
  assert.equal(u.hostname,"127.0.0.1");
  assert.equal(u.pathname,"/invoice_synthetic");
  assert(u.port && Number(u.port)>1024,"ephemeral localhost container port only");
  assert.equal(u.username,"postgres");
}
async function getClient(options) {
  const c=new Client({...options,connectionTimeoutMillis:3000,
    application_name:"invoice_disposable_scram_qa"});
  await c.connect();
  return c;
}
function roleConfig(adminUrl,role,password) {
  const u=new URL(adminUrl);
  u.username=role;u.password=password;
  return {connectionString:u.toString()};
}
const databaseUrl=process.env.CUSTOMER_INVOICE_DISPOSABLE_DB_URL;
assert(typeof databaseUrl==="string" && databaseUrl.length>20,
  "QA-only localhost PostgreSQL URL required");
assertDisposableEnvironment(databaseUrl);
const admin=await getClient({connectionString:databaseUrl});
const generated=[];
let activated=false;
try {
  const state=await admin.query(`SELECT rolname,rolcanlogin,rolbypassrls,
    rolinherit,rolsuper FROM pg_roles WHERE rolname IN ($1,$2)
    ORDER BY rolname`,[ROLES[0].role,ROLES[1].role]);
  assert.equal(state.rowCount,2,"both dormant Invoice roles required");
  for(const role of state.rows) {
    assert.equal(role.rolcanlogin,false,"writers must start NOLOGIN");
    assert.equal(role.rolbypassrls,false);
    assert.equal(role.rolinherit,false);
    assert.equal(role.rolsuper,false);
  }
  const policies=await admin.query(`SELECT
    COUNT(*) FILTER (WHERE policyname LIKE 'cst_invoice_b1_%')::int AS b1,
    COUNT(*) FILTER (WHERE policyname LIKE 'cst_invoice_b2_%')::int AS b2,
    COUNT(*) FILTER (WHERE policyname LIKE 'cst_invoice_b3_%')::int AS b3,
    COUNT(*) FILTER (WHERE policyname LIKE 'cst_invoice_b4_%')::int AS b4
    FROM pg_policies WHERE schemaname='public'`);
  const counts=policies.rows[0];
  assert.deepEqual(counts,{b1:68,b2:16,b3:8,b4:40});
  const baseline=await admin.query(`SELECT role_name::text,company_id
    FROM public.bizportal_customer_ar_source_actors_dev
    WHERE role_name::text IN ($1,$2) ORDER BY company_id`,
    [ROLES[0].role,ROLES[1].role]);
  assert.equal(baseline.rowCount,2);
  assert.deepEqual(baseline.rows.map(r=>Number(r.company_id)),[1,3]);
  console.log("DORMANT_WRITER_AND_B1_B4_RLS_PREFLIGHT_PASS");

  // No password value or SCRAM verifier is ever written to stdout,
  // GitHub Actions logs, shell argv, or a persistent filesystem.
  for(const {role,company}of ROLES) {
    const password=randomBytes(48).toString("base64url"); // 384 bits
    const verifier=scramVerifier(password);
    assert(verifier.startsWith("SCRAM-SHA-256$4096:"));
    assert(!verifier.includes(password));
    generated.push({role,company,password,verifier});
  }
  assert.notEqual(generated[0].password,generated[1].password);
  const validUntil=new Date(Date.now()+10*60*1000).toISOString();
  await admin.query("BEGIN");
  try {
    for(const {role,verifier} of generated) {
      assert(ROLES.some(v=>v.role===role));
      // PostgreSQL ALTER ROLE does not accept prepared-statement params.
      // SQL contains a salted verifier, never plaintext. Only fixed roles.
      await admin.query(`ALTER ROLE ${role} LOGIN PASSWORD '${verifier}'
        VALID UNTIL '${validUntil}'`);
    }
    await admin.query("COMMIT");
    activated=true;
  }catch(e) {
    await admin.query("ROLLBACK").catch(()=>{});
    throw e;
  }
  console.log("SYNTHETIC_DISPOSABLE_WRITER_SCRAM_VERIFIERS_INSTALLED_PASS");
  for(const {role,company,password} of generated) {
    const c=await getClient(roleConfig(databaseUrl,role,password));
    try {
      const identity=await c.query(`SELECT current_user::text AS effective,
        session_user::text AS login,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass,
        row_security_active('public.sales_documents'::regclass) AS sales_rls,
        row_security_active('public.accounting_entries'::regclass) AS gl_rls,
        row_security_active('public.ar_subledger'::regclass) AS ar_rls`);
      const x=identity.rows[0];
      assert.equal(x.effective,role);assert.equal(x.login,role);
      assert.equal(x.bypass,false);
      assert.equal(x.sales_rls,true);assert.equal(x.gl_rls,true);
      assert.equal(x.ar_rls,true);
      const sales=await c.query("SELECT id,company_id FROM public.sales_documents");
      assert(sales.rowCount>=1,"at least one synthetic source Invoice must exist");
      assert(sales.rows.every(x=>Number(x.company_id)===company),
        "no cross-company invoice visibility");
      const foreign=await c.query(
        "SELECT count(*)::int AS total FROM public.accounting_entries WHERE company_id<>$1",
        [company]);
      assert.equal(foreign.rows[0].total,0);
      const denied=await c.query(
        "SELECT has_column_privilege(current_user,'public.users','password_hash','SELECT') AS private_password_read, has_column_privilege(current_user,'public.sales_documents','grand_total','UPDATE') AS source_amount_update");
      assert.equal(denied.rows[0].private_password_read,false);
      assert.equal(denied.rows[0].source_amount_update,false);
      console.log("SCRAM_DIRECT_COMPANY_LOGIN_CURRENT_USER_SESSION_USER_RLS_PASS",
        company);
    }finally{await c.end()}
    // Failed authentication must reject an incorrect password.
    await assert.rejects(
      getClient(roleConfig(databaseUrl,role,password+"WRONG")),()=>true);
    console.log("WRONG_PASSWORD_DENIED_PASS",company);
  }
  console.log("BOTH_INDEPENDENT_384_BIT_SCRAM_LOGIN_QA_PASS");
} finally {
  // CLEANUP FIRST, even if a later RLS assertion fails. This applies
  // only to a local ephemeral PG16 database explicitly preflighted above.
  if(activated) {
    await admin.query("BEGIN");
    try {
      for(const {role}of ROLES)
        await admin.query(`ALTER ROLE ${role} NOLOGIN PASSWORD NULL`);
      await admin.query("COMMIT");
      console.log("DISPOSABLE_WRITER_ROLES_RELOCKED_AND_PASSWORDS_CLEARED_PASS");
    }catch(e) {
      await admin.query("ROLLBACK").catch(()=>{});
      throw e;
    }
    const final=await admin.query(
      "SELECT rolname,rolcanlogin FROM pg_roles WHERE rolname IN ($1,$2)",
      [ROLES[0].role,ROLES[1].role]);
    assert.equal(final.rowCount,2);
    assert(final.rows.every(r=>r.rolcanlogin===false));
    for(const {role,password} of generated)
      await assert.rejects(
        getClient(roleConfig(databaseUrl,role,password)),()=>true);
    console.log("POST_RELOCK_AUTHENTICATION_DENIED_PASS");
  }
  // Do not display secret strings or SCRAM verifier, including on failure.
  generated.splice(0);
  await admin.end();
}
