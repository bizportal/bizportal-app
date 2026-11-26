import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isPettyCashChoice, pettyCashReadError } from "../pages/cash-bank/petty-cash-policy";

const page = readFileSync(resolve(process.cwd(),"src/pages/cash-bank/petty-cash.tsx"),"utf8");

describe("Petty cash form UI safety: no false posting", () => {
  it("restricts Account18 (Kas Besar SC) from Petty Cash form, but allows Account1", () => {
    expect(isPettyCashChoice({ id:18, is_active:true, account_type:"cash" },1)).toBe(false);
    expect(isPettyCashChoice({ id:1, is_active:true, account_type:"cash" },1)).toBe(true);
    expect(isPettyCashChoice({ id:18, is_active:true, account_type:"cash" },3)).toBe(true);
    expect(isPettyCashChoice({ id:5, is_active:false, account_type:"cash" },1)).toBe(false);
    expect(isPettyCashChoice({ id:5, is_active:true, account_type:"bank" },1)).toBe(false);
  });
  it("communicates nonexistent endpoint and unauthorized sessions", () => {
    expect(pettyCashReadError(404)).toContain("belum tersedia");
    expect(pettyCashReadError(401)).toContain("tidak sah");
  });
  it("disables creation if GET is missing and checks POST/PATCH response", () => {
    expect(page).toContain("disabled={!serviceAvailable");
    expect(page).toContain("if (!txR.ok)");
    expect(page).toContain("if (!response.ok)");
    expect(page).toContain("if (!result.ok)");
    expect(page).toContain("isPettyCashChoice");
    expect(page).toContain("role=\"alert\"");
  });
});
