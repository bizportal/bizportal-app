import { describe, expect, it } from "vitest";
import {
  recurringVoidEnabled, recurringVoidCompanyId, authorizeRecurringVoid, paymentMatchesCompany,
} from "./recurring-void-guard";

describe("Sport Center recurring void fail-closed authorization", () => {
  it("is disabled by default, outside production, or with an unapproved flag", () => {
    expect(recurringVoidEnabled({})).toBe(false);
    expect(recurringVoidEnabled({APP_ENV:"production"})).toBe(false);
    expect(recurringVoidEnabled({APP_ENV:"development", SPORT_CENTER_RECURRING_VOID_ENABLED:"true"})).toBe(false);
    expect(recurringVoidEnabled({APP_ENV:"production", SPORT_CENTER_RECURRING_VOID_ENABLED:"TRUE"})).toBe(false);
    expect(recurringVoidEnabled({APP_ENV:"production", SPORT_CENTER_RECURRING_VOID_ENABLED:"true"})).toBe(true);
  });
  it("requires one valid explicit company scope", () => {
    for (const invalid of [undefined,null,"","0","-1","1.5","all","01",1,"9007199254740992"]) {
      expect(recurringVoidCompanyId(invalid)).toBeNull();
    }
    expect(recurringVoidCompanyId("12")).toBe(12);
  });
  it("refuses staff, finance, admin, anonymous and cross-tenant actors", () => {
    for (const role of ["staff","finance","accounting","admin","", "member"]) {
      expect(authorizeRecurringVoid({email:"actor@example.test",role,companyId:1},1)).toBe(false);
    }
    expect(authorizeRecurringVoid(null,1)).toBe(false);
    expect(authorizeRecurringVoid({email:" ",role:"owner",companyId:null},1)).toBe(false);
    expect(authorizeRecurringVoid({email:"owner@example.test",role:"owner",companyId:2},1)).toBe(false);
    expect(authorizeRecurringVoid({email:"owner@example.test",role:"owner",companyId:1},1)).toBe(true);
    expect(authorizeRecurringVoid({email:"global@example.test",role:"super_admin",companyId:null},1)).toBe(true);
  });
  it("requires exactly one matching company row to authorize any reversal", () => {
    expect(paymentMatchesCompany([],1)).toBe(false);
    expect(paymentMatchesCompany([{company_id:2}],1)).toBe(false);
    expect(paymentMatchesCompany([{company_id:1},{company_id:1}],1)).toBe(false);
    expect(paymentMatchesCompany([{company_id:null}],1)).toBe(false);
    expect(paymentMatchesCompany([{company_id:1}],1)).toBe(true);
  });
});
