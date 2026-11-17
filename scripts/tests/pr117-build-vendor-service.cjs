"use strict";
const { createRequire } = require("node:module");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "artifacts/api-server/package.json"));
const { build } = load("esbuild");
const test = path.join(root, "scripts/tests");
const services = new Set([
  path.join(root, "artifacts/api-server/src/lib/services/mktVendorInvoiceService.ts"),
  path.join(root, "artifacts/api-server/src/lib/services/mktApPreparationService.ts"),
]);
const stubs = {
  db: path.join(test, "pr117-vendor-db-stub.ts"),
  activity: path.join(test, "pr81-real-writer-activity-stub.ts"),
  notification: path.join(test, "pr81-real-writer-notify-stub.ts"),
};
build({
  entryPoints: [path.join(test, "pr117-real-vendor-finance-service-e2e.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "bundle",
  external: ["pg", "pg-native", "drizzle-orm", "drizzle-orm/*"],
  outfile: path.join(root, "artifacts/api-server/.pr117-real-vendor-finance-service.mjs"),
  logLevel: "warning",
  plugins: [{
    name: "pr117-disposable-only-services",
    setup(builder) {
      builder.onResolve({ filter: /^@workspace\/db$/ }, () => ({ path: stubs.db }));
      builder.onResolve({ filter: /^\.\.\/activityLog\.js$/ }, (args) =>
        services.has(args.importer) ? { path: stubs.activity } : null);
      builder.onResolve({ filter: /^\.\/marketplaceNotificationQueueService\.js$/ }, (args) =>
        services.has(args.importer) ? { path: stubs.notification } : null);
    },
  }],
}).then(() => console.log("PR117_CANONICAL_VENDOR_INVOICE_AP_SERVICE_BUNDLE_READY"))
  .catch(error => { console.error(error instanceof Error ? error.message : "BUNDLE_FAILED"); process.exit(1); });
