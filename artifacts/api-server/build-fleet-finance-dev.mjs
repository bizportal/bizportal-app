import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const cwd = fileURLToPath(new URL("../../", import.meta.url));
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim().length > 0;

await build({
  entryPoints: [fileURLToPath(new URL("./src/fleet-finance-dev-server.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("./dist/fleet-finance-dev.cjs", import.meta.url)),
  platform: "node", target: "node22", format: "cjs", bundle: true,
  define: {
    "process.env.FLEET_FINANCE_BUILD_SHA": JSON.stringify(sha),
    "process.env.FLEET_FINANCE_BUILD_DIRTY": JSON.stringify(String(dirty)),
  },
  external: ["pg-native"], logLevel: "info",
});
