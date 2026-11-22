#!/usr/bin/env node
/**
 * Static FAIL-CLOSED QRIS #292 source-only release check.
 * Does not query databases, inspect secrets, or perform deployment.
 * Requires separate independent Hostinger and production DB attestations.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root=resolve(process.cwd());
const read=(p)=>readFileSync(resolve(root,p),"utf8");
const bankRoute=read("artifacts/api-server/src/routes/bank-reconciliation.ts");
const routesIndex=read("artifacts/api-server/src/routes/index.ts");
const migration=read("scripts/sql/20261113_guarded_finalized_settlement_membership_compensation.sql");
const build=read("scripts/hostinger-build.mjs");
const prepare=read("scripts/prepare-hostinger.mjs");
const checks=[
  {
    id:"finance_correction_not_exposed_as_route",
    ok: !/runIssue292CorrectionWithCanonicalApproval\s*\(|runAtomicCanonicalSettlementCorrection\s*\(|reverseCanonicalSettlementForCorrection\s*\(/.test(bankRoute+routesIndex),
  },
  {
    id:"existing_canonical_approval_retained",
    ok: /approveCanonicalSettlementLink\s*\(/.test(bankRoute),
  },
  {
    id:"specific_historical_batch_only",
    ok: /v_settlement_id\s*=\s*5738/.test(migration)
      && /v_original_journal_id\s*=\s*7207/.test(migration),
  },
  {
    id:"scoped_compensating_journal_required",
    ok: /OLD\.item_status\s*=\s*'active'/.test(migration)
      && /NEW\.item_status\s*=\s*'reversed'/.test(migration)
      && /j\.status\s*=\s*'posted'/.test(migration)
      && /j\.is_reversal\s*=\s*true/.test(migration)
      && /v_status\s*=\s*'reversed'/.test(migration),
  },
  {
    id:"original_immutability_preserved",
    ok: /FINALIZED_SETTLEMENT_ITEMS_ARE_IMMUTABLE/.test(migration)
      && /IF TG_OP\s*=\s*'DELETE' THEN RETURN OLD/.test(migration),
  },
  {
    id:"no_global_trigger_bypass_in_migration",
    ok: !/\bDROP\s+TRIGGER\b|\bDISABLE\s+TRIGGER\b|\bALTER\s+TABLE\b|\bGRANT\b|\bREVOKE\b/i.test(migration),
  },
  {
    id:"build_does_not_apply_historical_migration",
    ok: !/20261113_guarded_finalized_settlement_membership_compensation|supabase\s+db\s+(?:push|reset)|\bpsql\s+.*-f/i.test(build+"\n"+prepare),
  },
];
for(const c of checks)process.stdout.write(`${c.ok?"PASS":"FAIL"} ${c.id}\n`);
const failed=checks.filter(c=>!c.ok);
process.stdout.write(`QRIS292_SOURCE_ONLY_GATE=${failed.length?"BLOCKED":"PASS"}\n`);
if(failed.length)process.exitCode=1;
// PASS means only static source boundaries met. It is never deployment approval.
