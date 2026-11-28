import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const view=readFileSync(resolve(process.cwd(),"src/components/expense/dev-cst-kasbon-history.tsx"),"utf8");
const page=readFileSync(resolve(process.cwd(),"src/pages/expense/kasbon.tsx"),"utf8");
describe("CST-DEV history uses a separate read-only rendering path",()=>{
  it("uses fixed DEV host, owner/super_admin, explicit CST and own signed session",()=>{
    expect(view).toContain('host === "dev-bizportal.cstlogistic.co.id"');
    expect(view).toContain('companyId === 1 && !consolidated');
    expect(view).toContain('["owner","super_admin"]');
    expect(view).toContain('/api/advances/dev-kasbon-history?companyId=1&page=');
    expect(view).toContain('credentials: "include", cache: "no-store"');
  });
  it("read-only page does not mount legacy mutation controls",()=>{
    expect(page).toContain("return <DevCstKasbonHistoryPage />");
    expect(page).toContain("return <LegacyKasbonPage />");
    expect(view).not.toMatch(/useMutation|method:\s*["'](?:POST|PATCH|DELETE)["']|Buat Kasbon|Catat Cicilan/);
    expect(view).toContain("<AiTaskKasbonReadPanel />");
  });
  it("does not render a failed read as an empty ledger or use legacy active as verified disbursement",()=>{
    expect(view).toContain("Ini bukan berarti tidak ada kasbon");
    expect(view).toContain("bukan saldo piutang atau pembayaran bank yang terverifikasi");
    expect(view).toContain("Disetujui — belum tercatat cair");
    expect(view).toContain("Void tercatat");
    expect(view).toContain("query.isSuccess && !query.isFetching");
  });
});
