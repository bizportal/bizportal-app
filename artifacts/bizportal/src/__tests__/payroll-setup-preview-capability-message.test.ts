import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";

const payrollPage=readFileSync(fileURLToPath(new URL("../pages/hr/payroll.tsx",import.meta.url)),"utf8");

describe("Payroll DEV setup preview capability is explicit",()=>{
  it("shows a non-actionable explanation when the authenticated API disables preview",()=>{
    expect(payrollPage).toContain("draft && !canPreviewSetup && detail.run.companyId === companyId");
    expect(payrollPage).toContain("Pratinjau Payroll baca-saja belum tersedia pada runtime ini.");
    expect(payrollPage).toContain("Periksa koneksi Payroll DEV khusus dan konfigurasi APP_ENV.");
  });
  it("keeps preview gated and Calculate disabled",()=>{
    expect(payrollPage).toContain("draft && canPreviewSetup && detail.run.companyId === companyId");
    expect(payrollPage).toContain('<Button variant="outline" disabled title="Menunggu verifikasi alokasi kasbon"');
  });
});
