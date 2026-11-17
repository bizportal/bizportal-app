"use strict";
// BUILD ONLY. No connection, deletion, business request, or runtime change.
// Root reviews the artifact, then runs --check before --recover-reviewed with
// BIZPORTAL_VENDOR_ACCEPTANCE_RECOVER_DEV=QA-DEV-INVACCEPT-1794924789123-618ab115.
const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "artifacts/api-server/package.json"));
const source = readFileSync(path.join(__dirname, "dev-vendor-acceptance.ts"), "utf8");
if (createHash("sha256").update(source).digest("hex") !==
    "861cc437bc1eefb643076655cf35e19423b1dafc534c9ffc18e90a01380d5e80") {
  throw new Error("RECOVERY_REVIEWED_HARNESS_SOURCE_CHANGED");
}
const mainStart = source.indexOf("async function main() {");
const finalizerStart = source.indexOf("main().catch(error => {");
if (mainStart < 0 || finalizerStart <= mainStart) throw new Error("RECOVERY_ENTRY_BOUNDARY_CHANGED");
const markerDeclaration = 'const marker = `QA-DEV-INVACCEPT-${Date.now()}-${randomBytes(4).toString("hex")}`;';
if (source.split(markerDeclaration).length !== 2) throw new Error("RECOVERY_MARKER_BOUNDARY_CHANGED");
const prefix = source.slice(0, mainStart).replace(markerDeclaration,
  'const marker = "QA-DEV-INVACCEPT-1794924789123-618ab115";');
const recovery = readFileSync(path.join(__dirname, "recover-dev-vendor-618ab115.ts"), "utf8");
load("esbuild").build({
  stdin: { contents: prefix + recovery + "\n" + source.slice(finalizerStart),
    resolveDir: __dirname, sourcefile: "reviewed-dev-vendor-recovery-618ab115.ts", loader: "ts" },
  outfile: path.join(root, "artifacts/api-server/.dev-vendor-recovery-618ab115.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node22", packages: "bundle", logLevel: "warning",
  external: ["pg", "pg-native", "drizzle-orm", "drizzle-orm/*", "pino", "sharp", "ws", "@supabase/supabase-js"],
  plugins: [{ name: "canonical-workspace-db", setup(build) {
    build.onResolve({ filter: /^@workspace\/db$/ }, () => ({ path: path.join(root, "lib/db/src/index.ts") }));
  } }],
}).then(() => console.log("DEV_VENDOR_REVIEWED_RECOVERY_BUILD_ONLY_PASS"))
  .catch(() => { console.error("DEV_VENDOR_REVIEWED_RECOVERY_BUILD_FAILED"); process.exitCode = 1; });
