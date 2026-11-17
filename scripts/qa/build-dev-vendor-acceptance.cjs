"use strict";
// Build only. This command never connects to DEV or executes the acceptance run.
const { createRequire } = require("node:module");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "artifacts/api-server/package.json"));
load("esbuild").build({
  entryPoints: [path.join(__dirname, "dev-vendor-acceptance.ts")],
  outfile: path.join(root, "artifacts/api-server/.dev-vendor-acceptance.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node22",
  packages: "bundle", logLevel: "warning",
  external: ["pg", "pg-native", "drizzle-orm", "drizzle-orm/*", "pino", "sharp", "ws", "@supabase/supabase-js"],
  plugins: [{ name: "canonical-workspace-db", setup(build) {
    build.onResolve({ filter: /^@workspace\/db$/ }, () => ({
      path: path.join(root, "lib/db/src/index.ts"),
    }));
  } }],
}).then(() => console.log("DEV_VENDOR_ACCEPTANCE_BUILD_PASS"))
  .catch(() => { console.error("DEV_VENDOR_ACCEPTANCE_BUILD_FAILED"); process.exitCode = 1; });
