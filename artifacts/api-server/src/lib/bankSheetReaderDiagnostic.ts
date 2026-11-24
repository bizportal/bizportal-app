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
  // GCP bootstrap and REST client errors are raised by the existing secret
  // client as fixed strings (not structured codes). Map only known literals
  // and exact status patterns. Never echo a raw error or secret name.
  if (typeof obj.message === "string") {
    switch (obj.message) {
      case "GCP_SECRET_MANAGER_BOOTSTRAP_JSON is not configured":
        return "BANK_SHEET_GCP_BOOTSTRAP_MISSING";
      case "GCP_SECRET_MANAGER_BOOTSTRAP_JSON is not valid JSON":
      case "GCP Secret Manager credentials are missing project_id, client_email, or private_key":
        return "BANK_SHEET_GCP_BOOTSTRAP_INVALID";
      case "GCP OAuth response did not contain an access token":
        return "BANK_SHEET_GCP_OAUTH_MISSING_TOKEN";
      case "PR147_SYSTEMD_CREDENTIAL_DIRECTORY_REQUIRED":
      case "PR147_SYSTEMD_CREDENTIAL_PERMISSIONS_INVALID":
      case "PR147_SYSTEMD_CREDENTIAL_IDENTITY_MISMATCH":
        return "BANK_SHEET_GCP_SYSTEMD_CREDENTIAL_INVALID";
    }
    const oauthStatus = /^GCP OAuth token request failed \(([1-5][0-9]{2})\)$/.exec(obj.message);
    if (oauthStatus) {
      if (oauthStatus[1] === "400" || oauthStatus[1] === "401" || oauthStatus[1] === "403") {
        return "BANK_SHEET_GCP_OAUTH_AUTH_FAILED";
      }
      return "BANK_SHEET_GCP_OAUTH_UNAVAILABLE";
    }
    const secretStatus = /^GCP Secret Manager read failed for (bizportal-marketplace-finance-dev-companies|bizportal-pr147-bank-sheet-cst-dev|bizportal-pr147-bank-sheet-diva-dev) \(([1-5][0-9]{2})\)$/.exec(obj.message);
    if (secretStatus) {
      switch (secretStatus[2]) {
        case "401": case "403": return "BANK_SHEET_GCP_SECRET_ACCESS_DENIED";
        case "404": return "BANK_SHEET_GCP_SECRET_NOT_FOUND";
        default: return "BANK_SHEET_GCP_SECRET_READ_FAILED";
      }
    }
    const noPayload = /^GCP secret (bizportal-marketplace-finance-dev-companies|bizportal-pr147-bank-sheet-cst-dev|bizportal-pr147-bank-sheet-diva-dev) has no payload$/.exec(obj.message);
    if (noPayload) return "BANK_SHEET_GCP_SECRET_EMPTY_PAYLOAD";
  }
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
