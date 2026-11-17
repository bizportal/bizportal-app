import { withMarketplaceFinanceDevReadOnlyTransaction } from "@workspace/db";
import { findPoByVendorToken, type TokenLookupResult } from "./mktVendorPoTokenService.js";

/** Bootstrap a vendor capability using only the fixed, isolated DEV readers.
 * The authentication pool has no PO read grant. Company identity is discovered
 * by exact token lookup, then rechecked by the existing writer transaction.
 * Neither the request nor an elevated fallback can select a database identity.
 */
export async function resolveVendorInvoiceToken(token: string): Promise<TokenLookupResult> {
  if (process.env.APP_ENV?.trim().toLowerCase() !== "development" ||
      process.env.BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV !== "true") {
    return findPoByVendorToken(token);
  }
  // Customer Portal already issues 24-byte / 48-hex PO links, while canonical
  // BizPortal issues 32-byte / 64-hex. Exact-length only, never prefix match.
  if (!/^(?:[0-9a-f]{48}|[0-9a-f]{64})$/i.test(token)) return { ok: false, code: "MALFORMED" };
  const results = await Promise.all(([1, 3] as const).map(companyId =>
    withMarketplaceFinanceDevReadOnlyTransaction(companyId, async scopedDb => {
      const result = await findPoByVendorToken(token, scopedDb);
      if (result.ok && result.po.companyId !== companyId) {
        throw new Error("DEV_FINANCE_VENDOR_TOKEN_COMPANY_MISMATCH");
      }
      return result;
    }),
  ));
  const found = results.filter((result): result is Extract<TokenLookupResult, { ok: true }> => result.ok);
  if (found.length > 1) throw new Error("DEV_FINANCE_VENDOR_TOKEN_AMBIGUOUS");
  if (found.length === 1) return found[0]!;
  return { ok: false, code: results.some(result => !result.ok && result.code === "EXPIRED") ? "EXPIRED" : "NOT_FOUND" };
}
