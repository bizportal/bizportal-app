import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "src/routes/bank-reconciliation.ts"), "utf8");

describe("bank Sheet config auth and company scope cutover gate", () => {
  it("protects all Sheet configuration CRUD, test, and sync routes with actor auth", () => {
    const i = source.indexOf('router.use(["/bank-reconciliation/sheet-configs", "/bank-reconciliation/sheet-sync"]');
    const firstGet = source.indexOf('router.get("/bank-reconciliation/sheet-configs"');
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(firstGet);
    const guard = source.slice(i, firstGet);
    expect(guard).toContain("await getApprovalActor(req)");
    expect(guard).toContain('res.status(401)');
    expect(guard).toContain('res.status(403)');
    expect(guard).toContain("from public.bank_sheet_configs where id=$1");
    expect(guard).toContain('req.method === "PUT"');
    expect(guard).toContain('req.method === "POST"');
  });

  it("scopes all-company sync to the authenticated actor when actor is tenant-bound", () => {
    const index = source.indexOf('router.post("/bank-reconciliation/sheet-sync"');
    const route = source.slice(index, source.indexOf('router.post("/bank-reconciliation/:mutationId',index));
    expect(route).toContain("const actor = res.locals.sheetActor as ApprovalActor");
    expect(route).toContain("actor.companyId !== companyId");
    expect(route).toContain("syncAllBankSheetConfigs(actor.companyId ?? companyId ?? undefined)");
  });
});
