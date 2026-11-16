/**
 * Cap only the dedicated PR #81 CST-DEV login's application pool to its
 * PostgreSQL role connection limit (1). The two-session production default
 * and all other DEV application pools retain their original behavior.
 *
 * This is pool sizing, not authorization: it does not activate a NOLOGIN
 * identity, read credentials, broaden RLS, or enable OTP/Finance.
 */
export function computeDatabasePoolMax(
  connectionString: string,
  env: Partial<Record<"APP_ENV" | "NODE_ENV" | "DB_POOL_MAX", string | undefined>>,
): number {
  const configuredPoolMax = Number(env.DB_POOL_MAX);
  const normalMax =
    Number.isFinite(configuredPoolMax) && configuredPoolMax > 0
      ? Math.max(1, Math.min(5, Math.floor(configuredPoolMax)))
      : env.NODE_ENV === "production"
        ? 2
        : 5;

  if (env.APP_ENV?.trim().toLowerCase() !== "development") return normalMax;

  // Supabase direct uses the role name; Supavisor pooler may append the
  // project reference to the same PostgreSQL login role name.
  const login = decodeURIComponent(new URL(connectionString).username);
  const dedicatedRole = "bizportal_pr81_otp_login_dev";
  if (login === dedicatedRole || login.startsWith(dedicatedRole + ".")) {
    return 1;
  }
  return normalMax;
}
