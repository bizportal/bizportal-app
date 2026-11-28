/**
 * DEV-only, in-memory source arithmetic audit for an HR salary spreadsheet.
 * No database, HTTP router, configuration write, payroll item, posting or payout.
 * This does NOT establish attendance, an employment contract, base salary,
 * BPJS/PPh21, cash advance deductions, or final net pay.
 */
export type DailySalarySourceRow = {
  employeeLabel: string;
  totalSalaryReference: string;
  workDaysReference: number | null;
  dailyRateReference: string | null;
  mealAllowanceReference: string | null;
};

const MAX_ROWS = 200;
const MAX_AMOUNT_UNITS = 10000000000000000n;

function decimalUnits(value: string, decimals: number): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.test(value))
    throw new Error("INVALID_DAILY_REFERENCE_AMOUNT");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error("INVALID_DAILY_REFERENCE_PRECISION");
  const multiplier = 10n ** BigInt(decimals);
  const units = BigInt(whole) * multiplier + BigInt(fraction.padEnd(decimals, "0"));
  if (units > MAX_AMOUNT_UNITS) throw new Error("DAILY_REFERENCE_AMOUNT_OVERFLOW");
  return units;
}
function centsString(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return (negative ? "-" : "") + (absolute / 100n).toString() + "." +
    (absolute % 100n).toString().padStart(2, "0");
}
function periodDays(year: number, month: number): number {
  if (!Number.isInteger(year) || year < 2020 || year > 2100 ||
      !Number.isInteger(month) || month < 1 || month > 12)
    throw new Error("INVALID_DAILY_REFERENCE_PERIOD");
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function addMoney(a: string, b: string): string {
  return centsString(decimalUnits(a, 2) + decimalUnits(b, 2));
}
export function buildDailySalarySourcePreview(
  inputs: readonly DailySalarySourceRow[], year: number, month: number,
) {
  const maxWorkDays = periodDays(year, month);
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > MAX_ROWS)
    throw new Error("INVALID_DAILY_REFERENCE_ROW_COUNT");
  let matches = 0, mismatches = 0, unclassified = 0, missingMeal = 0;
  const rows = inputs.map((input, index) => {
    if (typeof input.employeeLabel !== "string" || !input.employeeLabel.trim() ||
        input.employeeLabel.length > 150)
      throw new Error("INVALID_DAILY_REFERENCE_LABEL");
    const totalCents = decimalUnits(input.totalSalaryReference, 2);
    const hasRate = input.dailyRateReference !== null;
    const hasDays = input.workDaysReference !== null;
    if (hasDays && (!Number.isSafeInteger(input.workDaysReference) ||
        input.workDaysReference! < 0 || input.workDaysReference! > maxWorkDays))
      throw new Error("INVALID_DAILY_REFERENCE_WORKDAYS");
    const rateUnits = hasRate ? decimalUnits(input.dailyRateReference!, 4) : null;
    const computed = rateUnits !== null && hasDays
      ? centsString((rateUnits * BigInt(input.workDaysReference!) + 50n) / 100n)
      : null;
    const delta = computed === null ? null : centsString(decimalUnits(computed, 2) - totalCents);
    const arithmeticMatch = delta === null ? null : delta === "0.00";
    if (arithmeticMatch === true) matches++;
    if (arithmeticMatch === false) mismatches++;
    if (computed === null) unclassified++;
    const mealCents = input.mealAllowanceReference === null ? null
      : decimalUnits(input.mealAllowanceReference, 2);
    if (mealCents === null) missingMeal++;
    const issues: string[] = [];
    if (computed === null) issues.push(hasDays !== hasRate
      ? "TARIF_ATAU_HARI_TIDAK_LENGKAP" : "DASAR_HARIAN_BELUM_DIBUKTIKAN");
    if (arithmeticMatch === false) issues.push("NOMINAL_TIDAK_COCOK");
    if (mealCents === null) issues.push("UANG_MAKAN_BELUM_DIKONFIRMASI");
    issues.push("HARI_KERJA_BELUM_DIVERIFIKASI");
    issues.push("IDENTITAS_DAN_POTONGAN_BELUM_DIVERIFIKASI");
    return {
      rowNumber: index + 1,
      employeeLabel: input.employeeLabel.trim(),
      workDaysReference: input.workDaysReference,
      dailyRateReference: input.dailyRateReference,
      totalSalaryReference: centsString(totalCents),
      mealAllowanceReference: mealCents === null ? null : centsString(mealCents),
      computedDailySalaryReference: computed,
      salaryDifference: delta,
      arithmeticMatch,
      grossReference: mealCents === null ? null :
        addMoney(input.totalSalaryReference, centsString(mealCents)),
      baseSalary: null,
      netSalary: null,
      attendanceVerified: false as const,
      salaryComponentsVerified: false as const,
      issues,
      canMaterialize: false as const,
      canPost: false as const,
      canPay: false as const,
    };
  });
  return {
    period: year.toString() + "-" + String(month).padStart(2, "0"),
    referenceOnly: true as const,
    employeeRows: rows.length,
    dailyArithmeticMatches: matches,
    dailyArithmeticMismatches: mismatches,
    withoutVerifiedDailyBasis: unclassified,
    missingMealAllowance: missingMeal,
    attendanceVerified: false as const,
    canMaterialize: false as const,
    canPost: false as const,
    canPay: false as const,
    rows,
    note: "Kecocokan hari x tarif hanya verifikasi matematika, bukan validasi kehadiran, kontrak, gaji pokok, pajak, kasbon, atau gaji bersih.",
  };
}
