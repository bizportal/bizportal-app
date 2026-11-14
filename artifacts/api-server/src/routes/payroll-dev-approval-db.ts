import { createDedicatedPayrollPool, type PayrollDbClient } from "@workspace/db";

/**
 * Isolated future DEV Super Admin approval writer. Never reuse the legacy
 * bizportal_payroll_dev login, shared BizPortal pool or any PROD credential.
 * No role or credential is provisioned by this source-only adapter.
 */
const DEV_REF = "xssrfshdrtdfupgqwfdw";
const LOGIN = "bizportal_payroll_approver_dev";
let dedicated: ReturnType<typeof createDedicatedPayrollPool> | null = null;
let connectedUrl: string | null = null;

function approvalUrl(): string | null {
  if (process.env.APP_ENV !== "development") return null;
  const raw = process.env.PAYROLL_APPROVAL_DATABASE_URL_DEV?.trim();
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) return null;
  let username: string;
  try { username = decodeURIComponent(url.username); } catch { return null; }
  const host = url.hostname.toLowerCase();
  const direct = host === "db." + DEV_REF + ".supabase.co" && username === LOGIN;
  const pooler = /^aws-[0-9]+-[a-z0-9-]+\\.pooler\\.supabase\\.com$/.test(host) &&
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
  if (previous) await previous.end();
}
