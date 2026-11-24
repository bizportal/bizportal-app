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
  it("classifies existing GCP bootstrap errors without exposing JSON", () => {
    expect(classify(new Error("GCP_SECRET_MANAGER_BOOTSTRAP_JSON is not valid JSON")))
      .toBe("BANK_SHEET_GCP_BOOTSTRAP_INVALID");
    expect(classify(new Error("GCP Secret Manager credentials are missing project_id, client_email, or private_key")))
      .toBe("BANK_SHEET_GCP_BOOTSTRAP_INVALID");
    expect(classify(new Error("GCP_SECRET_MANAGER_BOOTSTRAP_JSON is not configured")))
      .toBe("BANK_SHEET_GCP_BOOTSTRAP_MISSING");
  });
  it("distinguishes GCP OAuth failures and Secret Manager IAM/404", () => {
    expect(classify(new Error("GCP OAuth token request failed (400)")))
      .toBe("BANK_SHEET_GCP_OAUTH_AUTH_FAILED");
    expect(classify(new Error("GCP OAuth token request failed (500)")))
      .toBe("BANK_SHEET_GCP_OAUTH_UNAVAILABLE");
    expect(classify(new Error("GCP Secret Manager read failed for bizportal-marketplace-finance-dev-companies (403)")))
      .toBe("BANK_SHEET_GCP_SECRET_ACCESS_DENIED");
    expect(classify(new Error("GCP Secret Manager read failed for bizportal-marketplace-finance-dev-companies (404)")))
      .toBe("BANK_SHEET_GCP_SECRET_NOT_FOUND");
    expect(classify(new Error("GCP secret bizportal-marketplace-finance-dev-companies has no payload")))
      .toBe("BANK_SHEET_GCP_SECRET_EMPTY_PAYLOAD");
  });
  it("never classifies arbitrary secret names or credential-bearing strings", () => {
    for (const candidate of [
      "GCP Secret Manager read failed for my-secret-password (403)",
      "GCP Secret Manager read failed for bizportal-marketplace-finance-dev-companies (403) : token=secret",
      "GCP OAuth token request failed (400): password=secret",
      "GCP secret unknown-private-secret has no payload",
    ]) {
      expect(classify(new Error(candidate))).toBe("BANK_SHEET_READER_UNAVAILABLE");
    }
  });
  it("never passes unknown error contents, URL, or password", () => {
    const secret = "postgresql://reader:supersecret@private.test/postgres";
    expect(classify(new Error(secret))).toBe("BANK_SHEET_READER_UNAVAILABLE");
    expect(classify({code:"UNTRUSTED",message:secret})).toBe("BANK_SHEET_READER_UNAVAILABLE");
    expect(classify(null)).toBe("BANK_SHEET_READER_UNAVAILABLE");
  });
  it("distinguishes known PostgreSQL schema and query compatibility failures", () => {
    expect(classify({code:"42703",message:"may contain private column name"})).toBe("BANK_SHEET_READER_DB_SCHEMA_MISSING");
    expect(classify({code:"42883"})).toBe("BANK_SHEET_READER_DB_SCHEMA_MISSING");
    expect(classify({code:"22P02"})).toBe("BANK_SHEET_READER_DB_QUERY_INCOMPATIBLE");
  });
  it("classifies wrapped transport errors without exposing the cause", () => {
    expect(classify({message:"fetch failed",cause:{code:"ECONNRESET",message:"secret content"}}))
      .toBe("BANK_SHEET_READER_UPSTREAM_CONNECTIVITY");
    expect(classify({cause:{code:"ERR_TLS_CERT_ALTNAME_INVALID",message:"private host"}}))
      .toBe("BANK_SHEET_READER_UPSTREAM_TLS_FAILED");
    expect(classify({cause:{code:"SOME_UNKNOWN",message:"password"}}))
      .toBe("BANK_SHEET_READER_UNAVAILABLE");
  });
  it("does not allow similar-looking error messages", () => {
    expect(classify(new Error("PR147_DEV_SHEET_READER_NOT_CONFIGURED: " + "password")))
      .toBe("BANK_SHEET_READER_UNAVAILABLE");
  });
});
