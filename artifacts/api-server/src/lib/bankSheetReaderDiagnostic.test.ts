import { describe, expect, it } from "vitest";
import { classifyBankSheetReaderFailure as classify } from "./bankSheetReaderDiagnostic";

describe("DEV bank Sheet reader error sanitization", () => {
  it("identifies a missing source without logging a secret", () => {
    expect(classify(new Error("PR147_DEV_SHEET_READER_NOT_CONFIGURED")))
      .toBe("PR147_DEV_SHEET_READER_NOT_CONFIGURED");
  });
  it("maps DB auth, permission and network failures", () => {
    expect(classify({code:"28P01",message:"sensitive password"})).toBe("BANK_SHEET_READER_DB_AUTH_FAILED");
    expect(classify({code:"42501",message:"private table"})).toBe("BANK_SHEET_READER_DB_PERMISSION_DENIED");
    expect(classify({code:"ETIMEDOUT"})).toBe("BANK_SHEET_READER_DB_CONNECTIVITY");
  });
  it("never passes unknown error contents, URL, or password", () => {
    const secret = "postgresql://reader:supersecret@private.test/postgres";
    expect(classify(new Error(secret))).toBe("BANK_SHEET_READER_UNAVAILABLE");
    expect(classify({code:"UNTRUSTED",message:secret})).toBe("BANK_SHEET_READER_UNAVAILABLE");
    expect(classify(null)).toBe("BANK_SHEET_READER_UNAVAILABLE");
  });
  it("does not allow similar-looking error messages", () => {
    expect(classify(new Error("PR147_DEV_SHEET_READER_NOT_CONFIGURED: " + "password")))
      .toBe("BANK_SHEET_READER_UNAVAILABLE");
  });
});
