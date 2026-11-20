#!/usr/bin/env node
/**
 * PR147 ONE-SHOT LIVE DEV ATTESTATION. No secret or URL output.
 * Run ONLY as a transient, isolated systemd unit with LoadCredential
 * pointing to an already-authorized existing Secret Manager reader.
 * It never writes tables, changes roles, or rotates passwords.
 */
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const fail = (reason) => { console.log("PR147_LIVE_ATTESTATION=BLOCKED"); console.log("REASON=" + reason); process.exitCode = 2; };
const require = createRequire(new URL("../package.json", import.meta.url));
const { Client } = require("pg");

async function main() {
  if (process.env.APP_ENV !== "development") throw Error("NOT_DEV");
  const directory = process.env.CREDENTIALS_DIRECTORY;
  if (!directory?.startsWith("/run/credentials/")) throw Error("SYSTEMD_CREDENTIAL_DIR_REQUIRED");
  const raw = await fs.readFile(directory + "/gcp-secret-manager-bootstrap.json", "utf8");
  const identity = JSON.parse(raw);
  if (identity.project_id !== "secret-504012"
      || identity.client_email !== "bizportal-finance-dev-reader@secret-504012.iam.gserviceaccount.com"
      || !identity.private_key) throw Error("GCP_READER_IDENTITY_MISMATCH");
  console.log("GCP_READER_IDENTITY=PASS");
  const header = Buffer.from(JSON.stringify({alg:"RS256",typ:"JWT"})).toString("base64url");
  const now=Math.floor(Date.now()/1000);
  const tokenUrl="https://oauth2.googleapis.com/token";
  const claims=Buffer.from(JSON.stringify({iss:identity.client_email,scope:"https://www.googleapis.com/auth/cloud-platform",aud:tokenUrl,iat:now,exp:now+600})).toString("base64url");
  const signer=crypto.createSign("RSA-SHA256");
  signer.update(header+"."+claims);signer.end();
  const jwt=header+"."+claims+"."+signer.sign(identity.private_key,"base64url");
  const tokenResponse=await fetch(tokenUrl,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:jwt}),signal:AbortSignal.timeout(10000)});
  if (!tokenResponse.ok) throw Error("GCP_TOKEN_HTTP_"+tokenResponse.status);
  const token=(await tokenResponse.json()).access_token;
  if (!token) throw Error("GCP_TOKEN_MISSING");
  const url="https://secretmanager.googleapis.com/v1/projects/secret-504012/secrets/bizportal-marketplace-finance-dev-companies/versions/2:access";
  const response=await fetch(url,{headers:{Authorization:"Bearer "+token},signal:AbortSignal.timeout(10000)});
  if (!response.ok) throw Error("BUNDLE_READ_HTTP_"+response.status);
  const payload=await response.json();
  const data=payload?.payload?.data;
  if (typeof data!=="string") throw Error("BUNDLE_NO_PAYLOAD");
  const bundle=JSON.parse(Buffer.from(data,"base64").toString("utf8"));
  if (!bundle?.companies || typeof bundle.companies !== "object") throw Error("BUNDLE_SHAPE_MISMATCH");
  console.log("BUNDLE_VERSION_2_ACCESS=PASS");
  let all=true;
  for (const [company,role] of [["1","bizportal_finance_cst_login_dev"],["3","bizportal_finance_diva_login_dev"]]) {
    const entry=bundle?.companies?.[company];
    if (entry?.role!==role || typeof entry.databaseUrl!=="string") {
      console.log("COMPANY_"+company+"=BLOCKED_ROLE_OR_SOURCE");all=false;continue;
    }
    let u;
    try{u=new URL(entry.databaseUrl);}catch{console.log("COMPANY_"+company+"=BLOCKED_URL");all=false;continue;}
    if (u.protocol!=="postgresql:"
        || decodeURIComponent(u.username)!==role+".xssrfshdrtdfupgqwfdw"
        || u.hostname!=="aws-1-ap-southeast-2.pooler.supabase.com"
        || !["5432","6543"].includes(u.port)
        || u.pathname!=="/postgres"
        || !u.password
        || u.searchParams.get("sslmode")!=="verify-full"
        || [...u.searchParams.keys()].some(x=>x!=="sslmode")) {
      console.log("COMPANY_"+company+"=BLOCKED_URL_POLICY");
      console.log("COMPANY_"+company+"_POLICY_FLAGS="+[
        ["protocol",u.protocol==="postgresql:"],
        ["username",decodeURIComponent(u.username)===role+".xssrfshdrtdfupgqwfdw"],
        ["hostname",u.hostname==="aws-1-ap-southeast-2.pooler.supabase.com"],
        ["port",["5432","6543"].includes(u.port)],
        ["database",u.pathname==="/postgres"],
        ["password_present",Boolean(u.password)],
        ["verify_full",u.searchParams.get("sslmode")==="verify-full"],
        ["query_only_sslmode",![...u.searchParams.keys()].some(x=>x!=="sslmode")]
      ].map(([name,ok])=>name+":"+(ok?"PASS":"FAIL")).join(","));
      all=false;continue;
    }
    const client=new Client({host:u.hostname,port:Number(u.port),user:decodeURIComponent(u.username),password:decodeURIComponent(u.password),database:"postgres",ssl:{rejectUnauthorized:true,servername:u.hostname},connectionTimeoutMillis:8000,query_timeout:12000,application_name:"pr147-temporary-read-only-attestation"});
    try {
      await client.connect();
      const tls=client.connection?.stream;
      if (!tls?.encrypted || !tls?.authorized) throw Error("TLS_NOT_AUTHORIZED");
      await client.query("BEGIN READ ONLY");
      const probe=await client.query(`SELECT
        current_user AS who, session_user AS session_who,
        row_security_active('public.bank_sheet_configs'::regclass) AS sheet_rls,
        row_security_active('public.company_bank_accounts'::regclass) AS bank_rls,
        has_table_privilege(current_user,'public.bank_sheet_configs','SELECT') AS can_read,
        has_table_privilege(current_user,'public.bank_sheet_configs','INSERT,UPDATE,DELETE') AS can_write`);
      const q=probe.rows[0];
      if(q.who!==role+".xssrfshdrtdfupgqwfdw" && q.who!==role) throw Error("SESSION_PRINCIPAL_MISMATCH");
      if(q.session_who!==q.who || !q.sheet_rls || !q.bank_rls || !q.can_read || q.can_write) throw Error("RLS_OR_PRIVILEGE_FAILED");
      const rows=await client.query("SELECT DISTINCT company_id FROM public.bank_sheet_configs ORDER BY company_id");
      if (rows.rows.some(r=>String(r.company_id)!==company)) throw Error("CROSS_COMPANY_DATA_VISIBLE");
      if(company==="1" && rows.rows.length===0) throw Error("CST_CONFIGS_NOT_VISIBLE");
      console.log("COMPANY_"+company+"=PASS_AUTH_TLS_RLS_SELECT_ONLY");
    } catch(e) {
      console.log("COMPANY_"+company+"=BLOCKED_"+(e?.message?.startsWith("TLS_")||e?.message?.startsWith("RLS_")||e?.message?.startsWith("SESSION_")||e?.message?.startsWith("CROSS_")||e?.message?.startsWith("CST_")?e.message:"AUTH_OR_QUERY_FAILURE"));
      all=false;
    } finally {
      try {await client.query("ROLLBACK");}catch{}
      try {await client.end();}catch{}
    }
  }
  console.log("PASSWORD_ROTATION=false");
  console.log("SECRET_VALUES_LOGGED=false");
  console.log("HISTORICAL_WRITES=false");
  console.log("CUTOVER_APPROVED=false");
  console.log("PR147_LIVE_ATTESTATION="+(all?"PASS_DATABASE_ONLY":"BLOCKED"));
  if (!all) process.exitCode=2;
}
main().catch(e=>fail(["NOT_DEV","SYSTEMD_CREDENTIAL_DIR_REQUIRED","GCP_READER_IDENTITY_MISMATCH","GCP_TOKEN_MISSING","BUNDLE_NO_PAYLOAD","BUNDLE_SHAPE_MISMATCH"].includes(e?.message)||/^GCP_TOKEN_HTTP_\d{3}$/.test(e?.message)||/^BUNDLE_READ_HTTP_\d{3}$/.test(e?.message)?e.message:"ISOLATED_RUNTIME_FAILURE"));
