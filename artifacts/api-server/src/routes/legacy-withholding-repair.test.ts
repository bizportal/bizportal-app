import { describe, expect, it } from "vitest";
import { legacyRepairComponents, repairReason, resolveLegacyWithholdingLineId } from "./purchase-workflow";

describe("legacy withholding repair classification", () => {
  it("keeps wrong-line rows in the repair queue", () => {
    const reason = repairReason(
      [{
        invoiceLineId: 10,
        taxType: "PPh 23",
        taxObject: "Jasa",
        baseAmount: 1_000_000,
        taxAmount: 20_000,
        liabilityAccountId: null,
      }],
      [{
        id: 1,
        invoice_line_id: 11,
        tax_type: "PPh 23",
        tax_object: "Jasa",
        base_amount: "1000000",
        tax_amount: "20000",
        liability_account_id: 99,
        resolution_status: "confirmed",
      }],
    );

    expect(reason?.code).toBe("INCONSISTENT_VENDOR_WITHHOLDING_ROWS");
  });

  it("flags a combined legacy header for operator splitting", () => {
    const components = legacyRepairComponents({
      id: 7,
      invoice_number: "VI-7",
      supplier_name: "Vendor",
      status: "posted",
      grand_total: "1020000",
      total_amount: "1000000",
      withholding_tax_amount: "30000",
      withholding_tax_type: "PPh 23 + PPh 4(2)",
      tax_object: "legacy_invoice_header",
      invoice_breakdown: null,
      created_at: new Date(),
    });
    const reason = repairReason(
      components.map((component) => ({ ...component, invoiceLineId: 10 })),
      [],
    );

    expect(reason?.code).toBe("COMBINED_VENDOR_WITHHOLDING_ROW");
    expect(components).toHaveLength(1);
    expect(components[0]?.taxAmount).toBe(30_000);
  });

  it("does not queue an exact confirmed company-reviewed row", () => {
    const plans = [{
      invoiceLineId: 10,
      taxType: "PPh 23",
      taxObject: "Jasa",
      baseAmount: 1_000_000,
      taxAmount: 20_000,
      liabilityAccountId: 99,
    }];
    expect(repairReason(plans, [{
      id: 1,
      invoice_line_id: 10,
      tax_type: "PPh 23",
      tax_object: "Jasa",
      base_amount: "1000000",
      tax_amount: "20000",
      liability_account_id: 99,
      resolution_status: "confirmed",
    }])).toBeNull();
  });

  it("uses the persisted split as canonical after a combined header repair", () => {
    const components = legacyRepairComponents({
      id: 7,
      invoice_number: "VI-7",
      supplier_name: "Vendor",
      status: "posted",
      grand_total: "1020000",
      total_amount: "1000000",
      withholding_tax_amount: "30000",
      withholding_tax_type: "PPh 23 + PPh 4(2)",
      tax_object: "legacy_invoice_header",
      invoice_breakdown: {
        totals: { gross: 1_020_000 },
        withholding_repair_components: [
          {
            invoice_line_id: 10,
            tax_type: "PPh 23",
            tax_object: "Jasa",
            base_amount: 500_000,
            tax_amount: 10_000,
            liability_account_id: 91,
          },
          {
            invoice_line_id: 10,
            tax_type: "PPh 4(2)",
            tax_object: "Sewa",
            base_amount: 500_000,
            tax_amount: 20_000,
            liability_account_id: 92,
          },
        ],
      },
      created_at: new Date(),
    });
    const plans = components.map((component) => ({ ...component, invoiceLineId: component.invoiceLineId ?? 10 }));
    const taxes = plans.map((plan, index) => ({
      id: index + 1,
      invoice_line_id: plan.invoiceLineId,
      tax_type: plan.taxType,
      tax_object: plan.taxObject,
      base_amount: String(plan.baseAmount),
      tax_amount: String(plan.taxAmount),
      liability_account_id: plan.liabilityAccountId,
      resolution_status: "confirmed",
    }));

    expect(components.map((component) => component.taxType)).toEqual(["PPh 23", "PPh 4(2)"]);
    expect(components.reduce((sum, component) => sum + component.taxAmount, 0)).toBe(30_000);
    expect(repairReason(plans, taxes)).toBeNull();
  });
});
describe("legacy withholding line identity regression (CST DEV historical shape)", () => {
  const invoiceLines = [
    { id: 18, name: "COA_MAPPING_REGRESSION_1788596573750 Monthly service" },
    { id: 37, name: "Pendapatan Konsesi" },
    { id: 38, name: "Pemakaian Listrik" },
    { id: 39, name: "Pemakaian Air" },
  ];
  it("does not put concession PPh on an unrelated earlier QA line", () => {
    const plans = [
      { taxObject: "concession", taxType: "PPh 23", baseAmount: 15834000, taxAmount: 2375100, liabilityAccountId: null },
      { taxObject: "electricity", taxType: "PPh 4(2)", baseAmount: 10962796, taxAmount: 1096280, liabilityAccountId: null },
      { taxObject: "water", taxType: "PPh 4(2)", baseAmount: 1756710, taxAmount: 175671, liabilityAccountId: null },
    ];
    expect(plans.map(plan => resolveLegacyWithholdingLineId(plan, invoiceLines))).toEqual([37, 38, 39]);
  });
  it("fails closed if a component is missing or ambiguous, never choosing first row", () => {
    const plan = { taxObject: "concession", taxType: "PPh 23", baseAmount: 100, taxAmount: 10, liabilityAccountId: null };
    expect(resolveLegacyWithholdingLineId(plan, [invoiceLines[0]!])).toBe(0);
    expect(resolveLegacyWithholdingLineId(plan, [invoiceLines[1]!, { id: 55, name: "Pendapatan Konsesi - Other" }])).toBe(0);
    expect(repairReason([{ ...plan, invoiceLineId: 0 }], [])?.code).toBe("UNRESOLVED_VENDOR_INVOICE_LINE");
  });
  it("honors an explicit invoice-owned line ID and rejects an ID from elsewhere", () => {
    const plan = { taxObject: "concession", taxType: "PPh 23", baseAmount: 100, taxAmount: 10, liabilityAccountId: null };
    expect(resolveLegacyWithholdingLineId({ ...plan, invoiceLineId: 37 }, invoiceLines)).toBe(37);
    expect(resolveLegacyWithholdingLineId({ ...plan, invoiceLineId: 999 }, invoiceLines)).toBe(0);
  });
});
