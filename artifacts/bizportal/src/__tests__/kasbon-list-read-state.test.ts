import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { kasbonListReadState, parseKasbonListResponse } from "../lib/kasbon-list-read-state";

describe("Kasbon general list: do not misrepresent failed reads", () => {
  it("only accepts an actual array of record objects", () => {
    const row = { id: 23, status: "pending_approval" };
    expect(parseKasbonListResponse([row])).toEqual([row]);
    expect(parseKasbonListResponse({ data: [row], total: 1 })).toEqual([row]);
    expect(parseKasbonListResponse({ data: [] })).toEqual([]);
  });
  it("rejects error-shaped, null and malformed success bodies", () => {
    for (const value of [undefined, null, {}, { error: "denied" }, { data: null }, { data: {} }, [null], [4], [[]]]) {
      expect(() => parseKasbonListResponse(value)).toThrow("Daftar kasbon tidak tersedia.");
    }
  });
  it("pending and error never become empty or ready, even with stale rows", () => {
    expect(kasbonListReadState("pending", 0, 0)).toBe("loading");
    expect(kasbonListReadState("error", 0, 0)).toBe("unavailable");
    expect(kasbonListReadState("error", 4, 4)).toBe("unavailable");
  });
  it("distinguishes real empty, filtered empty and available records", () => {
    expect(kasbonListReadState("success", 0, 0)).toBe("empty");
    expect(kasbonListReadState("success", 4, 0)).toBe("filtered-empty");
    expect(kasbonListReadState("success", 4, 2)).toBe("ready");
  });
  it("page uses checked query state without changing the endpoint or the independent Finance panel", () => {
    const page = readFileSync(resolve(process.cwd(), "src/pages/expense/kasbon.tsx"), "utf8");
    expect(page).toContain("listQuery.isSuccess ? listQuery.data : []");
    expect(page).toContain(".then(parseKasbonListResponse)");
    expect(page).toContain('queryKey: ["advances", "kasbon", activeCompanyId, isConsolidated]');
    expect(page).toContain('listReadState === "unavailable"');
    expect(page).toContain('listReadState === "empty" ? "Belum ada kasbon."');
    expect(page).toContain('listReadState === "ready" && filteredList.map');
    expect(page).toContain("<AiTaskKasbonReadPanel />");
    expect(page).toContain("/api/advances?type=employee_kasbon");
  });
});
