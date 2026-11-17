import { describe,expect,it } from "vitest";
import { assertOutboundSuperAdminIdentity } from "../lib/outboundSourceReuseDevAuth";
import type { DevAuthUser } from "../routes/dev-auth";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const user:DevAuthUser={
  id:"verified-user-1",email:"admin@example.invalid",
  firstName:null,lastName:null,role:"super_admin",companyId:1,
};
const session={id:user.id,email:user.email};
function check(patch:Partial<DevAuthUser>={}, companyId=1) {
  return assertOutboundSuperAdminIdentity({...user,...patch},session,companyId);
}
describe("PR95 unregistered signed-OTP DEV Super Admin principal boundary",()=>{
  it("requires the exact DB-verified signed identity and company",()=>{
    expect(check()).toEqual({id:user.id,email:user.email,companyId:1,role:"super_admin"});
    expect(()=>check({},2)).toThrow("PR95_OUTBOUND_COMPANY_SCOPE_FORBIDDEN");
    expect(()=>check({},0)).toThrow("PR95_OUTBOUND_COMPANY_INVALID");
  });
  it.each(["finance","admin","accounting","owner","accountant","employee","super_admin_disabled"])(
    "rejects non-Super Admin role %s",role=>{
      expect(()=>check({role})).toThrow("PR95_OUTBOUND_SUPER_ADMIN_REQUIRED");
    },
  );
  it("rejects signature ID/email mismatch, missing principal and tenantless identity",()=>{
    expect(()=>check({id:"forged"})).toThrow("PR95_OUTBOUND_SESSION_IDENTITY_MISMATCH");
    expect(()=>check({email:"forged@example.invalid"}))
      .toThrow("PR95_OUTBOUND_SESSION_IDENTITY_MISMATCH");
    expect(()=>check({companyId:null})).toThrow("PR95_OUTBOUND_COMPANY_SCOPE_FORBIDDEN");
    expect(()=>assertOutboundSuperAdminIdentity(null,session,1))
      .toThrow("PR95_OUTBOUND_SIGNED_SESSION_REQUIRED");
    expect(()=>assertOutboundSuperAdminIdentity(user,null,1))
      .toThrow("PR95_OUTBOUND_SIGNED_SESSION_REQUIRED");
  });
  it("the live resolver uses signed OTP only, revalidates user via existing DB reader, and has no legacy fallback",()=>{
    const source=readFileSync(fileURLToPath(new URL("../lib/outboundSourceReuseDevAuth.ts",import.meta.url)),"utf8");
    expect(source).toContain("isSignedOtpDevEnabled()");
    expect(source).toContain("getProductionSession(request)");
    expect(source).toContain("getProductionUser(session)");
    expect(source).toContain("assertOutboundSuperAdminIdentity(identity,session,requestedCompanyId)");
    expect(source).not.toContain("getDevSession");
    expect(source).not.toContain("req.body");
    expect(source).not.toContain("x-company-id");
  });
});
