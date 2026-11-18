import path from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const require=createRequire(path.join(ROOT,"artifacts/api-server/package.json"));
const {build}=require("esbuild");
const source=path.join(ROOT,"vendor/customer-portal/server/billing-operations.mjs");
const destination=path.join(ROOT,"artifacts/api-server/.qa-billing-handler-bundle.mjs");
await build({
 entryPoints:[source],outfile:destination,bundle:true,
 format:"esm",platform:"node",packages:"external",external:["pg"],logLevel:"warning",
 plugins:[{
  name:"disposable-qa-dependencies",
  setup(build){
   build.onResolve({filter:/^\.\/db\.mjs$/},args=>args.importer.endsWith("billing-operations.mjs")?{path:"db",namespace:"qa"}:null);
   build.onLoad({filter:/.*/,namespace:"qa"},()=>({contents:`
    import pg from "pg";
    const {Pool}=pg;
    export const pool=new Pool({
      connectionString:process.env.CUSTOMER_INVOICE_DISPOSABLE_DB_URL,
      ssl:false,max:2,connectionTimeoutMillis:3000
    });
    export const query=(sql,values=[])=>pool.query(sql,values);
    `,loader:"js"}));
   build.onResolve({filter:/^\.\/storage\.mjs$/},args=>args.importer.endsWith("billing-operations.mjs")?{path:"storage",namespace:"qa2"}:null);
   build.onLoad({filter:/.*/,namespace:"qa2"},()=>({contents:'export async function signedPaymentProofUrl(){return null;}',loader:"js"}));
   build.onResolve({filter:/^\.\/notification-service\.mjs$/},args=>args.importer.endsWith("billing-operations.mjs")?{path:"notifications",namespace:"qa3"}:null);
   build.onLoad({filter:/.*/,namespace:"qa3"},()=>({contents:`
    export async function bestEffortNotificationWrite(db,work){return true;}
    export async function notifyAdmins(){return true;}
    export async function notifyPortalCustomers(){return true;}
    `,loader:"js"}));
  },
 }]
});
console.log("ORIGINAL_BILLING_HANDLER_QA_BUNDLE_CREATED",destination);
