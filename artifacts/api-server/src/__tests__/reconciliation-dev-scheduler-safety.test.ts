import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { shouldRunReconciliationSchedulers } from "../lib/reconciliation/backgroundSchedulerPolicy";

describe("reconciliation background scheduling isolation", () => {
  it.each([
    { environment: "DEV", isDev: true, flag: undefined, expected: false },
    { environment: "DEV explicit false", isDev: true, flag: "false", expected: false },
    { environment: "DEV explicit true", isDev: true, flag: "true", expected: true },
    { environment: "DEV case-insensitive true", isDev: true, flag: " TRUE ", expected: true },
    { environment: "PROD", isDev: false, flag: undefined, expected: true },
    { environment: "PROD explicit false", isDev: false, flag: "false", expected: true },
  ])("respects the $environment gate", ({ isDev, flag, expected }) => {
    expect(shouldRunReconciliationSchedulers(isDev, flag)).toBe(expected);
  });

  it("guards both historical accounting and QRIS recurring jobs", () => {
    const source = readFileSync(resolve(process.cwd(), "src/index.ts"), "utf8")
      .replace(/\r\n/g, "\n");
    expect(source).toContain(
      "const reconciliationSchedulersEnabled = shouldRunReconciliationSchedulers(",
    );
    expect(source).toContain("DEV_RECONCILIATION_SCHEDULERS_ENABLED");
    expect(source).toMatch(
      /const kasScRuleBackfillTimer = reconciliationSchedulersEnabled\s*\? setInterval/,
    );
    expect(source).toMatch(
      /const qrisAutoCandidateTimer = reconciliationSchedulersEnabled\s*\? setInterval/,
    );
    expect(source).toContain("if (kasScRuleBackfillTimer) {");
    expect(source).toContain("if (qrisAutoCandidateTimer) {");
  });
});
