"use strict";
const { createRequire } = require("node:module");
const path = require("node:path");
const root = path.resolve(__dirname,"../..");
const load = createRequire(path.join(root,"artifacts/api-server/package.json"));
const {build} = load("esbuild");
const service = path.join(root,"artifacts/api-server/src/lib/services/mktVendorInvoiceService.ts");
const test = path.join(root,"scripts/tests");
const stubs = {
 "@workspace/db":path.join(test,"pr81-vendor-lock-db-stub.ts"),
 "../activityLog.js":path.join(test,"pr81-real-writer-activity-stub.ts"),
 "./marketplaceNotificationQueueService.js":path.join(test,"pr81-real-writer-notify-stub.ts"),
};
const relevant = new Set([service]);
const p = {
 name:"isolated-writer-only-injection",
 setup(builder) {
   builder.onResolve({filter:/^@workspace\/db$/},(args)=>({
     path:stubs["@workspace/db"]
   }));
   for(const key of ["../activityLog.js","./marketplaceNotificationQueueService.js"]){
     builder.onResolve({filter:new RegExp("^"+key.replaceAll(".","\\.").replaceAll("/","\\/")+"$")},(args)=>
       relevant.has(args.importer) ? {path:stubs[key]} : null);
   }
 }
};
build({
 entryPoints:[path.join(test,"pr81-vendor-lock-e2e.ts")],
 bundle:true,platform:"node",format:"esm",target:"node22",
 packages:"external",
 outfile:path.join(root,"artifacts/api-server/.pr81-vendor-lock-proof.mjs"),
 plugins:[p],
 logLevel:"warning",
}).then(()=>console.log("CANONICAL_VENDOR_LOCK_TEST_BUNDLE_READY"))
 .catch(e=>{console.error(String(e.message));process.exit(1)});
