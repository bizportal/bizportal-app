import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({read:vi.fn(),lookup:vi.fn()}));
vi.mock("@workspace/db",()=>({withMarketplaceFinanceDevReadOnlyTransaction:mocks.read}));
vi.mock("./mktVendorPoTokenService.js",()=>({findPoByVendorToken:mocks.lookup}));
import { resolveVendorInvoiceToken } from "./mktVendorInvoiceTokenResolver";
const token="a".repeat(64);
beforeEach(()=>{
  vi.stubEnv("APP_ENV","development");
  vi.stubEnv("BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV","true");
  mocks.read.mockReset();mocks.lookup.mockReset();
  mocks.read.mockImplementation(async(companyId,work)=>work({companyId}));
  mocks.lookup.mockImplementation(async(_token,session)=>session?.companyId===1
    ? {ok:true,po:{id:10,companyId:1,vendorId:20}}
    : {ok:false,code:"NOT_FOUND"});
});
afterEach(()=>vi.unstubAllEnvs());
describe("vendor token bootstrap with real company identity boundaries",()=>{
  it("uses both fixed readers and never the authentication pool",async()=>{
    expect(await resolveVendorInvoiceToken(token)).toMatchObject({ok:true,po:{companyId:1}});
    expect(mocks.read.mock.calls.map(call=>call[0])).toEqual([1,3]);
    expect(mocks.lookup.mock.calls.every(call=>call[1]!=null)).toBe(true);
  });
  it("rejects malformed capabilities before reading credentials",async()=>{
    expect(await resolveVendorInvoiceToken("invalid")).toEqual({ok:false,code:"MALFORMED"});
    expect(mocks.read).not.toHaveBeenCalled();expect(mocks.lookup).not.toHaveBeenCalled();
  });
  it("preserves expired and absent capability responses",async()=>{
    mocks.lookup.mockResolvedValue({ok:false,code:"EXPIRED"});
    expect(await resolveVendorInvoiceToken(token)).toEqual({ok:false,code:"EXPIRED"});
    mocks.lookup.mockResolvedValue({ok:false,code:"NOT_FOUND"});
    expect(await resolveVendorInvoiceToken(token)).toEqual({ok:false,code:"NOT_FOUND"});
  });
  it("refuses a returned foreign company or ambiguous token",async()=>{
    mocks.lookup.mockResolvedValue({ok:true,po:{id:10,companyId:1}});
    await expect(resolveVendorInvoiceToken(token)).rejects.toThrow("COMPANY_MISMATCH");
    mocks.lookup.mockImplementation(async(_token,session)=>({ok:true,po:{id:session.companyId,companyId:session.companyId}}));
    await expect(resolveVendorInvoiceToken(token)).rejects.toThrow("AMBIGUOUS");
  });
  it("does not fall back when a dedicated connection fails",async()=>{
    mocks.read.mockRejectedValue(new Error("DEV_FINANCE_UNAVAILABLE"));
    await expect(resolveVendorInvoiceToken(token)).rejects.toThrow("DEV_FINANCE_UNAVAILABLE");
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
  it("preserves the existing caller outside DEV company mode",async()=>{
    vi.stubEnv("APP_ENV","production");
    mocks.lookup.mockResolvedValue({ok:false,code:"NOT_FOUND"});
    expect(await resolveVendorInvoiceToken(token)).toEqual({ok:false,code:"NOT_FOUND"});
    expect(mocks.lookup).toHaveBeenCalledWith(token);expect(mocks.read).not.toHaveBeenCalled();
  });
});
