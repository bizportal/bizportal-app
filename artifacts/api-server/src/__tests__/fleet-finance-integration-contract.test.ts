import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const routesIndex = readFileSync(resolve(process.cwd(), "src/routes/index.ts"), "utf8");
const integration = readFileSync(resolve(process.cwd(), "src/routes/fleet-finance-integration.ts"), "utf8");

describe("Fleet Central Finance service integration", () => {
  it("is mounted under a dedicated internal integration path", () => {
    expect(routesIndex).toContain('import fleetFinanceIntegrationRouter from "./fleet-finance-integration"');
    expect(routesIndex).toContain('router.use("/integrations/fleet", fleetFinanceIntegrationRouter)');
  });

  it("fails closed unless a dedicated service token is configured", () => {
    expect(integration).toContain("FLEET_FINANCE_SERVICE_TOKEN");
    expect(integration).toContain('res.status(503).json({ error: "Fleet Finance integration belum dikonfigurasi." })');
    expect(integration).toContain("timingSafeEqual");
    expect(integration).toContain('res.status(401).json({ error: "Unauthorized" })');
  });

  it("requires idempotency for accounting writes", () => {
    expect(integration).toContain("Idempotency-Key wajib 8-200 karakter");
    expect(integration).toContain('router.post("/cash-payments"');
    expect(integration).toContain('router.post("/cash-payments/reverse"');
    expect(integration).toContain("source='fleet_cash_payment'");
    expect(integration).toContain("source='reversal'");
  });

  it("requires an authoritative Fleet payment source before posting or reversing", () => {
    expect(integration).toContain("verifyFleetCashPaymentSource(client, args)");
    expect(integration).toContain("FROM public.fleet_cash_payments");
    expect(integration).toContain("WHERE id=$1 AND company_id=$2 AND amount=$3");
    expect(integration).toContain("Pembayaran Fleet sudah dibatalkan; posting ditolak.");
    expect(integration).toContain("Sumber pembayaran Fleet tidak cocok dengan perusahaan, nominal, atau tanggal.");
  });

  it("requires a same-company active journal before posting", () => {
    expect(integration).toContain("Jurnal Fleet tidak aktif atau bukan milik perusahaan ini.");
    expect(integration).toContain("WHERE id=$1 AND company_id=$2 AND COALESCE(is_active,true)=true");
  });

  it("rejects mismatched and unposted originals before a Fleet reversal", () => {
    expect(integration).toContain("source='fleet_cash_payment' AND source_id=$3");
    expect(integration).toContain("AND source='fleet_cash_payment' AND source_id=$3");
    expect(integration).toContain("Original Fleet payment tidak cocok dengan perusahaan, status, atau nominal.");
    expect(integration).toContain("posted.status !== \"posted\"");
    expect(integration).toContain("Math.abs(Number(posted.total_debit) - args.amount) > 0.005");
  });

  it("never reports a draft Fleet payment as an idempotent posted journal", () => {
    expect(integration).toContain("Jurnal Fleet existing belum POSTED; perlu pemeriksaan manual.");
    expect(integration).toContain("existing.rows[0].status !== \"posted\"");
  });

  it("keeps the accounting settings source inside Central Finance", () => {
    expect(integration).toContain('router.get("/companies/:companyId/accounting-settings"');
    expect(integration).toContain('router.put("/companies/:companyId/accounting-settings"');
    expect(integration).toContain("public.accounting_settings");
    expect(integration).toContain("public.chart_of_accounts");
    expect(integration).toContain("public.accounting_journals");
  });
});
