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
  otp_expires_at: "2026-11-27 00:06:00+00",
  otp_created_at: "2026-11-27 00:03:00+00",
};
type TestRow = Omit<typeof row, "otp_email" | "otp_verified_at" | "otp_expires_at" | "otp_created_at"> & {
  otp_email: string | null; otp_verified_at: string | null;
  otp_expires_at: string | null; otp_created_at: string | null;
};
const db = (rows: TestRow[] = [row]) => ({
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
      1, source.transactionId, fp, `sc-cash-voucher:${source.transactionId}:${fp}:`,
      source.sourceDocumentSha256,
    ]);
    const sql = reader.query.mock.calls[0]![0].trim().toLowerCase();
    expect(sql.startsWith("select")).toBe(true);
    expect(sql).not.toMatch(/\b(insert|update|delete)\b/);
    expect(sql).toContain("purpose = $4 || (a.metadata->>'countercoaid')");
    expect(sql).toContain("id::text = a.metadata->>'otpevidenceid'");
    expect(sql).toContain("verified_at is not null");
    expect(sql).toContain("select email, verified_at, expires_at, created_at");
    expect(sql).toContain("verified_at <= expires_at");
    expect(sql).toContain("verified_at >= created_at");
    expect(sql).toContain("attempts < 5");
    expect(sql).not.toContain("code_hash");
    // Reusable approval facts must also demand a currently VERIFIED original.
    // The revoked historical OTP approval still exists, but cannot reauthorize.
    expect(sql).toContain("join public.sc_future_cash_documents d");
    expect(sql).toContain("d.transaction_id=$2::uuid");
    expect(sql).toContain("d.document_sha256=$5");
    expect(sql).toContain("d.source_fingerprint=$3");
    expect(sql).toContain("current_document.event_type='verified'");
    expect(sql).toContain("revoked.event_type='revoked'");
    expect(sql).toContain("not exists");
  });

  it("binds the OTP purpose to the exact counter COA and rejects invalid COAs", () => {
    expect(futureCashOtpPurpose(source.transactionId, fp, 902)).toBe(
      `sc-cash-voucher:${source.transactionId}:${fp}:902`);
    expect(futureCashOtpPurpose(source.transactionId, fp, 903)).not.toBe(
      futureCashOtpPurpose(source.transactionId, fp, 902));
    for (const id of [0, -1, 1.5, 75839, 2147483648, NaN]) {
      expect(() => futureCashOtpPurpose(source.transactionId, fp, id)).toThrow();
    }
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

  it("rejects stale, future, expired and not-yet-issued OTP confirmation", async () => {
    for (const changed of [{ ...row, otp_verified_at: "2026-11-26 23:00:00+00" },
      { ...row, otp_verified_at: "2026-11-27 00:07:00+00" },
      { ...row, otp_expires_at: "2026-11-27 00:03:59+00" },
      { ...row, otp_created_at: "2026-11-27 00:04:01+00" },
      { ...row, otp_expires_at: null },
      { ...row, otp_created_at: null }]) {
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
