import { createDedicatedPayrollPool, readSecret, type PayrollDbClient } from "@workspace/db";

/**
 * Isolated future DEV Super Admin approval writer. Never reuse the legacy
 * bizportal_payroll_dev login, shared BizPortal pool or any PROD credential.
 * No role or credential is provisioned by this source-only adapter.
 */
const DEV_REF = "xssrfshdrtdfupgqwfdw";
const LOGIN = "bizportal_payroll_approver_dev";
let dedicated: ReturnType<typeof createDedicatedPayrollPool> | null = null;
let connectedUrl: string | null = null;

// GCP secret material is resolved only after an explicitly gated DEV startup.
// No secret is committed, logged, or loaded from the shared BizPortal database.
let managedSecret: { name: string; url: string } | null = null;

function validateManagedApprovalUrl(raw: string): string | null {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return null; }
  const host = parsed.hostname.toLowerCase();
  const username = decodeURIComponent(parsed.username);
  const direct = host === "db." + DEV_REF + ".supabase.co" && username === LOGIN;
  const pooler = /^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(host) &&
    username === LOGIN + "." + DEV_REF;
  // The secure source is an exact, pinned DEV login, never the shared/prod URL.
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !(direct || pooler) ||
      !parsed.password || parsed.pathname !== "/postgres" ||
      !["5432", "6543"].includes(parsed.port || "5432")) return null;
  // Avoid pg-connection-string duplicate/override precedence surprises.
  const keys = [...parsed.searchParams.keys()];
  if (keys.some(k => !["sslmode", "sslrootcert"].includes(k)) ||
      parsed.searchParams.getAll("sslmode").length !== 1 ||
      parsed.searchParams.get("sslmode") !== "verify-full" ||
      parsed.searchParams.getAll("sslrootcert").length > 1) return null;
  return raw;
}

/** Explicit separate DEV secret source; never triggered by ordinary Payroll.
 * Called once on a DEV canary boot when BOTH route and approval flags are ON.
 * An unavailable/malformed secret leaves approval disabled (fail-closed).
 */
export async function prepareDevApprovalCredential(
  secretReader: (secretName: string) => Promise<string> = readSecret,
): Promise<boolean> {
  if (process.env.APP_ENV !== "development" ||
      process.env.PAYROLL_DEV_SUPER_ADMIN_ROUTE_MOUNT_ENABLED !== "true" ||
      process.env.PAYROLL_DEV_SUPER_ADMIN_APPROVAL_ENABLED !== "true") return false;
  const name = process.env.PAYROLL_APPROVAL_GCP_SECRET_NAME_DEV?.trim();
  if (!name) return false;
  if (process.env.PAYROLL_APPROVAL_DATABASE_URL_DEV?.trim())
    throw Error("PAYROLL_DEV_APPROVAL_CREDENTIAL_SOURCE_AMBIGUOUS");
  if (!/^bizportal-payroll-approver-dev(?:-[a-z0-9-]+)?$/.test(name))
    throw Error("PAYROLL_DEV_APPROVAL_SECRET_NAME_INVALID");
  const raw = (await secretReader(name)).trim();
  if (!validateManagedApprovalUrl(raw))
    throw Error("PAYROLL_DEV_APPROVAL_MANAGED_SECRET_INVALID");
  if (dedicated && connectedUrl !== raw)
    throw Error("PAYROLL_DEV_APPROVAL_DB_CHANGED_RESTART_REQUIRED");
  if (managedSecret && (managedSecret.name !== name || managedSecret.url !== raw))
    throw Error("PAYROLL_DEV_APPROVAL_SECRET_CHANGED_RESTART_REQUIRED");
  managedSecret = { name, url: raw };
  return true;
}


function approvalUrl(): string | null {
  if (process.env.APP_ENV !== "development") return null;
  const directCredential = process.env.PAYROLL_APPROVAL_DATABASE_URL_DEV?.trim();
  const managedName = process.env.PAYROLL_APPROVAL_GCP_SECRET_NAME_DEV?.trim();
  if (directCredential && managedName) return null;
  const raw = managedName
    ? managedSecret?.name === managedName ? managedSecret.url : null
    : directCredential;
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) return null;
  let username: string;
  try { username = decodeURIComponent(url.username); } catch { return null; }
  const host = url.hostname.toLowerCase();
  const direct = host === "db." + DEV_REF + ".supabase.co" && username === LOGIN;
  const pooler = /^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(host) &&
    username === LOGIN + "." + DEV_REF;
  if (!(direct || pooler) || !url.password || !url.pathname || url.pathname === "/") return null;
  return raw;
}

export function devApprovalDedicatedEnabled(): boolean {
  return approvalUrl() !== null;
}

export function getDevApprovalPool() {
  const url = approvalUrl();
  if (!url) throw Error("PAYROLL_DEV_APPROVAL_DEDICATED_WRITER_REQUIRED");
  if (dedicated && connectedUrl !== url) throw Error("PAYROLL_DEV_APPROVAL_DB_CHANGED_RESTART_REQUIRED");
  if (!dedicated) { dedicated = createDedicatedPayrollPool(url); connectedUrl = url; }
  return dedicated;
}

export async function setDevApprovalCompanyScope(client: PayrollDbClient, companyId: number): Promise<void> {
  if (!Number.isSafeInteger(companyId) || companyId <= 0) throw Error("PAYROLL_INVALID_COMPANY_SCOPE");
  if (!devApprovalDedicatedEnabled()) throw Error("PAYROLL_DEV_APPROVAL_DEDICATED_WRITER_REQUIRED");
  await client.query("SELECT set_config('app.payroll_company_id',$1,true)", [String(companyId)]);
}

export async function closeDevApprovalPool(): Promise<void> {
  const previous = dedicated;
  dedicated = null;
  connectedUrl = null;
  managedSecret = null;
  if (previous) await previous.end();
}
