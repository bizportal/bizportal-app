import { describe, expect, it, vi } from "vitest";
import { prepareFutureCashSource, type FutureCashSource } from "../lib/future-cash-source-identity";
import { futureCashOtpPurpose, readPurposeBoundFutureCashApproval }
  from "../lib/future-cash-purpose-otp-reader";

const source: FutureCashSource = {
  companyId: 1, accountId: 18, cashCoaId: 75839,
  transactionId: "33333333-3333-4333-8333-333333333333",
  sourceDocumentSha256: "a".repeat(64), direction: "OUT",
  amount: "50000.00", date: "2026-11-27",
};
const fp = prepareFutureCashSource(source).sourceFingerprint;
const row = {
  company_id: 1, status: "approved", approval_type: "signed_email_otp",
  approver_role: "owner", approved_by: "owner@example.test",
  approved_at: "2026-11-27 00:05:00+00",
  transaction_id: source.transactionId, source_fingerprint: fp, account_id: 18,
  counter_coa_id: 902, otp_email: "owner@example.test",
  otp_verified_at: "2026-11-27 00:04:00+00",
};
const db = (rows: Array<typeof row> = [row]) => ({
  query: vi.fn(async (_sql: string, _params: readonly unknown[]) => ({ rows })),
});
describe("Account18 purpose-separated OTP approval reader — SELECT only", () => {
  it("only reads exact voucher-specific OTP purpose and permits read-only approval facts", async () => {
    const reader = db();
    const result = await readPurposeBoundFutureCashApproval(source, reader);
    expect(result).toMatchObject({ transactionId: source.transactionId,
      sourceFingerprint: fp, authorizedRole: "owner",
      authenticationMethod: "SIGNED_EMAIL_OTP", counterCoaId: 902 });
    expect(reader.query.mock.calls[0]![1]).toEqual([
      1, source.transactionId, fp, futureCashOtpPurpose(source.transactionId, fp),
    ]);
    const sql = reader.query.mock.calls[0]![0].trim().toLowerCase();
    expect(sql.startsWith("select")).toBe(true);
    expect(sql).not.toMatch(/\b(insert|update|delete)\b/);
    expect(sql).toContain("verified_at is not null");
    expect(sql).not.toContain("code_hash");
  });

  it("never promotes a login OTP or missing voucher OTP", async () => {
    for (const changed of [{ ...row, otp_email: null },
      { ...row, otp_verified_at: null },
      { ...row, approval_type: "admin-email-login" },
      { ...row, status: "pending" }]) {
      expect(await readPurposeBoundFutureCashApproval(source, db([changed])))
        .toBeNull();
    }
  });

  it("rejects wrong company, account, source, COA and unrecognized role", async () => {
    for (const changed of [{ ...row, company_id: 3 }, { ...row, account_id: 1 },
      { ...row, source_fingerprint: "b".repeat(64) },
      { ...row, counter_coa_id: 75839 }, { ...row, approver_role: "finance" },
      { ...row, otp_email: "other@example.test" }]) {
      expect(await readPurposeBoundFutureCashApproval(source, db([changed])))
        .toBeNull();
    }
  });

  it("rejects stale and future OTP confirmation", async () => {
    for (const changed of [{ ...row, otp_verified_at: "2026-11-26 23:00:00+00" },
      { ...row, otp_verified_at: "2026-11-27 00:06:00+00" }]) {
      expect(await readPurposeBoundFutureCashApproval(source, db([changed])))
        .toBeNull();
    }
  });

  it("fails closed for missing, ambiguous and unavailable database rows", async () => {
    expect(await readPurposeBoundFutureCashApproval(source, db([]))).toBeNull();
    expect(await readPurposeBoundFutureCashApproval(source, db([row, row]))).toBeNull();
    const reader = { query: vi.fn(async () => { throw Error("private database credential"); }) };
    expect(await readPurposeBoundFutureCashApproval(source, reader)).toBeNull();
  });
});
