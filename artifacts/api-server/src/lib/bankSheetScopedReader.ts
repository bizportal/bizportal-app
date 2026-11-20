import { createDedicatedPayrollPool } from "@workspace/db";

type SheetReaderPool = ReturnType<typeof createDedicatedPayrollPool>;
const readers = new Map<number, { url: string; pool: SheetReaderPool }>();

const identities: Record<number, { key: string; username: string }> = {
  1: {
    key: "PR147_BANK_SHEET_CST_DATABASE_URL_DEV",
    username: "bizportal_finance_cst_login_dev.xssrfshdrtdfupgqwfdw",
  },
  3: {
    key: "PR147_BANK_SHEET_DIVA_DATABASE_URL_DEV",
    username: "bizportal_finance_diva_login_dev.xssrfshdrtdfupgqwfdw",
  },
};

/**
 * DEV source-only Sheet GET uses a dedicated read-only company principal.
 * Never fall back to the OTP/general app pool, postgres or service_role.
 * This function does not grant DB permissions; the scoped RLS policy must
 * be approved and applied separately after the isolated migration gates pass.
 */
export function getDevBankSheetReader(companyId: number): SheetReaderPool {
  if (process.env.APP_ENV?.trim().toLowerCase() !== "development") {
    throw new Error("PR147_DEV_SHEET_READER_ENVIRONMENT_REQUIRED");
  }
  const identity = identities[companyId];
  if (!identity) throw new Error("PR147_DEV_SHEET_READER_COMPANY_UNSUPPORTED");
  const raw = process.env[identity.key];
  if (!raw) throw new Error("PR147_DEV_SHEET_READER_NOT_CONFIGURED");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("PR147_DEV_SHEET_READER_URL_INVALID");
  }
  if (parsed.protocol !== "postgresql:"
    || decodeURIComponent(parsed.username) !== identity.username
    || parsed.hostname !== "aws-0-ap-southeast-1.pooler.supabase.com"
    || parsed.port !== "6543"
    || parsed.pathname !== "/postgres"
    || !parsed.password) {
    throw new Error("PR147_DEV_SHEET_READER_IDENTITY_MISMATCH");
  }
  const existing = readers.get(companyId);
  if (existing?.url === raw) return existing.pool;
  if (existing) {
    // Replacing a credential closes the previous idle pool; never log URLs.
    void existing.pool.end().catch(() => undefined);
  }
  const pool = createDedicatedPayrollPool(raw);
  readers.set(companyId, { url: raw, pool });
  return pool;
}

/** Test/isolated shutdown only. */
export async function closeDevBankSheetReaders(): Promise<void> {
  const current = [...readers.values()];
  readers.clear();
  await Promise.all(current.map(async (reader) => reader.pool.end()));
}
