import { Pool } from "pg";

type SheetReaderPool = Pool;
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
    // Actual CST-DEV Supavisor endpoint verified from active DEV runtime.
    // Both Supavisor session (5432) and transaction (6543) modes are allowed,
    // but no arbitrary host, project, direct DB, or other port is permitted.
    || parsed.hostname !== "aws-1-ap-southeast-2.pooler.supabase.com"
    || !["5432", "6543"].includes(parsed.port)
    || parsed.pathname !== "/postgres"
    || !parsed.password) {
    throw new Error("PR147_DEV_SHEET_READER_IDENTITY_MISMATCH");
  }
  // Reject query overrides; SSL is pinned in explicit Pool options below.
  // A visible verify-full requirement prevents accidentally accepting URLs
  // that elsewhere would permit plaintext, disabled verification or overrides.
  if (parsed.searchParams.get("sslmode") !== "verify-full"
      || [...parsed.searchParams.keys()].some((key) => key !== "sslmode")) {
    throw new Error("PR147_DEV_SHEET_READER_TLS_REQUIRED");
  }
  const existing = readers.get(companyId);
  if (existing?.url === raw) return existing.pool;
  if (existing) {
    // A secret rotation requires a controlled process restart. Do not swap
    // authenticated pools while requests may still use old connections.
    throw new Error("PR147_DEV_SHEET_READER_CREDENTIAL_CHANGED_RESTART_REQUIRED");
  }
  // Explicit connection fields avoid pg-connection-string SSL query parsing.
  // Node TLS verifies the certificate chain and the exact Supavisor hostname.
  const pool = new Pool({
    host: parsed.hostname,
    port: Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: "postgres",
    ssl: { rejectUnauthorized: true, servername: parsed.hostname },
    max: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 8_000,
    query_timeout: 15_000,
    application_name: "bizportal-pr147-sheet-reader-dev",
  });
  readers.set(companyId, { url: raw, pool });
  return pool;
}

/** Test/isolated shutdown only. */
export async function closeDevBankSheetReaders(): Promise<void> {
  const current = [...readers.values()];
  readers.clear();
  await Promise.all(current.map(async (reader) => reader.pool.end()));
}
