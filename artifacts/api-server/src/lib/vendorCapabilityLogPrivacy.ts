/** Vendor capabilities belong in request handling, never in persisted logs. */
export function serializeHttpRequestForLog(req: { id?: unknown; method?: unknown; url?: string }) {
  const path = req.url?.split("?")[0];
  return {
    id: req.id,
    method: req.method,
    // Redact the segment regardless of validity, casing, or percent encoding.
    // Keep the operation suffix so upload/list/submit failures remain useful.
    url: path?.replace(/^(\/api\/mkt\/vendor-invoice\/)[^/]*/i, "$1[redacted]"),
  };
}

type VendorOperation = "invoice_list" | "invoice_create" | "invoice_get" | "invoice_submit"
  | "po_token_lookup" | "po_token_mark_used";

export function vendorFailureLog(operation: VendorOperation, error: unknown) {
  let sqlState: string | undefined;
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth++) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      sqlState = candidate.code;
      break;
    }
    current = candidate.cause;
  }
  // Never serialize error.message/stack/query/params/cause. Drizzle errors
  // include the raw vendor token in both their query parameters and message.
  return { operation, errorCode: sqlState ? "VENDOR_DATABASE_ERROR" : "VENDOR_OPERATION_FAILED", sqlState };
}
