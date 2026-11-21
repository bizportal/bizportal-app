import {
  extractDatabaseUrl,
  getDatabaseSecretName,
  readSecret,
  validateDatabaseUrl,
} from "./gcp-database-secret";

type AppEnvironment = "development" | "production";

const DEV_SUPABASE_PROJECT_REF = "xssrfshdrtdfupgqwfdw";
const PROD_SUPABASE_PROJECT_REF = "nzdweipzckfszczzqtuw";

function resolveAppEnvironment(): AppEnvironment {
  const appEnv = process.env.APP_ENV?.trim().toLowerCase();

  if (appEnv === "development" || appEnv === "production") {
    return appEnv;
  }

  if (!appEnv) {
    throw new Error(
      'APP_ENV is required and must be explicitly set to "development" or "production". Refusing to infer database target from NODE_ENV.',
    );
  }

  throw new Error(
    `Unsupported APP_ENV="${process.env.APP_ENV}". Expected "development" or "production".`,
  );
}

function isProductionEnvironment(): boolean {
  return resolveAppEnvironment() === "production";
}

function assertExpectedSupabaseProject(
  value: string,
  environment: AppEnvironment,
  source: string,
): string {
  const expectedRef =
    environment === "production"
      ? PROD_SUPABASE_PROJECT_REF
      : DEV_SUPABASE_PROJECT_REF;

  const forbiddenRef =
    environment === "production"
      ? DEV_SUPABASE_PROJECT_REF
      : PROD_SUPABASE_PROJECT_REF;

  const parsed = new URL(value);
  const hostname = parsed.hostname.toLowerCase();
  const username = decodeURIComponent(parsed.username).toLowerCase();
  const haystack = `${hostname} ${username}`;

  if (haystack.includes(forbiddenRef)) {
    throw new Error(
      `${source} points to the opposite environment Supabase project (${forbiddenRef}); refusing database connection`,
    );
  }

  if (!haystack.includes(expectedRef)) {
    throw new Error(
      `${source} does not identify the expected ${environment.toUpperCase()} Supabase project (${expectedRef}); refusing database connection`,
    );
  }

  return value;
}

/**
 * Exact CST-DEV-only recovery for a saturated Supavisor session pool (5432).
 * Transaction mode (6543) has passed a native read-only PostgreSQL probe.
 * Never rewrite a direct URL, another tenant, an alternate host, or PROD.
 * Preserve user, password, query string and TLS parameters byte-for-byte.
 */
export function recoverCstDevSessionPoolerUrl(value: string, environment: AppEnvironment): string {
  if (environment !== "development") return value;
  const url = new URL(value);
  if (url.hostname.toLowerCase() !== "aws-1-ap-southeast-2.pooler.supabase.com" ||
      decodeURIComponent(url.username).toLowerCase() !== "postgres." + DEV_SUPABASE_PROJECT_REF ||
      url.port !== "5432") return value;

  // Change only the port without URL reserialization (sensitive credentials
  // must never be logged, normalized, or exposed via a diagnostic response).
  const protocolAndHost = value.match(
    /^(postgres(?:ql)?:\/\/[^/?#@]+@aws-1-ap-southeast-2\.pooler\.supabase\.com):5432(?=[/?#]|$)/i,
  );
  if (!protocolAndHost) return value;
  return value.replace(protocolAndHost[0], protocolAndHost[1] + ":6543");
}

function validateEnvironmentDatabaseUrl(
  value: string,
  environment: AppEnvironment,
  source: string,
): string {
  const validated = validateDatabaseUrl(value, source);
  const scoped = assertExpectedSupabaseProject(validated, environment, source);
  return recoverCstDevSessionPoolerUrl(scoped, environment);
}

/**
 * Return the synchronous environment-only database URL.
 *
 * APP_ENV is mandatory and authoritative. NODE_ENV only controls the runtime
 * build mode and must never decide which database is selected.
 */
export function getDatabaseUrl(): string | undefined {
  const isProduction = isProductionEnvironment();

  if (isProduction) {
    return process.env.SUPABASE_DATABASE_URL;
  }

  return process.env.SUPABASE_DATABASE_URL_DEV;
}

export async function resolveDatabaseUrl(): Promise<string> {
  const environment = resolveAppEnvironment();
  const environmentUrl = getDatabaseUrl()?.trim();

  if (environmentUrl) {
    return validateEnvironmentDatabaseUrl(
      environmentUrl,
      environment,
      `${environment.toUpperCase()} database environment variable`,
    );
  }

  const isProduction = environment === "production";
  const secretKey = isProduction
    ? "SUPABASE_DATABASE_URL"
    : "SUPABASE_DATABASE_URL_DEV";
  const secretName = getDatabaseSecretName(isProduction);
  const secretValue = await readSecret(secretName);
  const databaseUrl = extractDatabaseUrl(secretValue, secretKey);

  if (!databaseUrl) {
    throw new Error(
      `GCP secret ${secretName} does not contain ${secretKey}; refusing to fall back to the opposite environment database`,
    );
  }

  return validateEnvironmentDatabaseUrl(
    databaseUrl,
    environment,
    `GCP secret ${secretName}.${secretKey}`,
  );
}
