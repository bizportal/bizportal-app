import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const page=readFileSync(resolve(process.cwd(),"src/pages/cash-bank/sc-new.tsx"),"utf8");

describe("Account18 voucher COA selection with long lists",()=>{
  it("uses an explicitly scrollable native 7-row list instead of an overlay popover",()=>{
    const start=page.indexOf('<Label htmlFor="sc-voucher-coa-search">');
    const end=page.indexOf('COA terpilih:',start);
    const field=page.slice(start,end);
    expect(start).toBeGreaterThan(0);
    expect(field).toContain('size={7}');
    expect(field).toContain('overflow-y-auto overscroll-contain');
    expect(field).toContain('<select');
    expect(field).toContain('aria-label="Daftar COA lawan voucher"');
    expect(field).toContain('<option value="">Pilih COA lawan</option>');
    expect(field).not.toContain('<SelectContent>');
  });
  it("filters by case-insensitive code or name without changing allowed COA IDs",()=>{
    expect(page).toContain('aria-label="Cari COA lawan voucher"');
    expect(page).toContain('(c.code+" "+c.name).toLowerCase().includes(voucherCoaSearch.trim().toLowerCase())');
    expect(page).toContain('value={String(c.id)}');
    expect(page).toContain('setVoucherCoa(e.target.value)');
    expect(page).toContain('setVoucherCoaSearch("")');
    expect(page).toContain('const coa=readiness.contraCandidates.find(');
  });
  it("keeps COA choice locked after OTP challenge or during in-flight request",()=>{
    expect(page).toContain('disabled={voucherBusy||!!voucherChallenge||evidenceReviewed}');
    expect(page).toContain('if(voucherLock.current||voucherChallenge||evidenceReviewed)return;');
    expect(page).toContain('String(voucherChallenge.counterCoaId)!==voucherCoa');
    expect(page).toContain('postingAllowed!==false');
  });
});
