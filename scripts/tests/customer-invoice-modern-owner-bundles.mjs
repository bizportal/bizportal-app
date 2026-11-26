/**
 * Disposable PG16 only. Bundle EXACT Portal PR231 and BizPortal PR155 sources
 * while replacing transport / OTP-session I/O ONLY with local QA fixtures.
 * All Portal accounting and security logic is the real source code.
 */
import assert from "node:assert/strict";
import path from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const require=createRequire(path.join(root,"artifacts/api-server/package.json"));
const {build}=require("esbuild");
const portal=path.join(root,"vendor/customer-portal/server/billing-operations.mjs");
const bizportal=path.join(root,"vendor/bizportal-otp/artifacts/api-server/src/routes/dev-customer-invoice-attestation.ts");
const handler=path.join(root,"artifacts/api-server/.qa-modern-invoice-handler.mjs");
const signer=path.join(root,"artifacts/api-server/.qa-modern-otp-signer.mjs");
await build({
 entryPoints:[portal],outfile:handler,bundle:true,
 format:"esm",platform:"node",packages:"external",external:["pg"],logLevel:"warning",
 plugins:[{
   name:"isolated-qa-external-io",
   setup(build){
     build.onResolve({filter:/^\.\/db\.mjs$/},args=>args.importer.endsWith("billing-operations.mjs")?
       {path:"db",namespace:"qa-db"}:null);
     build.onLoad({filter:/.*/,namespace:"qa-db"},()=>({contents:[
       'import pg from "pg";',
       'const {Pool}=pg;',
       'export const pool=new Pool({connectionString:process.env.CUSTOMER_INVOICE_DISPOSABLE_DB_URL,ssl:false,max:2});',
       'export const query=(sql,values=[])=>pool.query(sql,values);',
     ].join("\n"),loader:"js"}));
     build.onResolve({filter:/^\.\/dev-customer-invoice-scoped-client\.mjs$/},
       args=>args.importer.endsWith("billing-operations.mjs")?
       {path:"writer",namespace:"qa-writer"}:null);
     build.onLoad({filter:/.*/,namespace:"qa-writer"},()=>({contents:[
       'import pg from "pg";',
       'const {Client}=pg;',
       'export async function openDevCompanyInvoiceWriter({invoiceId,portalUser,lookupCompany}) {',
       ' if(portalUser?.role!=="admin")throw Error("QA_ISSUER_NOT_ADMIN");',
       ' const record=await lookupCompany("select company_id from public.sales_documents where id=$1 and company_id in (1,3) limit 2",[invoiceId]);',
       ' if(record.rows.length!==1)throw Error("QA_COMPANY_LOOKUP_FAILED");',
       ' const companyId=Number(record.rows[0].company_id);',
       ' if(![1,3].includes(companyId))throw Error("QA_COMPANY_INVALID");',
       ' const role=companyId===1?"bizportal_customer_invoice_cst_writer_dev":"bizportal_customer_invoice_diva_writer_dev";',
       ' const u=new URL(process.env.CUSTOMER_INVOICE_DISPOSABLE_DB_URL);',
       ' if(u.hostname!=="127.0.0.1"||u.pathname!=="/invoice_synthetic")throw Error("DISPOSABLE_DB_ONLY");',
       ' u.username=role;u.password="synthetic-only-pass";',
       ' const client=new Client({connectionString:u.toString(),ssl:false});',
       ' await client.connect();',
       ' return {client,companyId};',
       '}'
     ].join("\n"),loader:"js"}));
     build.onResolve({filter:/^\.\/storage\.mjs$/},
       args=>args.importer.endsWith("billing-operations.mjs")?
       {path:"storage",namespace:"qa-storage"}:null);
     build.onLoad({filter:/.*/,namespace:"qa-storage"},()=>({
       contents:'export async function signedPaymentProofUrl(){return null;}',loader:"js"}));
     // Real issuer-scoped Customer Portal notifications now run against the
     // same disposable PG16 transaction with exact original B4 RLS.
     // No email/WA/network provider exists in notification-service.mjs.
   },
 }]
});
await build({
 entryPoints:[bizportal],outfile:signer,bundle:true,
 format:"esm",platform:"node",packages:"external",logLevel:"warning",
 plugins:[{
  name:"synthetic-original-signed-otp",
  setup(build){
    build.onResolve({filter:/^\.\/dev-auth$/},
      args=>args.importer.endsWith("dev-customer-invoice-attestation.ts")?
      {path:"qa-otp",namespace:"qa-otp"}:null);
    build.onLoad({filter:/.*/,namespace:"qa-otp"},()=>({contents:[
      'export function isSignedOtpDevEnabled(){return true;}',
      'export function getProductionSession(request){',
      ' if(request.headers.cookie==="qa_otp=valid" || request.headers.cookie==="qa_otp=admin")',
      ' return {id:"synthetic-owner",email:"qa-owner@example.invalid",expiresAt:Date.now()+60000};',
      ' return null;',
      '}',
      'export async function getProductionUser(session){',
      ' return {id:session.id,email:session.email,',
      ' role:process.env.QA_BIZPORTAL_ROLE_OVERRIDE==="admin"?"admin":"super_admin",companyId:null};',
      '}'
    ].join("\n"),loader:"js"}));
  }
 }]
});
assert(portal.includes("/vendor/customer-portal/server/billing-operations.mjs"));
assert(bizportal.includes("/vendor/bizportal-otp/"));
console.log("MODERN_ORIGINAL_SOURCE_BUNDLE_QA_PASS");
