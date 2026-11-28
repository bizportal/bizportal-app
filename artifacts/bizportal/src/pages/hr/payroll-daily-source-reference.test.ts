import { describe, expect, it } from "vitest";
import { buildDailySalarySourcePreview, type DailySalarySourceRow } from "./payroll-daily-source-reference";

const row = (changes: Partial<DailySalarySourceRow> = {}): DailySalarySourceRow => ({
  employeeLabel: "Contoh pegawai",
  totalSalaryReference: "9100000.00",
  workDaysReference: 26,
  dailyRateReference: "350000.00",
  mealAllowanceReference: "1900000.00",
  ...changes,
});

describe("Payroll DEV source arithmetic never creates payroll", () => {
  it("reproduces exact daily amount for 26 days without inferring base or net", () => {
    const result = buildDailySalarySourcePreview([row()], 2026, 11);
    expect(result).toMatchObject({
      period: "2026-11", employeeRows: 1, dailyArithmeticMatches: 1,
      dailyArithmeticMismatches: 0, withoutVerifiedDailyBasis: 0,
      attendanceVerified: false, referenceOnly: true,
      canMaterialize: false, canPost: false, canPay: false,
    });
    expect(result.rows[0]).toMatchObject({
      computedDailySalaryReference: "9100000.00",
      totalSalaryReference: "9100000.00",
      salaryDifference: "0.00", arithmeticMatch: true,
      grossReference: "11000000.00", baseSalary: null, netSalary: null,
      attendanceVerified: false, salaryComponentsVerified: false,
      canMaterialize: false, canPost: false, canPay: false,
    });
  });

  it("uses exact decimal arithmetic for a fractional daily rate", () => {
    const result = buildDailySalarySourcePreview([row({
      totalSalaryReference: "1499999.80", dailyRateReference: "57692.3",
      mealAllowanceReference: "1000000.00",
    })],2026,11);
    expect(result.rows[0]).toMatchObject({
      computedDailySalaryReference: "1499999.80",
      salaryDifference: "0.00", grossReference: "2499999.80",
      arithmeticMatch: true,
    });
  });

  it("does not assume monthly pay is based on 26 days if daily evidence is blank", () => {
    const result=buildDailySalarySourcePreview([row({
      totalSalaryReference:"5000000.00",workDaysReference:null,
      dailyRateReference:null,mealAllowanceReference:null,
    })],2026,11);
    expect(result).toMatchObject({
      withoutVerifiedDailyBasis:1,missingMealAllowance:1,canMaterialize:false,
    });
    expect(result.rows[0]).toMatchObject({
      arithmeticMatch:null,computedDailySalaryReference:null,
      grossReference:null,netSalary:null,issues:[
        "DASAR_HARIAN_BELUM_DIBUKTIKAN",
        "UANG_MAKAN_BELUM_DIKONFIRMASI",
        "HARI_KERJA_BELUM_DIVERIFIKASI",
        "IDENTITAS_DAN_POTONGAN_BELUM_DIVERIFIKASI",
      ],
    });
  });

  it("makes a mismatch explicit and does not silently overwrite source salary", () => {
    const result=buildDailySalarySourcePreview([row({
      totalSalaryReference:"8000000.00",mealAllowanceReference:"0.00",
    })],2026,11);
    expect(result.dailyArithmeticMismatches).toBe(1);
    expect(result.missingMealAllowance).toBe(0);
    expect(result.rows[0]).toMatchObject({
      arithmeticMatch:false,salaryDifference:"1100000.00",
      computedDailySalaryReference:"9100000.00",totalSalaryReference:"8000000.00",
      grossReference:"8000000.00",
    });
    expect(result.rows[0].issues).toContain("NOMINAL_TIDAK_COCOK");
  });

  it("reports one missing factor as unknown, never as 0 or an inferred rate", () => {
    const result=buildDailySalarySourcePreview([row({
      dailyRateReference:null,
    })],2026,11);
    expect(result.rows[0]).toMatchObject({
      computedDailySalaryReference:null,arithmeticMatch:null,
      baseSalary:null,netSalary:null,
    });
    expect(result.rows[0].issues).toContain("TARIF_ATAU_HARI_TIDAK_LENGKAP");
  });

  it("requires valid calendar workdays and periods", () => {
    expect(()=>buildDailySalarySourcePreview([row({workDaysReference:31})],2026,11))
      .toThrow("INVALID_DAILY_REFERENCE_WORKDAYS");
    expect(()=>buildDailySalarySourcePreview([row({workDaysReference:0.5})],2026,11))
      .toThrow("INVALID_DAILY_REFERENCE_WORKDAYS");
    expect(()=>buildDailySalarySourcePreview([row()],2026,13))
      .toThrow("INVALID_DAILY_REFERENCE_PERIOD");
    expect(()=>buildDailySalarySourcePreview([row({workDaysReference:31})],2026,12))
      .not.toThrow();
  });

  it("rejects malformed source amounts and more than four rate decimals", () => {
    expect(()=>buildDailySalarySourcePreview([row({dailyRateReference:"57692.30001"})],2026,11))
      .toThrow("INVALID_DAILY_REFERENCE_PRECISION");
    expect(()=>buildDailySalarySourcePreview([row({totalSalaryReference:"NaN"})],2026,11))
      .toThrow("INVALID_DAILY_REFERENCE_AMOUNT");
    expect(()=>buildDailySalarySourcePreview([row({mealAllowanceReference:"-1"})],2026,11))
      .toThrow("INVALID_DAILY_REFERENCE_AMOUNT");
    expect(()=>buildDailySalarySourcePreview([row({employeeLabel:" "})],2026,11))
      .toThrow("INVALID_DAILY_REFERENCE_LABEL");
    expect(()=>buildDailySalarySourcePreview([],2026,11))
      .toThrow("INVALID_DAILY_REFERENCE_ROW_COUNT");
  });

  it("rounds a fractional daily rate once, to cents, after multiplication", () => {
    const result = buildDailySalarySourcePreview([row({
      workDaysReference:1,dailyRateReference:"0.0050",
      totalSalaryReference:"0.01",mealAllowanceReference:"0.00",
    })],2026,11);
    expect(result.rows[0].computedDailySalaryReference).toBe("0.01");
    expect(result.rows[0].arithmeticMatch).toBe(true);
  });
});
