import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("Issue #292 financial correction remains inaccessible through public routes", () => {
  it("does not activate the historical reversal from an API endpoint", () => {
    const path = fileURLToPath(new URL("../routes/bank-reconciliation.ts", import.meta.url));
    const source = readFileSync(path, "utf8");
    // These finance helpers are staged for isolated tests. They MUST NOT
    // become an HTTP route until database guards, runtime identity, owner
    // approval and Hostinger deployment provenance are separately verified.
    expect(source).not.toContain("runIssue292CorrectionWithCanonicalApproval(");
    expect(source).not.toContain("runAtomicCanonicalSettlementCorrection(");
    expect(source).not.toContain("reverseCanonicalSettlementForCorrection(");
    expect(source).toContain("approveCanonicalSettlementLink(");
  });
});
