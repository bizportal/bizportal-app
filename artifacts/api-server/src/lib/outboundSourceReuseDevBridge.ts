/**
 * PR95 DEV-only unregistered bridge. No Express route imports this module.
 * A signed OTP Super Admin is DB-revalidated for the requested company
 * before any candidate finance write. The caller still owns BEGIN/COMMIT
 * and rollback on exception, and may run only against an isolated database.
 */
import type { Request } from "express";
import type { OutboundReuseQueryClient } from "./outboundReuseFinalityReader";
import { resolveOutboundSourceReuseDevPrincipal } from "./outboundSourceReuseDevAuth";
import { finalizeOutboundSourceReuseCandidate } from "./outboundSourceReuseCandidate";

export async function runOutboundReuseSignedDevCandidate(
  request: Request,
  tx: OutboundReuseQueryClient,
  input: { companyId: number; mutationId: number; invoiceId: number },
) {
  // This extra opt-in flag is OFF by default and never a substitute for
  // the signed-cookie+DB principal or canonical transaction evidence.
  if (process.env.PR95_OUTBOUND_SOURCE_REUSE_ENABLED_DEV !== "true")
    throw Error("PR95_OUTBOUND_DEV_WRITER_DISABLED");
  const principal = await resolveOutboundSourceReuseDevPrincipal(request,input.companyId);
  if (principal.companyId !== input.companyId || principal.role !== "super_admin")
    throw Error("PR95_OUTBOUND_COMPANY_SCOPE_FORBIDDEN");
  return finalizeOutboundSourceReuseCandidate(tx,{
    companyId:principal.companyId,
    mutationId:input.mutationId,
    invoiceId:input.invoiceId,
    verifiedActorEmail:principal.email,
  });
}
