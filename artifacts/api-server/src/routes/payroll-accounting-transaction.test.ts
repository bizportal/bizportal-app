import { afterEach, describe, expect, it, vi } from "vitest";
import { postReviewedPayrollAccrualTransaction, type PayrollAtomicRequest, type TransactionBoundPayrollWriter } from "./payroll-accounting-transaction";
const request: PayrollAtomicRequest = { companyId: 1, runId: 32, postingDate: "2026-11-17",
  expectedDigest: "a".repeat(64), actor: { id: "synthetic", email: "admin@example.test", role: "super_admin" } };
afterEach(() => vi.unstubAllEnvs());
describe("application Payroll atomic service activation boundary", () => {
  it.each(["production", "", "development"])("never obtains a connection in %s with the new gate OFF", async env => {
    vi.stubEnv("APP_ENV", env);vi.stubEnv("PAYROLL_DEV_ATOMIC_POSTING_ENABLED", "");
    const connect = vi.fn();
    await expect(postReviewedPayrollAccrualTransaction({ connect }, {} as TransactionBoundPayrollWriter, request))
      .rejects.toThrow("DEV_POSTING_DISABLED");
    expect(connect).not.toHaveBeenCalled();
  });
  it("DEV flag cannot enable a production runtime", async () => {
    vi.stubEnv("APP_ENV", "production");vi.stubEnv("PAYROLL_DEV_ATOMIC_POSTING_ENABLED", "true");
    const connect = vi.fn();
    await expect(postReviewedPayrollAccrualTransaction({ connect }, {} as TransactionBoundPayrollWriter, request))
      .rejects.toThrow("DEV_POSTING_DISABLED");
    expect(connect).not.toHaveBeenCalled();
  });
  it.each([{ companyId: 0 }, { runId: -1 }, { expectedDigest: "invalid" },
    { actor: { ...request.actor, role: "finance" } }, { actor: { ...request.actor, id: "" } }])(
    "rejects invalid trusted scope before acquiring a database connection %j", async mutation => {
      vi.stubEnv("APP_ENV", "development");vi.stubEnv("PAYROLL_DEV_ATOMIC_POSTING_ENABLED", "true");
      const connect = vi.fn();
      await expect(postReviewedPayrollAccrualTransaction({ connect }, {} as TransactionBoundPayrollWriter, { ...request, ...mutation }))
        .rejects.toThrow("TRUSTED_ACTOR_AND_SCOPE_REQUIRED");
      expect(connect).not.toHaveBeenCalled();
  });
  it("requires explicit native transaction-aware writer binding", async () => {
    vi.stubEnv("APP_ENV", "development");vi.stubEnv("PAYROLL_DEV_ATOMIC_POSTING_ENABLED", "true");
    const connect = vi.fn();
    await expect(postReviewedPayrollAccrualTransaction({ connect }, {} as TransactionBoundPayrollWriter, request))
      .rejects.toThrow("TRANSACTIONAL_WRITER_REQUIRED");
    expect(connect).not.toHaveBeenCalled();
  });
});
