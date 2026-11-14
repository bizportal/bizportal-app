#!/usr/bin/env node
/**
 * Source-presence preflight for Hostinger PROD repository cutover.
 *
 * This checks for the legacy PROD implementation contracts that still need
 * review in the canonical repository. It does NOT establish behavioral parity,
 * enable payroll payments, query live databases, or change deployment settings.
 *
 * node scripts/audit-prod-parity.mjs          # inventory/report only (exit 0)
 * node scripts/audit-prod-parity.mjs --strict # nonzero if contracts missing
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const api = "artifacts/api-server/src/routes/";
const web = "artifacts/bizportal/src/pages/";
const contracts = [
  { area: "HRD", name: "HRD API mounted", path: api + "index.ts",
    markers: ['import hrdRouter from "./hrd-routes"', "router.use(hrdRouter)"] },
  { area: "HRD", name: "HRD OCR route module", path: api + "hrd-document-ocr.ts" },
  { area: "HRD", name: "HRD status and resign guard", path: api + "hrd-resign-kasbon-precheck.ts" },
  { area: "HRD", name: "HRD employee directory UI", path: web + "hr/employee-directory.tsx" },
  { area: "Finance", name: "Group allocation API mounted", path: api + "index.ts",
    markers: ['import groupPaymentAllocationsRouter from "./group-payment-allocations"', "router.use(groupPaymentAllocationsRouter)"] },
  { area: "Payroll", name: "Kasbon automatic deduction API registered", path: api + "payroll.ts",
    markers: ["registerPayrollKasbonAutoRoutes(router)"] },
  { area: "Payroll", name: "Super Admin approval API registered", path: api + "payroll.ts",
    markers: ["registerPayrollSuperAdminApprovalRoutes(router)"] },
  { area: "Payroll", name: "Effective salary setup API registered", path: api + "payroll.ts",
    markers: ["registerEffectiveSetupPreviewRoutes(router)"] },
  { area: "Payroll", name: "Payroll setup readiness API registered", path: api + "payroll.ts",
    markers: ["registerPayrollSetupReadinessRoutes(router)"] },
  { area: "Payroll", name: "Historical salary review API registered", path: api + "payroll.ts",
    markers: ["registerPayrollHistoricalSalaryReviewRoutes(router)"] },
  { area: "Payroll", name: "Scoped PROD Payroll draft routes registered", path: api + "payroll.ts",
    markers: ["registerProdPayrollDraftRoutes(router)"] },
  { area: "Payroll", name: "PROD Payroll controls UI", path: web + "hr/PayrollProdRunControls.tsx" },
  { area: "Kasbon", name: "Scoped GET-only historical kasbon API mounted", path: api + "index.ts",
    markers: ['import advanceKasbonReadOnlyRouter from "./advance-kasbon-readonly"', "router.use(advanceKasbonReadOnlyRouter)"] },
  { area: "Kasbon", name: "Dedicated role-scoped PROD reader", path: api + "payroll-prod-db.ts",
    markers: ['BEGIN READ ONLY', 'SET LOCAL ROLE bizportal_payroll_prod'] },
  { area: "Kasbon", name: "Historical balance labeled unverified", path: web + "finance/advance-management.tsx",
    markers: ["Tercatat Belum Terverifikasi"] },
  { area: "Finance", name: "Read-only Rule AI preview API present", path: api + "recon-classification.ts",
    markers: ['/ai-rules/preview'] }
];

const checks = contracts.map(({ area, name, path, markers = [] }) => {
  const filename = resolve(root, path);
  if (!existsSync(filename)) return { area, name, status: "MISSING", path, reason: "file absent" };
  const source = readFileSync(filename, "utf8");
  const missing = markers.filter(marker => !source.includes(marker));
  return { area, name, status: missing.length ? "MISSING" : "PRESENT", path,
    ...(missing.length ? { reason: "required source-level markers absent", markers: missing } : {}) };
});
const missing = checks.filter(item => item.status === "MISSING");
const strict = process.argv.includes("--strict");
const json = process.argv.includes("--json");
if (json) {
  process.stdout.write(JSON.stringify({ evidence: "source-presence-only", strict,
    present: checks.length - missing.length, missing: missing.length, checks }, null, 2) + "\n");
} else {
  console.log("Hostinger PROD source-parity inventory (NOT behavior proof):");
  for (const item of checks) console.log(item.status.padEnd(7) + " [" + item.area + "] " + item.name);
  console.log("\nSource markers present: " + (checks.length - missing.length) + "/" + checks.length);
  console.log("No production writes, credentials, database operations, or deployment actions were performed.");
  if (missing.length) console.log("CUTOVER BLOCKED pending documented behavioral parity.");
}
if (strict && missing.length) process.exitCode = 1;
