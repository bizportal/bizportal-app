import { isAbsolute } from "node:path";
import { createDedicatedPayrollPool, readSecret } from "@workspace/db";
import { isSignedOtpDevEnabled } from "./dev-auth";
import { loadDevPayrollNativeArtifact } from "./payroll-accounting-native-runtime";
import { bindDevPayrollAtomicHttpRuntime } from "./payroll-accounting-http";

/** DEV startup assembly; default OFF, no database/secret fallback or DDL.
 * Uses the existing managed-secret reader and dedicated pool factory. Artifact
 * fingerprint and origin are trusted deployment configuration, never HTTP input.
 * A successful bind is structural readiness, NOT approval or financial posting.
 */
const DEV_REF = "xssrfshdrtdfupgqwfdw";
const LOGIN = "bizportal_payroll_settlement_dev";
let installed: string | null = null;
let initializing: { key: string; promise: Promise<boolean> } | null = null;
const enabled = () => process.env.APP_ENV === "development" &&
  process.env.PAYROLL_DEV_ATOMIC_ROUTE_MOUNT_ENABLED === "true" &&
  process.env.PAYROLL_DEV_ATOMIC_POSTING_ENABLED === "true";
function rejected(): never { throw Error("PAYROLL_NATIVE_BOOTSTRAP_UNAVAILABLE"); }

function configuration() {
  const secretName = process.env.PAYROLL_SETTLEMENT_GCP_SECRET_NAME_DEV?.trim();
  const artifactPath = process.env.PAYROLL_DEV_ATOMIC_NATIVE_ARTIFACT_PATH?.trim();
  const digest = process.env.PAYROLL_DEV_ATOMIC_NATIVE_SHA256?.trim();
  const origin = process.env.PAYROLL_DEV_ATOMIC_ALLOWED_ORIGIN?.trim();
  if (!secretName || !/^bizportal-payroll-settlement-dev(?:-[a-z0-9-]+)?$/.test(secretName) ||
      process.env.PAYROLL_SETTLEMENT_DATABASE_URL_DEV?.trim() ||
      !artifactPath || !isAbsolute(artifactPath) || !artifactPath.endsWith(".mjs") ||
      !digest || !/^[0-9a-f]{64}$/.test(digest) || !origin) rejected();
  let parsed: URL;
  try { parsed = new URL(origin); } catch { rejected(); }
  if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.username || parsed.password ||
      parsed.pathname !== "/" || parsed.search || parsed.hash) rejected();
  return { secretName, artifactPath, digest, origin };
}
function settlementUrl(raw: string): string {
  let u: URL, login: string;
  try { u = new URL(raw); login = decodeURIComponent(u.username); } catch { rejected(); }
  const direct = u.hostname === "db." + DEV_REF + ".supabase.co" && login === LOGIN &&
    (u.port || "5432") === "5432";
  const pooler = /^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(u.hostname) &&
    login === LOGIN + "." + DEV_REF && ["5432", "6543"].includes(u.port || "5432");
  if (!["postgres:", "postgresql:"].includes(u.protocol) || !(direct || pooler) || !u.password ||
      u.pathname !== "/postgres" || u.hash ||
      [...u.searchParams.keys()].some(k => k !== "sslmode" && k !== "sslrootcert") ||
      u.searchParams.getAll("sslmode").length !== 1 || u.searchParams.get("sslmode") !== "verify-full" ||
      u.searchParams.getAll("sslrootcert").length > 1) rejected();
  return raw;
}

export async function prepareDevPayrollAtomicRuntime(): Promise<boolean> {
  if (!enabled()) return false;
  if (!isSignedOtpDevEnabled()) rejected();
  const cfg = configuration(), key = JSON.stringify(cfg);
  if (installed) { if (installed !== key) rejected(); return true; }
  if (initializing) { if (initializing.key !== key) rejected(); return initializing.promise; }
  const promise = (async () => {
    let pool: ReturnType<typeof createDedicatedPayrollPool> | null = null;
    try {
      // Validate executable bytes before retrieving any database credential.
      const writer = await loadDevPayrollNativeArtifact(cfg.artifactPath, cfg.digest);
      if (!enabled() || !isSignedOtpDevEnabled() || JSON.stringify(configuration()) !== key) rejected();
      const raw = await readSecret(cfg.secretName);
      if (typeof raw !== "string" || raw.length > 16_384) rejected();
      const url = settlementUrl(raw.trim());
      if (!enabled() || !isSignedOtpDevEnabled() || JSON.stringify(configuration()) !== key) rejected();
      pool = createDedicatedPayrollPool(url);
      // Existing binder checks direct role, read-only catalog snapshot and ACLs
      // before publishing. No salary/ledger writes or user session are created.
      await bindDevPayrollAtomicHttpRuntime({ pool, writer, allowedOrigin: cfg.origin });
      installed = key;
      return true;
    } catch {
      if (pool) { try { await pool.end(); } catch { /* original failure stays redacted */ } }
      rejected();
    }
  })();
  initializing = { key, promise };
  try { return await promise; }
  finally { if (initializing?.promise === promise) initializing = null; }
}
