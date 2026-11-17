"use strict";
// BUILD ONLY. Does not connect, execute cleanup, or change any runtime.
// Output is cleanup-only; it does not test company connectivity or Finance readiness.
// --check must pass before --recover-reviewed with the exact marker flag.
const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "artifacts/api-server/package.json"));
const source = readFileSync(path.join(__dirname, "dev-vendor-acceptance.ts"), "utf8");
if (createHash("sha256").update(source).digest("hex") !==
    "5deddf72490886951362b23893a071e19879389a3990a3f9b33e7d43de3d6c13") {
  throw new Error("RECOVERY_REVIEWED_HARNESS_SOURCE_CHANGED");
}
const mainStart = source.indexOf("async function main() {");
const finalizerStart = source.indexOf("main().catch(error => {");
if (mainStart < 0 || finalizerStart <= mainStart) throw new Error("RECOVERY_ENTRY_BOUNDARY_CHANGED");
const markerDeclaration = 'const marker = `QA-DEV-INVACCEPT-${Date.now()}-${randomBytes(4).toString("hex")}`;';
if (source.split(markerDeclaration).length !== 2) throw new Error("RECOVERY_MARKER_BOUNDARY_CHANGED");
// Physically exclude business preflight, seeding and vendor/API exercises.
// Preserve the reviewed configuration, PDF proof and cleanup implementations.
const boundaries = ["async function preflight() {", "function invoicePdf(reference: string): Buffer {",
  "async function vendorRequest(", "async function cleanup() {"];
if (boundaries.some(value => source.split(value).length !== 2)) throw new Error("RECOVERY_CLEANUP_ONLY_BOUNDARY_CHANGED");
const [preflightStart, pdfStart, vendorStart, cleanupStart] = boundaries.map(value => source.indexOf(value));
if (!(preflightStart < pdfStart && pdfStart < vendorStart && vendorStart < cleanupStart && cleanupStart < mainStart)) {
  throw new Error("RECOVERY_CLEANUP_ONLY_ORDER_CHANGED");
}
let prefix = (source.slice(0, preflightStart) + source.slice(pdfStart, vendorStart) +
  source.slice(cleanupStart, mainStart)).replace(markerDeclaration,
  'const marker = "QA-DEV-INVACCEPT-1794925669984-3279c776";');
// Strengthen only this recovery artifact: recheck and lock the exact reviewed
// graph inside each existing cleanup transaction, immediately before deletion.
const storageBoundary = "      // Delete only private paths read from this run's verified invoice rows.";
if (prefix.split(storageBoundary).length !== 2) throw new Error("RECOVERY_CLEANUP_BOUNDARY_CHANGED");
prefix = prefix.replace(storageBoundary, "      await verifyRecoveryGraph(f.companyId, true);\n" + storageBoundary);
const deletionStage = '        stage = `company_${f.companyId}_cleanup_delete_private_object`;';
if (prefix.split(deletionStage).length !== 2) throw new Error("RECOVERY_STORAGE_BOUNDARY_CHANGED");
prefix = prefix.replace(deletionStage,
  '        requireThat(path === recoveryFixtures.find(row => row.companyId === f.companyId)?.objectPath, "RECOVERY_EXACT_PRIVATE_OBJECT_PATH");\n' + deletionStage);
const recovery = readFileSync(path.join(__dirname, "recover-dev-vendor-3279c776.ts"), "utf8");
const cleanupPreflight = readFileSync(path.join(__dirname, "recovery-dev-admin-preflight-3279c776.ts"), "utf8");
load("esbuild").build({
  stdin: { contents: prefix + cleanupPreflight + recovery + "\n" + source.slice(finalizerStart),
    resolveDir: __dirname, sourcefile: "reviewed-dev-vendor-recovery-3279c776.ts", loader: "ts" },
  outfile: path.join(root, "artifacts/api-server/.dev-vendor-recovery-3279c776.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node22", packages: "bundle", logLevel: "warning",
  external: ["pg", "pg-native", "drizzle-orm", "drizzle-orm/*", "pino", "sharp", "ws", "@supabase/supabase-js"],
  plugins: [{ name: "canonical-workspace-db", setup(build) {
    build.onResolve({ filter: /^@workspace\/db$/ }, () => ({ path: path.join(root, "lib/db/src/index.ts") }));
  } }],
}).then(() => console.log("DEV_VENDOR_3279_REVIEWED_RECOVERY_BUILD_ONLY_PASS"))
  .catch(() => { console.error("DEV_VENDOR_3279_REVIEWED_RECOVERY_BUILD_FAILED"); process.exitCode = 1; });
