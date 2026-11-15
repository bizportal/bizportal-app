import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { pool, readMarketplaceFinanceSummaryDev } from "@workspace/db";
import {
  getProductionSession, getProductionUser, isDevelopmentEnvironment,
  type ProductionSession,
} from "./dev-auth";

/**
 * Private CST-DEV-only Finance summary. Separate from the canonical writer:
 * no POST to AP, no payments, no GL, and a READ ONLY DB transaction on GET.
 */
const router = Router();
const COOKIE = "bizportal_finance_readonly_scope";
const PURPOSE = "dev-finance-readonly-company:v1\n";
const WINDOW_MS = 30 * 60 * 1000;

interface ReadOnlyScope {
  version: 1;
  id: string;
  email: string;
  sessionIssuedAt: number;
  companyId: number;
  expiresAt: number;
}

function config(): { origin: string; email: string; companies: number[]; key: string } | null {
  if (process.env.APP_ENV?.trim().toLowerCase() !== "development"
      || !isDevelopmentEnvironment()
      || process.env.BIZPORTAL_FINANCE_READONLY_ENABLED_DEV !== "true"
      || process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV === "true"
      || process.env.BIZPORTAL_SIGNED_PASSWORD_ENABLED_DEV !== "true"
      || process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV === "true") return null;
  const origin = process.env.BIZPORTAL_FINANCE_READONLY_ORIGIN_DEV?.trim() ?? "";
  const email = process.env.BIZPORTAL_FINANCE_READONLY_SUPERADMIN_EMAIL_DEV?.trim().toLowerCase() ?? "";
  const key = process.env.BIZPORTAL_SESSION_SECRET || process.env.SESSION_SECRET || "";
  const companiesRaw = process.env.BIZPORTAL_FINANCE_READONLY_COMPANY_IDS_DEV ?? "";
  const companies = companiesRaw.split(",").map(x => x.trim());
  if (email !== process.env.BIZPORTAL_SIGNED_PASSWORD_ACCOUNT_EMAIL_DEV?.trim().toLowerCase()
      || !email.includes("@") || key.length < 32
      || companies.length !== 2 || new Set(companies).size !== 2
      || !companies.every(x => x === "1" || x === "3")) return null;
  try {
    const url = new URL(origin);
    if (url.origin !== origin || url.protocol !== "https:" || url.username || url.password
        || url.pathname !== "/" || url.search || url.hash) return null;
  } catch { return null; }
  return { origin, email, companies: companies.map(Number), key };
}

function verifiedOrigin(request: Request, origin: string): boolean {
  const hostname = new URL(origin).host.toLowerCase();
  return request.header("origin") === origin
    && request.header("host")?.toLowerCase() === hostname
    && request.header("x-forwarded-proto")?.split(",")[0].trim() === "https"
    && request.header("sec-fetch-site") === "same-origin";
}

function sign(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(PURPOSE + payload).digest("base64url");
}
function getReadOnlyCookie(request: Request): string | null {
  const values = (request.header("cookie") ?? "").split(";")
    .map(part => part.trim()).filter(part => part.startsWith(COOKIE + "="));
  if (values.length !== 1) return null;
  const raw = values[0].slice(COOKIE.length + 1);
  return raw.length <= 2048 && /^[A-Za-z0-9_.-]+$/.test(raw) ? raw : null;
}

function readSelectedCompany(
  request: Request, session: ProductionSession, secret: string, allowed: number[],
): number | null {
  const raw = getReadOnlyCookie(request);
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot), mac = raw.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(mac)) return null;
  const expected = sign(payload, secret);
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const scope = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ReadOnlyScope;
    if (scope?.version !== 1 || scope.id !== session.id || scope.email !== session.email
        || !Number.isFinite(session.issuedAt) || scope.sessionIssuedAt !== session.issuedAt
        || !allowed.includes(scope.companyId) || !Number.isSafeInteger(scope.companyId)
        || !Number.isFinite(scope.expiresAt) || scope.expiresAt <= Date.now()
        || scope.expiresAt > session.expiresAt || scope.expiresAt > Date.now() + WINDOW_MS) {
      return null;
    }
    return scope.companyId;
  } catch { return null; }
}

async function getVerifiedSuperAdmin(request: Request, email: string) {
  const session = getProductionSession(request);
  if (!session) return null;
  const user = await getProductionUser(session);
  if (!user || user.id !== session.id || user.email !== session.email
      || user.role !== "super_admin" || user.companyId !== null || user.email !== email) return null;
  return { session, user };
}

router.post("/mkt/admin/finance-readonly/select-company", async (req, res): Promise<void> => {
  const cfg = config();
  if (!cfg) { res.status(404).json({ error: "Not found" }); return; }
  if (!verifiedOrigin(req, cfg.origin) || !req.is("application/json")) {
    res.status(403).json({ error: "Same-origin HTTPS JSON request required" }); return;
  }
  const body = req.body;
  const companyId = body?.companyId;
  if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).length !== 1
      || !Number.isSafeInteger(companyId) || !cfg.companies.includes(companyId)) {
    res.status(403).json({ error: "Company not approved" }); return;
  }
  try {
    const verified = await getVerifiedSuperAdmin(req, cfg.email);
    if (!verified) { res.status(401).json({ error: "Unauthorized" }); return; }
    const result = await pool.query<{ id: number }>(
      "SELECT id FROM public.companies WHERE id=$1 AND is_active=true LIMIT 1",
      [companyId],
    );
    if (result.rows.length !== 1) {
      res.status(404).json({ error: "Company unavailable" }); return;
    }
    const expiresAt = Math.min(verified.session.expiresAt, Date.now() + WINDOW_MS);
    if (expiresAt <= Date.now() || !Number.isFinite(verified.session.issuedAt)) {
      res.status(401).json({ error: "Session expired" }); return;
    }
    const scope: ReadOnlyScope = {
      version: 1, id: verified.session.id, email: verified.session.email,
      sessionIssuedAt: verified.session.issuedAt, companyId, expiresAt,
    };
    const payload = Buffer.from(JSON.stringify(scope), "utf8").toString("base64url");
    const token = payload + "." + sign(payload, cfg.key);
    const age = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    res.setHeader("Cache-Control", "no-store");
    res.append("Set-Cookie", COOKIE + "=" + token
      + "; Max-Age=" + age + "; Path=/api/mkt/admin/finance-readonly"
      + "; HttpOnly; Secure; SameSite=Strict");
    req.log?.info?.({ companyId }, "DEV Finance read-only company selected");
    res.json({ ok: true, companyId });
  } catch {
    res.status(503).json({ error: "Finance read-only company verification unavailable" });
  }
});

router.get("/mkt/admin/finance-readonly/summary", async (req, res): Promise<void> => {
  const cfg = config();
  if (!cfg) { res.status(404).json({ error: "Not found" }); return; }
  try {
    const verified = await getVerifiedSuperAdmin(req, cfg.email);
    if (!verified) { res.status(401).json({ error: "Unauthorized" }); return; }
    const companyId = readSelectedCompany(req, verified.session, cfg.key, cfg.companies);
    if (companyId === null) {
      res.status(403).json({ error: "Select an approved Finance company" }); return;
    }
    const result = await pool.query<{ id: number }>(
      "SELECT id FROM public.companies WHERE id=$1 AND is_active=true LIMIT 1",
      [companyId],
    );
    if (result.rows.length !== 1) { res.status(403).json({ error: "Company inactive" }); return; }
    const counts = await readMarketplaceFinanceSummaryDev(companyId);
    if (counts.companyId !== companyId) throw new Error("FINANCE_SCOPE_MISMATCH");
    res.setHeader("Cache-Control", "no-store");
    res.json({ mode: "read_only", ...counts });
  } catch {
    res.status(503).json({ error: "Finance read-only summary unavailable" });
  }
});

export default router;
