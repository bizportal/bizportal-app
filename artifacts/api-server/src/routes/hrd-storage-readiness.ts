/**
 * PROD HRD private-storage metadata preflight, read only.
 *
 * Does not list, fetch, sign, upload, or delete employee documents. The service
 * credential remains in the server environment and is never returned.
 * Storage/OCR mutation workflows are intentionally NOT imported or mounted.
 */
const HRD_PROD_REF = "nzdweipzckfszczzqtuw";
const HRD_BUCKET = "bizportal-hrd-documents-prod";
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg","image/png","image/webp","application/pdf"]);

export function hrdStorageMetadataPreflightEnabled(): boolean {
  return process.env.APP_ENV?.trim().toLowerCase() === "production" &&
    process.env.HRD_CANONICAL_READONLY_ENABLED === "true" &&
    process.env.HRD_CANONICAL_STORAGE_PREFLIGHT_ENABLED === "true";
}

export async function probeHrdPrivateStorageMetadata(): Promise<boolean> {
  // Flag check must precede any attempt to read credentials or contact Storage.
  if (!hrdStorageMetadataPreflightEnabled()) return false;
  const base = process.env.HRD_PROD_SUPABASE_URL?.trim().replace(/\/$/,"");
  if (base !== `https://${HRD_PROD_REF}.supabase.co`) return false;
  const key = process.env.HRD_PROD_STORAGE_SERVICE_KEY?.trim();
  if (!key) return false;
  try {
    const response = await fetch(`${base}/storage/v1/bucket/${HRD_BUCKET}`,{
      method:"GET",
      headers:{ apikey:key, Authorization:`Bearer ${key}` },
      signal:AbortSignal.timeout(8000),
    });
    if (!response.ok) return false;
    const metadata = await response.json() as {
      id?:unknown; public?:unknown; file_size_limit?:unknown; allowed_mime_types?:unknown;
    };
    const types = metadata.allowed_mime_types;
    return metadata.id === HRD_BUCKET &&
      metadata.public === false &&
      typeof metadata.file_size_limit === "number" &&
      Number.isFinite(metadata.file_size_limit) &&
      metadata.file_size_limit > 0 &&
      metadata.file_size_limit <= MAX_BYTES &&
      Array.isArray(types) && types.length === ALLOWED_TYPES.size &&
      types.every(t=>typeof t==="string" && ALLOWED_TYPES.has(t)) &&
      new Set(types).size === ALLOWED_TYPES.size;
  } catch {
    return false;
  }
}
