import type { PoolConfig } from "pg";

// Public Supabase Root 2021 CA, obtained from the CST-DEV Database Settings
// Download certificate link on 2026-11-28:
// https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt
// SHA256 80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA
// Expiry 2031-04-26. Replace only with an independently verified official CA
// when Supabase rotates its database certificate chain.
const SUPABASE_CA = "-----BEGIN CERTIFICATE-----\nMIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL\nBQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l\ndyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh\nc2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow\nazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD\nYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug\nUm9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW\nQyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q\nDmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2\nGtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi\ncvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4\nO4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt\nNaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX\nuXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt\naUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU\ntVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b\nVW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6\njB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx\nCea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2\nCMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P\no/bKiIz+Fq8=\n-----END CERTIFICATE-----\n";
const DEV_HOST = "db.xssrfshdrtdfupgqwfdw.supabase.co";

/** Only the dedicated DEV Payroll direct connection needs this private CA.
 * pg merges SSL options parsed from the URL over the explicit TLS options.
 * Remove the accepted sslmode parameter before passing the CA to the driver.
 * Other connections, including shared BizPortal and PROD, remain unchanged.
 */
export function payrollDedicatedConnectionConfig(connectionString: string, appEnv: string | undefined): Pick<PoolConfig, "connectionString" | "ssl"> {
  if (appEnv !== "development") return { connectionString };
  const u = new URL(connectionString);
  if (u.hostname !== DEV_HOST) return { connectionString };
  const modes = u.searchParams.getAll("sslmode");
  if (!["postgres:", "postgresql:"].includes(u.protocol) ||
      decodeURIComponent(u.username) !== "bizportal_payroll_dev" ||
      (u.port !== "" && u.port !== "5432") || u.pathname !== "/postgres" ||
      modes.length > 1 || modes.some(m => !["require", "verify-ca", "verify-full"].includes(m))) {
    throw new Error("PAYROLL_DEV_DIRECT_TLS_CONFIG_INVALID");
  }
  // Do not allow URL query fields to replace the validated host, role, or TLS
  // configuration. This explicit direct DEV DSN accepts only sslmode.
  for (const key of u.searchParams.keys()) {
    if (key !== "sslmode") throw new Error("PAYROLL_DEV_DIRECT_TLS_CONFIG_INVALID");
  }
  u.searchParams.delete("sslmode");
  return {
    connectionString: u.toString(),
    ssl: { ca: SUPABASE_CA, rejectUnauthorized: true, servername: DEV_HOST },
  };
}
