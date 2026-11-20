#!/usr/bin/env node
/**
 * PR147 credential-delivery preflight: read ONLY environment variable names
 * and approved non-secret Secret Manager resource names.
 *
 * Does not access GCP, open connections, inspect passwords, or authorize
 * cutover. Real signed role/TLS/RLS/finance E2E is a separate mandatory gate.
 */
const companies = [
  {
    label: "CST",
    direct: "PR147_BANK_SHEET_CST_DATABASE_URL_DEV",
    gcp: "PR147_BANK_SHEET_CST_GCP_SECRET_NAME_DEV",
    approvedSecret: "bizportal-pr147-bank-sheet-cst-dev",
  },
  {
    label: "DIVA",
    direct: "PR147_BANK_SHEET_DIVA_DATABASE_URL_DEV",
    gcp: "PR147_BANK_SHEET_DIVA_GCP_SECRET_NAME_DEV",
    approvedSecret: "bizportal-pr147-bank-sheet-diva-dev",
  },
];

const rows = [];
let blocked = false;
for (const c of companies) {
  const hasDirect = Boolean(process.env[c.direct]?.trim());
  const configuredSecret = process.env[c.gcp]?.trim();
  let status;
  if (hasDirect && configuredSecret) status = "AMBIGUOUS_SOURCES";
  else if (configuredSecret && configuredSecret !== c.approvedSecret) status = "UNAPPROVED_SECRET_NAME";
  else if (configuredSecret) {
    status = process.env.GCP_SECRET_MANAGER_BOOTSTRAP_JSON?.trim()
      ? "GCP_CONFIG_PRESENT_UNVERIFIED" : "GCP_BOOTSTRAP_MISSING";
  } else if (hasDirect) status = "PROTECTED_DIRECT_CONFIG_PRESENT_UNVERIFIED";
  else status = "NO_READER_CREDENTIAL_SOURCE";
  if (!status.endsWith("_UNVERIFIED")) blocked = true;
  rows.push([c.label, status]);
}
if (process.env.APP_ENV?.trim().toLowerCase() !== "development") blocked = true;
console.log("ENVIRONMENT=" + (process.env.APP_ENV === "development" ? "DEV" : "NOT_VERIFIED_DEV"));
for (const [label,status] of rows) console.log(label + "_READER_SOURCE=" + status);
console.log("SECRET_VALUES_EXPOSED=false");
console.log("SIGNED_DB_TLS_RLS_AND_BROWSER_E2E_REQUIRED=true");
console.log("CUTOVER_APPROVED=false");
console.log("CONFIGURATION_PREFLIGHT=" + (blocked ? "BLOCKED" : "CONFIG_PRESENT_BUT_UNVERIFIED"));
if (blocked) process.exitCode = 2;
