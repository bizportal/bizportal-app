"use strict";
// Test source contract only. E2E requires separately authorized synthetic DEV QA.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const src = fs.readFileSync("scripts/qa/dev-vendor-acceptance.ts", "utf8");
const begin = src.indexOf("async function exercise(f: Fixture)");
const end = src.indexOf("async function cleanup()", begin);
assert(begin >= 0 && end > begin, "vendor QA flow missing");
const qa = src.slice(begin, end);
const needed = [
  'step("company_spoof_denial"',
  'step("ap_create"',
  'step("ap_replay"',
  'step("ap_review"',
  'step("ap_waiting_payment"',
  'step("accounting_draft"',
  'step("accounting_draft_replay"',
];
for (const marker of needed) assert(qa.includes(marker), "missing lifecycle checkpoint: " + marker);
for (let i=1;i<needed.length;i++) {
 assert(qa.indexOf(needed[i-1]) < qa.indexOf(needed[i]),"AP lifecycle sequence changed");
}
assert(qa.includes("SET LOCAL lock_timeout='3s'"), "bounded parent locks missing");
assert(qa.includes("SET LOCAL idle_in_transaction_session_timeout='15s'"), "idle transaction guard missing");
assert(qa.includes('app!.withMarketplaceFinanceDevTransaction(f.companyId, async tx => {'), "company role missing");
assert(!qa.includes("await app!.withMarketplaceFinanceDevTransaction(f.companyId, async tx => {"), "old giant AP transaction revived");
assert(qa.includes("CROSS_COMPANY_GUC_SPOOF"), "cross-company scope proof missing");
assert(qa.includes("ACCOUNTING_DRAFT_REPLAY"), "Accounting idempotency proof missing");
assert(qa.includes("VENDOR_UPLOAD_REPLAY"), "Vendor upload idempotency proof missing");
assert(src.includes("OWNED_QA_ROWS_AND_PRIVATE_OBJECTS_CLEANED_PO14_UNCHANGED"), "QA cleanup gate missing");
assert(src.includes("BIZPORTAL_VENDOR_ACCEPTANCE_EXECUTE_DEV"), "explicit DEV synthetic execute gate missing");
console.log("PR130_INDIVIDUAL_FINANCE_AP_TRANSACTION_SOURCE_GUARD_PASS");
