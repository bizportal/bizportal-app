/**
 * Security-safe diagnostics for the DEV bank Sheet read-only endpoint.
 * Never forward a raw DB/secret error, message, credentials, or stack.
 */
const READER_CODES = new Set([
  "PR147_DEV_SHEET_READER_ENVIRONMENT_REQUIRED",
  "PR147_DEV_SHEET_READER_COMPANY_UNSUPPORTED",
  "PR147_DEV_SHEET_READER_NOT_CONFIGURED",
  "PR147_DEV_SHEET_READER_CREDENTIAL_SOURCE_AMBIGUOUS",
  "PR147_DEV_SHEET_READER_SECRET_NAME_INVALID",
  "PR147_DEV_SHEET_READER_BUNDLE_NAME_INVALID",
  "PR147_DEV_SHEET_READER_SECRET_EMPTY",
  "PR147_DEV_SHEET_READER_BUNDLE_INVALID",
  "PR147_DEV_SHEET_READER_BUNDLE_COMPANY_IDENTITY_MISMATCH",
  "PR147_DEV_SHEET_READER_URL_INVALID",
  "PR147_DEV_SHEET_READER_IDENTITY_MISMATCH",
  "PR147_DEV_SHEET_READER_TLS_REQUIRED",
  "PR147_DEV_SHEET_READER_CREDENTIAL_CHANGED_RESTART_REQUIRED",
]);

export function classifyBankSheetReaderFailure(error: unknown): string {
  if (!error || typeof error !== "object") return "BANK_SHEET_READER_UNAVAILABLE";
  const obj = error as { message?: unknown; code?: unknown };
  if (typeof obj.message === "string" && READER_CODES.has(obj.message)) return obj.message;
  switch (obj.code) {
    case "28P01": return "BANK_SHEET_READER_DB_AUTH_FAILED";
    case "42501": return "BANK_SHEET_READER_DB_PERMISSION_DENIED";
    case "42P01": return "BANK_SHEET_READER_DB_SCHEMA_MISSING";
    case "3D000": return "BANK_SHEET_READER_DB_NOT_FOUND";
    case "ETIMEDOUT": case "ECONNREFUSED": case "ENOTFOUND": case "EAI_AGAIN":
      return "BANK_SHEET_READER_DB_CONNECTIVITY";
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE": case "CERT_HAS_EXPIRED": case "ERR_TLS_CERT_ALTNAME_INVALID":
      return "BANK_SHEET_READER_DB_TLS_FAILED";
    default: return "BANK_SHEET_READER_UNAVAILABLE";
  }
}
