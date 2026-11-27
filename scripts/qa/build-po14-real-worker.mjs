import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(root, "artifacts/api-server/package.json"));
const { build } = require("esbuild");
const qa = path.join(root, "scripts/qa");
const shims = path.join(qa, "po14-worker-shims");
await mkdir(path.join(qa, "dist"), { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: [path.join(qa, "po14-real-worker.ts")],
  outfile: path.join(qa, "dist/po14-real-worker.mjs"),
  bundle: true, platform: "node", target: "node22", format: "esm",
  loader: { ".sql": "text" }, metafile: true, logLevel: "warning",
  nodePaths: [path.join(root, "artifacts/api-server/node_modules"), path.join(root, "lib/db/node_modules")],
  external: ["pg-native"],
  banner: { js: "import {createRequire as __createRequire} from 'node:module'; const require=__createRequire(import.meta.url);" },
  plugins: [{ name: "po14-local-only-boundaries", setup(build) {
    build.onResolve({ filter: /^@workspace\/db$/ }, () => ({ path: path.join(shims, "db.ts") }));
    build.onResolve({ filter: /^@workspace\/db\/schema$/ }, () => ({ path: path.join(root, "lib/db/src/schema/index.ts") }));
    for (const [pattern, file] of [
      [/(?:^|\/)activityLog(?:\.js)?$/, "activity.ts"],
      [/(?:^|\/)marketplaceNotificationQueueService(?:\.js)?$/, "notifications.ts"],
      [/(?:^|\/)google-sheets(?:\.js)?$/, "google-sheets.ts"],
      [/(?:^|\/)dev-auth(?:\.js)?$/, "auth.ts"],
    ]) build.onResolve({ filter: pattern }, () => ({ path: path.join(shims, file) }));
  } }],
});
const inputs = Object.keys(result.metafile.inputs);
const forbidden = inputs.filter(name => /lib\/db\/src\/(?:index|connection|gcp-database-secret|marketplace-finance-dev)\.ts$/.test(name)
  || /artifacts\/api-server\/src\/(?:routes\/dev-auth\.ts|lib\/(?:google-sheets|activityLog)\.ts|lib\/services\/marketplaceNotificationQueueService\.ts)$/.test(name));
if (forbidden.length) throw new Error("PO14 worker unexpectedly includes business/external modules: " + forbidden.join(", "));
await writeFile(path.join(qa, "dist/po14-real-worker.meta.json"), JSON.stringify({
  contract: "po14-real-sql-v1", forbiddenBusinessModules: forbidden,
  serviceInputs: inputs.filter(name => name.startsWith("artifacts/api-server/src/")),
}, null, 2));
console.log("PO14 real worker bundled with local DB and synthetic transport boundaries");
