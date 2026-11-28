import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";

// The BizPortal package test runner sets cwd to artifacts/bizportal.
// Avoid import.meta.url: Vitest transforms it into a non-file URL under jsdom.
const payrollPage=readFileSync(resolve(process.cwd(),"src/pages/hr/payroll.tsx"),"utf8");

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
