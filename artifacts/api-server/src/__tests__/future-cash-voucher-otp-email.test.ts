import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sendFutureCashVoucherOtpEmail } from "../lib/smtp";

const source = readFileSync(fileURLToPath(new URL("../lib/smtp.ts", import.meta.url)), "utf8");

describe("Account18 voucher OTP email is separate from login email", () => {
  it("rejects invalid voucher identity before SMTP connection", async () => {
    await expect(sendFutureCashVoucherOtpEmail(
      "owner@example.test", "123456", "../bad-voucher",
    )).rejects.toThrow("Invalid cash voucher identifier");
  });

  it("preserves the canonical login email wrapper and separate voucher wording", () => {
    expect(source).toContain('sendScopedOtpEmail(recipient, code, "login")');
    expect(source).toContain('sendScopedOtpEmail(recipient, code, "cash-voucher", voucherId)');
    expect(source).toContain("Subject: Kode OTP Login BizPortal");
    expect(source).toContain("Subject: Kode OTP Persetujuan Voucher Kas Besar SC");
    expect(source).toContain("Kode ini hanya untuk persetujuan voucher tersebut");
    expect(source).toContain("Kode ini berlaku selama 5 menit");
    expect(source).not.toContain("readyForCommit: true");
  });
});
