import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getRuntimeDatabaseUrl, pool } from "@workspace/db";
import { resolveSmtpConfig } from "../lib/smtp";
import {
  initializeProductionSessionSigning,
  isDevelopmentEnvironment,
} from "./dev-auth";

const router: IRouter = Router();
const STARTUP_MODE = "nonblocking-session-init-v2";

type ReadinessPhase = "database-configuration" | "database-probe" | "session-signing";

/** Never send or log raw database/GCP errors from a public health endpoint.
 * A lazy DB pool may fail while resolving its GCP secret BEFORE connecting to
 * PostgreSQL. Explicit phases distinguish that from the actual read-only ping.
 */
function safeReadinessReason(error: unknown, phase: ReadinessPhase): string {
  if (phase === "session-signing") return "HEALTH_SESSION_NOT_READY";
  let value: unknown = error;
  const messages: string[] = [], codes: string[] = [];
  for (let depth = 0; depth < 4 && value && typeof value === "object"; depth++) {
    const e = value as { message?: unknown; code?: unknown; cause?: unknown };
    if (typeof e.message === "string") messages.push(e.message.slice(0, 4096));
    if (typeof e.code === "string") codes.push(e.code.toUpperCase());
    value = e.cause;
  }
  const message = messages.join(" ").toLowerCase();
  // Supavisor rejects otherwise-valid clients after repeated password
  // failures originating from the same VPS. Report the shared auth breaker
  // separately from bad credentials on this specific DB connection.
  if (/circuit breaker open|too many authentication failures|new connections are temporarily blocked/.test(message))
    return "HEALTH_POOLER_AUTH_CIRCUIT_OPEN";
  if (codes.some(code => ["28P01", "28000"].includes(code)) ||
      /password authentication failed|authentication rejected/.test(message))
    return "HEALTH_DATABASE_AUTH_REJECTED";
  if (codes.includes("53300") || /too many clients|remaining connection slots/.test(message))
    return "HEALTH_DB_CONNECTION_LIMIT";
  if (codes.some(code => ["ENOTFOUND", "EAI_AGAIN"].includes(code)))
    return "HEALTH_NETWORK_DNS_FAILED";
  if (codes.some(code => ["ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN"].includes(code)) ||
      /certificate verify failed/.test(message)) return "HEALTH_TLS_FAILED";
  if (/dev_systemd_gcp_credential_unavailable|gcp_secret_manager_bootstrap_json/.test(message))
    return "HEALTH_CREDENTIAL_NOT_READY";
  if (/gcp oauth token request failed|gcp oauth response/.test(message))
    return "HEALTH_GCP_OAUTH_NOT_READY";
  if (/gcp secret manager read failed|gcp secret .* has no payload/.test(message))
    return "HEALTH_GCP_SECRET_NOT_READY";
  if (codes.some(code => ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) ||
      /connection timeout|connection timed out|timeout expired|timeout exceeded/.test(message))
    return "HEALTH_CONNECT_TIMEOUT";
  if (phase === "database-configuration") return "HEALTH_DATABASE_CONFIG_UNAVAILABLE";
  return "HEALTH_DATABASE_UNAVAILABLE";
}

router.get("/health/live", (_req, res) => {
  res.json({ status: "ok", startupMode: STARTUP_MODE });
});

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/health/smtp", async (_req, res) => {
  try {
    const config = await resolveSmtpConfig();
    res.json({
      status: "ok",
      ready: true,
      source: config.source,
    });
  } catch {
    res.status(503).json({
      status: "degraded",
      ready: false,
    });
  }
});

router.get("/health/ready", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  let phase: ReadinessPhase = "database-configuration";
  try {
    // Create the lazy pool / resolve GCP first, then test the real PostgreSQL
    // query. Previously both happened inside pool.query, obscuring whether a
    // cold-start secret fetch or an actual DB ping caused the failure.
    const runtimeDatabaseUrl = await getRuntimeDatabaseUrl();
    phase = "database-probe";
    await pool.query<{ ok: number }>("select 1 as ok");
    phase = "session-signing";
    if (!isDevelopmentEnvironment()) {
      await initializeProductionSessionSigning();
    }
    res.json({
      status: "ok",
      ready: true,
      database: "connected",
      authSessionSigning: "ready",
      databaseProvider: runtimeDatabaseUrl.includes("supabase") ? "supabase" : "postgres",
      startupMode: STARTUP_MODE,
    });
  } catch (error) {
    const reasonCode = safeReadinessReason(error, phase);
    // Only fixed, non-sensitive codes enter application logs and responses.
    req.log?.warn?.({ phase, reasonCode }, "Readiness dependency unavailable");
    res.status(503).json({
      status: "degraded",
      ready: false,
      database: "unavailable-or-auth-not-ready",
      authSessionSigning: "not-ready",
      phase,
      reasonCode,
      startupMode: STARTUP_MODE,
    });
  }
});

export default router;
