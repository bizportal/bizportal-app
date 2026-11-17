/**
 * PR95 outbound source reuse authentication gate — DEV ONLY, UNREGISTERED.
 * Reuses canonical signed OTP cookie and DB-revalidated user identity.
 * Never accepts x-company-id, email, role, or user id from a request body.
 * No legacy getDevSession fallback. No real finance route is registered.
 */
import type { Request } from "express";
import {
  getProductionSession,
  getProductionUser,
  isDevelopmentEnvironment,
  isSignedOtpDevEnabled,
  type DevAuthUser,
} from "../routes/dev-auth";

export type VerifiedOutboundPrincipal = Readonly<{
  id: string;
  email: string;
  companyId: number;
  role: "super_admin";
}>;

export function assertOutboundSuperAdminIdentity(
  identity: DevAuthUser | null,
  session: { id: string; email: string } | null,
  requestedCompanyId: number,
): VerifiedOutboundPrincipal {
  if (!Number.isSafeInteger(requestedCompanyId) || requestedCompanyId <= 0)
    throw Error("PR95_OUTBOUND_COMPANY_INVALID");
  if (!session || !identity)
    throw Error("PR95_OUTBOUND_SIGNED_SESSION_REQUIRED");
  if (!session.id || identity.id !== session.id
    || identity.email !== session.email.trim().toLowerCase())
    throw Error("PR95_OUTBOUND_SESSION_IDENTITY_MISMATCH");
  if (identity.role !== "super_admin")
    throw Error("PR95_OUTBOUND_SUPER_ADMIN_REQUIRED");
  if (identity.companyId !== requestedCompanyId)
    throw Error("PR95_OUTBOUND_COMPANY_SCOPE_FORBIDDEN");
  if (!identity.email || identity.email.trim() !== identity.email
    || identity.email !== identity.email.toLowerCase())
    throw Error("PR95_OUTBOUND_INVALID_EMAIL");
  return {
    id: identity.id,
    email: identity.email,
    companyId: identity.companyId,
    role: "super_admin",
  };
}

/**
 * Only used from a future authenticated DEV router after explicit opt-in.
 * Session verification and database identity lookup run on every invocation.
 * Caller still must BEGIN and commit/rollback the actual finance transaction.
 */
export async function resolveOutboundSourceReuseDevPrincipal(
  request: Request,
  requestedCompanyId: number,
): Promise<VerifiedOutboundPrincipal> {
  if (!isDevelopmentEnvironment() || !isSignedOtpDevEnabled())
    throw Error("PR95_OUTBOUND_SIGNED_OTP_DEV_DISABLED");
  const session = getProductionSession(request);
  if (!session) throw Error("PR95_OUTBOUND_SIGNED_SESSION_REQUIRED");
  const identity = await getProductionUser(session);
  return assertOutboundSuperAdminIdentity(identity,session,requestedCompanyId);
}
