import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const page=readFileSync(resolve(process.cwd(),"src/pages/cash-bank/sc-new.tsx"),"utf8");

describe("Account18 draft COA selector",()=>{
  const start=page.indexOf('htmlFor="sc-draft-coa-search"');
  const end=page.indexOf('COA terpilih:',start);
  const field=page.slice(start,end);
  it("provides native seven-row scrolling and searchable counter COA options",()=>{
    expect(start).toBeGreaterThan(0);
    expect(field).toContain('aria-label="Cari calon COA lawan"');
    expect(field).toContain('aria-label="Daftar calon COA lawan"');
    expect(field).toContain('size={7}');
    expect(field).toContain('overflow-y-auto overscroll-contain');
    expect(field).toContain('draftCoaSearch.trim().toLowerCase()');
    expect(field).toContain('readiness.contraCandidates');
    expect(field).not.toContain('<SelectContent>');
  });
  it("preserves pending-evidence read-only guard and draft invalidation",()=>{
    expect(field).toContain('disabled={evidenceBusy||!!pendingEvidence}');
    expect(field).toContain('if(evidenceBusy||pendingEvidence)return;');
    expect(field).toContain('setCounterCoaId(e.target.value)');
    expect(field).toContain('invalidateDraft()');
  });
});
