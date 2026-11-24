import { describe, expect, it } from "vitest";
import { readSecret } from "@workspace/db";

/**
 * Opt-in DEV real systemd credential-read proof; no secret values logged.
 * Never run against PROD, never print/copy the protected database URLs.
 */
describe.skipIf(process.env.PR147_SYSTEMD_PROOF_ENABLED !== "true")(
  "PR147 existing Finance company bundle through protected systemd credential",
  () => {
    it("reads only the approved company-bundle name with correct role labels", async () => {
      expect(process.env.APP_ENV).toBe("development");
      expect(process.env.PR147_BANK_SHEET_COMPANIES_GCP_SECRET_NAME_DEV)
        .toBe("bizportal-marketplace-finance-dev-companies");
      const bundle = JSON.parse(await readSecret("bizportal-marketplace-finance-dev-companies")) as {
        companies?: Record<string, { role?: string; databaseUrl?: string }>;
      };
      expect(bundle.companies?.["1"]?.role).toBe("bizportal_finance_cst_login_dev");
      expect(bundle.companies?.["3"]?.role).toBe("bizportal_finance_diva_login_dev");
      expect(typeof bundle.companies?.["1"]?.databaseUrl).toBe("string");
      expect(typeof bundle.companies?.["3"]?.databaseUrl).toBe("string");
    });
  },
);
