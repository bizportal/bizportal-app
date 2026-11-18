import {build} from "esbuild";
import {resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const source=resolve(root,"vendor/bizportal-otp/artifacts/api-server/src/routes/dev-customer-invoice-attestation.ts");
const out=resolve(root,"artifacts/api-server/.qa-invoice-issuer-bundle.mjs");
await build({
 entryPoints:[source],outfile:out,bundle:true,format:"esm",platform:"node",
 packages:"external",logLevel:"warning",
 plugins:[{
  name:"disposable-signed-otp-session-boundary",
  setup(build){
   build.onResolve({filter:/^\.\/dev-auth$/},args=>
    args.importer.endsWith("dev-customer-invoice-attestation.ts")
      ? {path:"otp-boundary",namespace:"qa-otp"} : null);
   build.onLoad({filter:/.*/,namespace:"qa-otp"},()=>({
    contents:`
      export function isSignedOtpDevEnabled(){return true;}
      export function getProductionSession(request){
        const cookie=request.headers.cookie ?? "";
        if(cookie==="qa_otp=valid" || cookie==="qa_otp=admin")
          return {id:"synthetic-owner",email:"qa-invoice@example.invalid",
                  expiresAt:Date.now()+60_000};
        return null;
      }
      export async function getProductionUser(session){
        return {id:session.id,email:session.email,
                role:process.env.QA_BIZPORTAL_ROLE_OVERRIDE==="admin"?"admin":"super_admin",
                companyId:null};
      }
    `,
    loader:"js",
   }));
  }
 }]
});
console.log("REAL_BIZPORTAL_OTP_ISSUER_QA_BUNDLE_PASS");
