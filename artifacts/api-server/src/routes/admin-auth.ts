import type { NextFunction, Request, Response } from "express";
import {
  getDevSession,
  getProductionSession,
  getProductionUser,
  isDevelopmentEnvironment,
  isSignedOtpDevEnabled,
  type DevAuthUser,
} from "./dev-auth";

export type AdminRequest = Request & { adminUser?: DevAuthUser };

const ADMIN_ROLES = new Set(["admin", "owner", "super_admin", "finance", "accounting"]);

export async function authenticateAdmin(
  request: AdminRequest,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const devActor = isDevelopmentEnvironment() ? getDevSession(request) : null;
    const signedSession = (!isDevelopmentEnvironment() || isSignedOtpDevEnabled())
      ? getProductionSession(request)
      : null;
    // Prefer the DB-verified signed identity when both DEV cookies coexist.
    // A rejected signed identity must never fall back to the legacy actor.
    const resolvedUser = signedSession ? await getProductionUser(signedSession) : devActor;

    if (!resolvedUser) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!ADMIN_ROLES.has(resolvedUser.role.toLowerCase())) {
      response.status(403).json({ error: "Forbidden" });
      return;
    }

    request.adminUser = resolvedUser;
    next();
  } catch (error) {
    request.log.error({ error }, "Admin API authorization failed");
    response.status(503).json({ error: "Authorization service unavailable." });
  }
}