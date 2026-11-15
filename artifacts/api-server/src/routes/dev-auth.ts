import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import {
  getRuntimeDatabaseUrl,
  pool,
} from "@workspace/db";

export interface DevAuthUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: string;
  companyId: number | null;
}

interface DevSession extends DevAuthUser {
  issuedAt: number;
  expiresAt: number;
}

export interface ProductionSession {
  id: string;
  email: string;
  issuedAt: number;
  expiresAt: number;
}

const DEV_SESSION_COOKIE = "bizportal_dev_session";
const PRODUCTION_SESSION_COOKIE = "bizportal_supabase_session";
const DEV_SESSION_TTL_SECONDS = 8 * 60 * 60;

export function isDevelopmentEnvironment(): boolean {
  const appEnvironment = process.env.APP_ENV?.trim().toLowerCase();
  const nodeEnvironment = process.env.NODE_ENV?.trim().toLowerCase();

  if (appEnvironment !== undefined) {
    return appEnvironment === "development";
  }

  return nodeEnvironment === "development";
}

let initializedProductionSessionSecret: string | null = null;
let productionSessionInitialization: Promise<void> | null = null;

function deriveProductionSessionSecret(databaseCredential: string): string {
  return crypto
    .createHash("sha256")
    .update("cst-bizportal:production-session:v1\0", "utf8")
    .update(databaseCredential, "utf8")
    .digest("hex");
}

function getExplicitSessionSecret(): string | null {
  for (const candidate of [
    process.env.BIZPORTAL_SESSION_SECRET,
    process.env.SESSION_SECRET,
  ]) {
    const explicitSecret = candidate?.trim();
    if (explicitSecret && explicitSecret.length >= 32) return explicitSecret;
  }
  return null;
}

function getSessionSecret(): string | null {
  return getExplicitSessionSecret() ?? initializedProductionSessionSecret;
}

/** Opt-in only. Never infer DEV OTP eligibility from a cookie or DB credential. */
export function isSignedOtpDevEnabled(): boolean {
  // APP_ENV is the authoritative deployment/DB boundary; NODE_ENV only sets
  // Node's build/runtime mode and may be production for a bundled DEV server.
  return process.env.APP_ENV?.trim().toLowerCase() === "development"
    && isDevelopmentEnvironment()
    && process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV === "true"
    && getExplicitSessionSecret() !== null;
}

export async function initializeProductionSessionSigning(): Promise<void> {
  if (isDevelopmentEnvironment()) return;
  if (getSessionSecret()) return;
  if (productionSessionInitialization) {
    await productionSessionInitialization;
    return;
  }

  productionSessionInitialization = (async () => {
    const explicitSecret = getExplicitSessionSecret();
    if (explicitSecret) {
      initializedProductionSessionSecret = explicitSecret;
      return;
    }

    // Password/OTP login has already proven that the canonical production
    // database path is available. Derive the signing key from that same
    // high-entropy runtime credential instead of making login depend on a
    // second external Secret Manager request. This keeps Hostinger login
    // available during GCP OAuth/Secret Manager latency or outages.
    const databaseCredential = await getRuntimeDatabaseUrl();
    initializedProductionSessionSecret =
      deriveProductionSessionSecret(databaseCredential);
  })();

  try {
    await productionSessionInitialization;
  } finally {
    productionSessionInitialization = null;
  }
}

function getDevIdentitySecret(): string | null {
  const secret = process.env.DEV_IDENTITY_SECRET ?? process.env.SESSION_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

function getAllowedEmails(): string[] {
  const configuredEmails = (process.env.DEV_LOGIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  return configuredEmails;
}

function getDevUsers(): DevAuthUser[] {
  const role = process.env.DEV_LOGIN_ROLE?.trim() || "admin";
  return getAllowedEmails().map((email) => {
    const name = email.split("@", 1)[0].replace(/[._-]+/g, " ").trim();
    const firstName = name ? name.replace(/\b\w/g, (letter) => letter.toUpperCase()) : null;
    return {
      id: `dev:${crypto.createHash("sha256").update(email).digest("hex").slice(0, 16)}`,
      email,
      firstName,
      lastName: null,
      role,
      companyId: null,
    };
  });
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(value: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

export function getDevIdentitySignature(user: DevAuthUser): string | null {
  if (!isDevelopmentEnvironment()) return null;

  const secret = getDevIdentitySecret();
  if (!secret) return null;

  return sign(`${user.email}\n${user.role}`, secret);
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

function setSessionCookie(response: Response, session: DevSession): void {
  const secret = getSessionSecret();
  if (!secret) throw new Error("SESSION_SECRET is unavailable");

  const payload = encode(JSON.stringify(session));
  const value = `${payload}.${sign(payload, secret)}`;
  response.append(
    "Set-Cookie",
    `${DEV_SESSION_COOKIE}=${value}; Max-Age=${DEV_SESSION_TTL_SECONDS}; Path=/; HttpOnly; SameSite=Lax`,
  );
}

export function setProductionSessionCookie(response: Response, session: ProductionSession): void {
  const secret = getSessionSecret();
  if (!secret) throw new Error("SESSION_SECRET is unavailable");

  const payload = encode(JSON.stringify(session));
  const value = `${payload}.${sign(payload, secret)}`;
  const maxAge = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
  response.append(
    "Set-Cookie",
    `${PRODUCTION_SESSION_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`,
  );
}

function clearSessionCookie(response: Response): void {
  response.append(
    "Set-Cookie",
    `${DEV_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`,
  );
}

function clearProductionSessionCookie(response: Response): void {
  response.append(
    "Set-Cookie",
    `${PRODUCTION_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
  );
}

function decodeSignedCookie<T>(request: Request, cookieName: string): T | null {
  const secret = getSessionSecret();
  const raw = getCookie(request, cookieName);
  if (!secret || !raw) return null;

  const separator = raw.lastIndexOf(".");
  if (separator <= 0) return null;

  const payload = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);
  if (!safeEqual(sign(payload, secret), signature)) return null;

  try {
    return JSON.parse(decode(payload)) as T;
  } catch {
    return null;
  }
}

export function getDevSession(request: Request): DevAuthUser | null {
  // Once signed DEV OTP is explicitly enabled, a legacy email-only cookie
  // must never act as fallback authentication for protected routes.
  if (!isDevelopmentEnvironment() || isSignedOtpDevEnabled()) return null;

  const secret = getSessionSecret();
  const raw = getCookie(request, DEV_SESSION_COOKIE);
  if (!secret || !raw) return null;

  const separator = raw.lastIndexOf(".");
  if (separator <= 0) return null;

  const payload = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);
  if (!safeEqual(sign(payload, secret), signature)) return null;

  try {
    const session = JSON.parse(decode(payload)) as DevSession;
    if (
      !session ||
      typeof session.email !== "string" ||
      typeof session.expiresAt !== "number" ||
      session.expiresAt <= Date.now()
    ) {
      return null;
    }

    const configuredUser = getDevUsers().find((user) => user.email === session.email);
    return configuredUser ?? null;
  } catch {
    return null;
  }
}

export function getProductionSession(request: Request): ProductionSession | null {
  if (isDevelopmentEnvironment() && !isSignedOtpDevEnabled()) return null;

  const session = decodeSignedCookie<ProductionSession>(request, PRODUCTION_SESSION_COOKIE);
  if (
    !session ||
    typeof session.id !== "string" ||
    typeof session.email !== "string" ||
    typeof session.expiresAt !== "number" ||
    session.expiresAt <= Date.now()
  ) {
    return null;
  }

  return {
    ...session,
    email: session.email.trim().toLowerCase(),
  };
}

/** DEV-only signed Finance company scope; never an authorization grant by itself. */
const FINANCE_SCOPE_COOKIE = "bizportal_finance_company_scope";
const FINANCE_SCOPE_TTL_MS = 30 * 60 * 1000;
interface FinanceCompanyScope {
  version: 1;
  userId: string;
  email: string;
  sessionIssuedAt: number;
  companyId: number;
  expiresAt: number;
}

export function isFinanceGlobalScopeDevEnabled(): boolean {
  return isSignedOtpDevEnabled()
    && process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV === "true"
    && process.env.BIZPORTAL_FINANCE_GLOBAL_SCOPE_ENABLED_DEV === "true";
}

export function isApprovedFinanceGlobalSuperAdmin(email: string): boolean {
  if (!isFinanceGlobalScopeDevEnabled()) return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) return false;
  return (process.env.BIZPORTAL_FINANCE_GLOBAL_SUPERADMIN_EMAILS_DEV ?? "")
    .split(",").some(value => value.trim().toLowerCase() === normalized);
}

export function isApprovedFinanceGlobalCompany(companyId: number): boolean {
  if (!isFinanceGlobalScopeDevEnabled() || !Number.isSafeInteger(companyId) || companyId <= 0) {
    return false;
  }
  return (process.env.BIZPORTAL_FINANCE_GLOBAL_COMPANY_IDS_DEV ?? "")
    .split(",").some(value => /^[0-9]+$/.test(value.trim()) && Number(value.trim()) === companyId);
}

export function setFinanceCompanyScopeCookie(
  response: Response, session: ProductionSession, companyId: number,
): void {
  if (!isApprovedFinanceGlobalCompany(companyId)) {
    throw new Error("DEV_FINANCE_GLOBAL_SCOPE_DISABLED_OR_INVALID");
  }
  const secret = getExplicitSessionSecret();
  if (!secret) throw new Error("DEV_FINANCE_SCOPE_SESSION_SECRET_MISSING");
  const expiresAt = Math.min(session.expiresAt, Date.now() + FINANCE_SCOPE_TTL_MS);
  if (expiresAt <= Date.now() || !Number.isFinite(session.issuedAt)) {
    throw new Error("DEV_FINANCE_SCOPE_SESSION_INVALID");
  }
  const scope: FinanceCompanyScope = {
    version: 1, userId: session.id, email: session.email.trim().toLowerCase(),
    sessionIssuedAt: session.issuedAt, companyId, expiresAt,
  };
  const payload = encode(JSON.stringify(scope));
  const value = payload + "." + sign("finance-company-scope:v1\n" + payload, secret);
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  response.append("Set-Cookie",
    FINANCE_SCOPE_COOKIE + "=" + value + "; Max-Age=" + maxAge
    + "; Path=/api/mkt/admin; HttpOnly; Secure; SameSite=Strict");
  response.setHeader("Cache-Control", "no-store");
}

export function getFinanceCompanyScope(request: Request, session: ProductionSession): number | null {
  if (!isFinanceGlobalScopeDevEnabled() || session.expiresAt <= Date.now()) return null;
  const secret = getExplicitSessionSecret();
  const raw = getCookie(request, FINANCE_SCOPE_COOKIE);
  if (!secret || !raw) return null;
  const separator = raw.lastIndexOf(".");
  if (separator <= 0) return null;
  const payload = raw.slice(0, separator);
  if (!safeEqual(sign("finance-company-scope:v1\n" + payload, secret), raw.slice(separator + 1))) {
    return null;
  }
  try {
    const scope = JSON.parse(decode(payload)) as FinanceCompanyScope;
    if (scope?.version !== 1 || scope.userId !== session.id
      || scope.email !== session.email.trim().toLowerCase()
      || scope.sessionIssuedAt !== session.issuedAt
      || !isApprovedFinanceGlobalCompany(scope.companyId)
      || typeof scope.expiresAt !== "number" || scope.expiresAt <= Date.now()
      || scope.expiresAt > session.expiresAt
      || scope.expiresAt > Date.now() + FINANCE_SCOPE_TTL_MS) return null;
    return scope.companyId;
  } catch {
    return null;
  }
}

function getSupabaseConfig(): { url: string; anonKey: string } | null {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url: url.replace(/\/+$/, ""), anonKey };
}

async function verifySupabaseAccessToken(accessToken: string): Promise<{
  id: string;
  email: string;
  expiresAt: number;
} | null> {
  const config = getSupabaseConfig();
  if (!config) throw new Error("Supabase Auth configuration is unavailable");

  const response = await fetch(`${config.url}/auth/v1/user`, {
    headers: {
      apikey: config.anonKey,
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) return null;

  const user = await response.json() as {
    id?: unknown;
    email?: unknown;
  };
  if (typeof user.id !== "string" || typeof user.email !== "string") return null;

  const tokenParts = accessToken.split(".");
  let expiresAt = 0;
  let usedOtp = false;
  try {
    const claims = JSON.parse(decode(tokenParts[1] ?? "")) as {
      exp?: unknown;
      amr?: unknown;
    };
    if (typeof claims.exp === "number") expiresAt = claims.exp * 1000;
    usedOtp = Array.isArray(claims.amr) && claims.amr.some((entry) => (
      typeof entry === "object"
      && entry !== null
      && "method" in entry
      && (entry as { method?: unknown }).method === "otp"
    ));
  } catch {
    return null;
  }
  if (!usedOtp || expiresAt <= Date.now()) return null;

  return {
    id: user.id,
    email: user.email.trim().toLowerCase(),
    expiresAt,
  };
}

export async function getProductionUser(session: ProductionSession): Promise<DevAuthUser | null> {
  const signedOtpDev = isSignedOtpDevEnabled();
  // Only DEV signed OTP pins the lookup to the signed account ID as well as
  // email. Duplicate case-insensitive emails must not select a different role.
  // Preserve the existing email-only PROD lookup unchanged.
  const result = signedOtpDev
    ? await pool.query<{ user_data: Record<string, unknown> }>(
      `select to_jsonb(u) user_data
       from public.users u
       where u.id = $1 and lower(coalesce(to_jsonb(u)->>'email', '')) = $2
         and u.is_active = true
         and not exists (
           select 1 from public.users dupe
            where dupe.id <> u.id
              and lower(coalesce(to_jsonb(dupe)->>'email', '')) = $2
              and dupe.is_active = true
         )
       limit 1`,
      [session.id, session.email],
    )
    : await pool.query<{ user_data: Record<string, unknown> }>(
      `select to_jsonb(u) user_data
       from public.users u
       where lower(coalesce(to_jsonb(u)->>'email', '')) = $1
       limit 1`,
      [session.email],
    );
  // Pinned signed ID and email must identify one active account; historical
  // inactive email shadows are ignored but competing active accounts deny OTP.
  if (signedOtpDev && result.rows.length !== 1) return null;
  const userData = result.rows[0]?.user_data;
  if (!userData) return null;
  // Revalidate active account state on every authenticated request. A signed
  // cookie must not preserve access after HRD/admin deactivates the account.
  if (userData.is_active !== true && userData.isActive !== true) return null;
  const accountStatus = typeof userData.status === "string"
    ? userData.status.trim().toLowerCase()
    : typeof userData.user_status === "string"
      ? userData.user_status.trim().toLowerCase()
      : null;
  if (accountStatus !== null && accountStatus !== "active") return null;

  const email = typeof userData.email === "string" ? userData.email.trim().toLowerCase() : "";
  const role = typeof userData.role === "string" ? userData.role.trim().toLowerCase() : "";
  if (email !== session.email || !role) return null;
  // DEV opt-in must fail closed for inactive or mismatched account IDs.
  // Keep the existing PROD session lookup behavior unchanged.
  if (signedOtpDev) {
    const status = typeof userData.status === "string"
      ? userData.status.trim().toLowerCase()
      : null;
    if (userData.is_active !== true || (status !== null && status !== "active")) {
      return null;
    }
    // DEV OTP sessions bind both the account ID and email. If the address is
    // reassigned to another account, the previous signed session must expire.
    if (typeof userData.id !== "string" || userData.id !== session.id) {
      return null;
    }
  }

  const rawCompanyId = userData.company_id ?? userData.companyId;
  const parsedCompanyId = rawCompanyId === null || rawCompanyId === undefined
    ? null
    : Number(rawCompanyId);
  return {
    id: session.id,
    email,
    firstName: typeof userData.first_name === "string" ? userData.first_name : null,
    lastName: typeof userData.last_name === "string" ? userData.last_name : null,
    role,
    companyId: parsedCompanyId !== null && Number.isInteger(parsedCompanyId) && parsedCompanyId > 0
      ? parsedCompanyId
      : null,
  };
}

function getSafeRedirect(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  return value;
}

export function createDevAuthRouter(): Router {
  const router = Router();

  router.post("/auth/supabase-exchange", async (request, response): Promise<void> => {
    if (isDevelopmentEnvironment()) {
      response.status(404).json({ error: "Not found" });
      return;
    }

    const accessToken =
      typeof request.body?.access_token === "string"
        ? request.body.access_token.trim()
        : "";
    if (!accessToken) {
      response.status(401).json({ error: "Session Supabase tidak tersedia." });
      return;
    }
    if (!getSessionSecret()) {
      response.status(503).json({ error: "Konfigurasi session server belum tersedia." });
      return;
    }

    try {
      const verified = await verifySupabaseAccessToken(accessToken);
      if (!verified) {
        response.status(401).json({ error: "Session Supabase tidak valid atau sudah berakhir." });
        return;
      }

      const now = Date.now();
      const productionSession = {
        id: verified.id,
        email: verified.email,
        issuedAt: now,
        expiresAt: verified.expiresAt,
      };
      const user = await getProductionUser(productionSession);
      if (!user || user.role !== "admin") {
        response.status(403).json({
          error: "Email atau kode OTP tidak dapat digunakan untuk login admin.",
        });
        return;
      }

      setProductionSessionCookie(response, productionSession);
      response.json({ user });
    } catch (error) {
      request.log.error({ error }, "Supabase access token verification failed");
      response.status(503).json({ error: "Verifikasi session Supabase tidak tersedia." });
    }
  });

  router.get("/auth/dev-users", (_request, response) => {
    // DEV-only identity enumeration is not part of signed OTP auth.
    if (!isDevelopmentEnvironment() || isSignedOtpDevEnabled()) {
      return response.status(404).json({ error: "Not found" });
    }
    return response.json({ users: getDevUsers() });
  });

  router.post("/auth/dev-login", async (request, response) => {
    // Never issue an email-only DEV session when signed OTP is required.
    // Legacy local/test login remains unchanged while OTP is OFF.
    if (!isDevelopmentEnvironment() || isSignedOtpDevEnabled()) {
      return response.status(404).json({ error: "Not found" });
    }

    const email =
      typeof request.body?.email === "string"
        ? request.body.email.trim().toLowerCase()
        : "";
    const configuredUsers = getDevUsers();
    // An empty email is the intentional development auto-login path. Prefer
    // an explicitly configured admin, then fall back to the first dev user.
    const user = email
      ? configuredUsers.find((candidate) => candidate.email === email)
      : configuredUsers.find((candidate) => candidate.role === "admin") ?? configuredUsers[0];

    if (!getSessionSecret()) {
      return response.status(503).json({
        error: "Dev login belum aktif: SESSION_SECRET harus tersedia.",
      });
    }
    if (configuredUsers.length === 0) {
      return response.status(503).json({
        error: "Dev login belum dikonfigurasi: DEV_LOGIN_EMAILS masih kosong.",
      });
    }
    if (!user) {
      return response.status(403).json({
        error: "Email belum diizinkan untuk Dev Login.",
      });
    }

    const now = Date.now();
    setSessionCookie(response, {
      ...user,
      issuedAt: now,
      expiresAt: now + DEV_SESSION_TTL_SECONDS * 1000,
    });
    return response.json({ user });
  });

  router.get("/auth/user", async (request, response, next): Promise<void> => {
    if (!isDevelopmentEnvironment()) {
      const session = getProductionSession(request);
      if (!session) {
        response.status(401).json({ error: "Unauthorized" });
        return;
      }
      try {
        const user = await getProductionUser(session);
        if (!user) {
          response.status(403).json({ error: "Forbidden" });
          return;
        }
        response.json({ user });
      } catch (error) {
        request.log.error({ error }, "Failed to load production auth user");
        response.status(503).json({ error: "Authorization service unavailable" });
      }
      return;
    }

    // When OTP is enabled, prefer its verified identity over a legacy cookie.
    if (isSignedOtpDevEnabled()) {
      const signed = getProductionSession(request);
      if (signed) {
        try {
          const verifiedUser = await getProductionUser(signed);
          if (!verifiedUser) {
            response.status(403).json({ error: "Forbidden" });
            return;
          }
          response.json({ user: verifiedUser });
          return;
        } catch (error) {
          request.log?.error?.({ error }, "DEV signed OTP user lookup unavailable");
          response.status(503).json({ error: "Authorization service unavailable" });
          return;
        }
      }
    }
    const legacyUser = getDevSession(request);
    if (legacyUser) {
      response.json({ user: legacyUser });
      return;
    }
    next();
  });

  router.get("/users/me", async (request, response, next) => {
    if (!isDevelopmentEnvironment()) return next();

    let user: DevAuthUser | null = null;
    if (isSignedOtpDevEnabled()) {
      const signed = getProductionSession(request);
      if (signed) {
        try {
          user = await getProductionUser(signed);
          if (!user) {
            response.status(403).json({ error: "Forbidden" });
            return;
          }
        } catch (error) {
          request.log?.error?.({ error }, "DEV signed OTP profile unavailable");
          response.status(503).json({ error: "Authorization service unavailable" });
          return;
        }
      }
    }
    user ??= getDevSession(request);
    if (!user) return next();

    return response.json({
      id: user.id,
      email: user.email,
      name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email,
      role: user.role,
    });
  });

  router.get("/logout", (request, response) => {
    // Logout must also work for expired sessions and valid OTP/password sessions in DEV.
    // Clearing cookies does not grant access or change the login authorization gates.
    if (isDevelopmentEnvironment()) {
      clearSessionCookie(response);
    }
    clearProductionSessionCookie(response);
    return response.redirect(getSafeRedirect(request.query.redirect));
  });

  return router;
}