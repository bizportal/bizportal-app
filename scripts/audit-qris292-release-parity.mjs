#!/usr/bin/env node
/**
 * Issue #292 release-source static readiness audit.
 * READ ONLY: no database connections, credentials, network, git operations,
 * deployment, or financial writes. Missing dependencies produce BLOCKED.
 * This is an *inventory* and never authorizes merge or production correction.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const required = [
  ["correction_writer", "artifacts/api-server/src/lib/reconciliation/canonicalSettlementCorrection.ts"],
  ["atomic_coordinator", "artifacts/api-server/src/lib/reconciliation/canonicalSettlementCorrectionCoordinator.ts"],
  ["owner_rule_gate", "artifacts/api-server/src/lib/reconciliation/issue292OwnerRuleGate.ts"],
  ["finance_principal_gate", "artifacts/api-server/src/lib/reconciliation/issue292FinancePrincipalGate.ts"],
  ["guard_migration", "scripts/sql/20261113_guarded_finalized_settlement_membership_compensation.sql"],
  ["isolated_postgres_workflow", ".github/workflows/qris292-isolated-postgres.yml"],
  ["atomic_owner_e2e", "artifacts/api-server/src/__tests__/qris292-atomic-owner-e2e.test.ts"],
];
const routePath = resolve(root, "artifacts/api-server/src/routes/bank-reconciliation.ts");
const route = existsSync(routePath) ? readFileSync(routePath, "utf8") : "";
const checks = [
  ...required.map(([id, path]) => ({id, passed:existsSync(resolve(root,path)), path})),
  {
    id:"canonical_approval_entrypoint",
    passed:route.includes("approveCanonicalSettlementLink"),
    path:"artifacts/api-server/src/routes/bank-reconciliation.ts",
  },
  {
    id:"issue292_owner_integrated_route",
    passed:route.includes("rebuildIssue292WithOwnerFunctions")
      && route.includes("runAtomicCanonicalSettlementCorrection")
      && route.includes("isIssue292ScopedFinanceSession"),
    path:"artifacts/api-server/src/routes/bank-reconciliation.ts",
  },
];
const missing=checks.filter(c=>!c.passed);
const report={
  contract:"issue292-release-parity-inventory-v1",
  repository:"bizportal/bizportal-app",
  sourceKind:"static-read-only",
  result:missing.length===0?"STATIC_INVENTORY_PRESENT":"BLOCKED_MISSING_DEPENDENCIES",
  releaseAuthorized:false,
  actualHostingerRuntimeVerified:false,
  databaseGuardsVerified:false,
  financeE2eVerifiedOnThisRepository:false,
  checks,
  missingCount:missing.length,
};
process.stdout.write(JSON.stringify(report,null,2)+"\n");
if (process.argv.includes("--fail-on-blocked") && missing.length) process.exitCode=2;
