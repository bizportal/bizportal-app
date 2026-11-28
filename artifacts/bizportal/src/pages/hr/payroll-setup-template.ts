/** Download-only planning worksheet. This function cannot persist salary or deductions. */
export type PayrollSetupTemplateRow = {
  employeeId: number;
  employeeName: string;
};

const headings = [
  "company_id","employee_id","employee_name","effective_from",
  "base_salary","allowance","bpjs_jht_employee","bpjs_kes_employee",
  "pph21","other_deductions","kasbon_deduction",
] as const;

/** Prevent spreadsheet formula execution and CSV column/row injection. */
function csvCell(value: string): string {
  const sanitized = value.replace(/[\r\n\t]/g," ").trim();
  const guarded = /^[=+@-]/.test(sanitized) ? "'" + sanitized : sanitized;
  return '"' + guarded.replace(/"/g,'""') + '"';
}

export function buildPayrollSetupBlankCsv(
  companyId:number, year:number, month:number,
  rows:readonly PayrollSetupTemplateRow[],
):string {
  if(!Number.isSafeInteger(companyId)||companyId<1||
     !Number.isSafeInteger(year)||year<2020||year>2100||
     !Number.isSafeInteger(month)||month<1||month>12)throw Error("INVALID_PAYROLL_TEMPLATE_SCOPE");
  const effectiveFrom = year+"-"+String(month).padStart(2,"0")+"-01";
  const seen = new Set<number>();
  const body=rows.map(row=>{
    if(!Number.isSafeInteger(row.employeeId)||row.employeeId<1||
       typeof row.employeeName!=="string"||seen.has(row.employeeId))throw Error("INVALID_PAYROLL_TEMPLATE_EMPLOYEE");
    seen.add(row.employeeId);
    // All amounts MUST remain blank: zero is a business decision, not a default.
    const fields=[String(companyId),String(row.employeeId),row.employeeName,effectiveFrom,
      "","","","","","",""];
    return fields.map(csvCell).join(",");
  });
  return "\uFEFF"+[headings.map(csvCell).join(","),...body].join("\r\n")+"\r\n";
}
