import { beforeEach, describe, expect, it, vi } from "vitest";

// Deterministic offline test; no real tokens, GCP, shared database or HTTP.
const m = vi.hoisted(() => ({
  lookup: vi.fn(),
  warn: vi.fn(),
  selects: 0,
  row: null as null | {vendorToken:string;vendorTokenExpiresAt:Date|null;id:number;companyId:number},
}));
vi.mock("@workspace/db", () => ({
  mktPurchaseOrdersTable: {vendorToken:"vendor_token"},
  db: {
    select: () => {
      m.selects++;
      return {from:()=>({where:()=>({limit:async()=>m.row?[m.row]:[]})})};
    },
  },
}));
vi.mock("drizzle-orm", () => ({
  eq: (...a:unknown[])=>a,
  sql: (strings:TemplateStringsArray, ...values:unknown[])=>({strings,values}),
}));
vi.mock("../logger.js",()=>({logger:{warn:m.warn}}));
import { generateOpaqueToken, findPoByVendorToken } from "./mktVendorPoTokenService.js";
const issued=(token:string,expiration:Date|null=new Date(Date.now()+86_400_000))=>({
  id:14,companyId:1,vendorToken:token,vendorTokenExpiresAt:expiration,
});
beforeEach(()=>{vi.clearAllMocks();m.row=null;m.selects=0;});
describe("Customer Portal 48-hex and BizPortal 64-hex PO token parity",()=>{
  it("does not alter existing canonical 32-byte / 64-hex token generation",()=>{
    const generated=generateOpaqueToken();
    expect(generated).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(generated,"hex")).toHaveLength(32);
    expect(m.selects).toBe(0);
  });
  it.each([48,64])("accepts valid %i-hex exact token with constant-time comparison and future expiry",async length=>{
    const token="a".repeat(length);
    m.row=issued(token);
    const result=await findPoByVendorToken(token);
    expect(result).toMatchObject({ok:true,po:{id:14,companyId:1,vendorToken:token}});
    expect(m.selects).toBe(1);
  });
  it.each([
    "", "a".repeat(47),"a".repeat(49),"a".repeat(63),"a".repeat(65),
    "g".repeat(48),"g".repeat(64), "a".repeat(47)+"-",
    "a".repeat(48)+"%20","a".repeat(95),
  ])("rejects malformed token before any database access", async value=>{
    expect(await findPoByVendorToken(value)).toEqual({ok:false,code:"MALFORMED"});
    expect(m.selects).toBe(0);
  });
  it.each([48,64])("does not accept a different stored %i-hex token",async length=>{
    m.row=issued("b".repeat(length));
    expect(await findPoByVendorToken("a".repeat(length)))
      .toEqual({ok:false,code:"NOT_FOUND"});
    expect(m.selects).toBe(1);
  });
  it.each([48,64])("rejects expired %i-hex token",async length=>{
    const token="a".repeat(length);
    m.row=issued(token,new Date(Date.now()-60_000));
    expect(await findPoByVendorToken(token))
      .toEqual({ok:false,code:"EXPIRED"});
  });
  it("still refuses missing token even when the syntax is valid",async()=>{
    expect(await findPoByVendorToken("a".repeat(48)))
      .toEqual({ok:false,code:"NOT_FOUND"});
    expect(m.selects).toBe(1);
  });
});
