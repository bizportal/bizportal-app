import { describe, expect, it } from "vitest";
import type { AuthUser } from "@shared/api-client-react";
import { confirmOtpServerSession } from "@/lib/confirmOtpServerSession";

const owner = {
  id: "owner-108",
  email: "admin@example.com",
  role: "super_admin",
} as AuthUser;

function sessionResponse(status: number, user?: AuthUser) {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const request = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    return { ok: status === 200, status, json: async () => ({ user }) } as Response;
  };
  return { request, calls };
}

describe("signed OTP session handshake before displaying logged-in Owner", () => {
  it("accepts the matching server-authenticated Owner with cookie credentials", async () => {
    const stub = sessionResponse(200, owner);
    expect(await confirmOtpServerSession(owner, "admin@example.com", stub.request)).toEqual(owner);
    expect(stub.calls).toEqual([{
      input: "/api/auth/user",
      init: { credentials: "include", cache: "no-store" },
    }]);
  });

  it("refuses a 401 even if the OTP response had an Owner identity", async () => {
    const stub = sessionResponse(401);
    expect(await confirmOtpServerSession(owner, "admin@example.com", stub.request)).toBeNull();
  });

  it("refuses a different account or downgraded role", async () => {
    const other = sessionResponse(200, { ...owner, id: "another-owner" });
    expect(await confirmOtpServerSession(owner, "admin@example.com", other.request)).toBeNull();
    const wrongRole = sessionResponse(200, { ...owner, role: "admin" });
    expect(await confirmOtpServerSession(owner, "admin@example.com", wrongRole.request)).toBeNull();
  });

  it("refuses a session from a different email or an empty profile", async () => {
    const wrongEmail = sessionResponse(200, { ...owner, email: "someone@example.com" });
    expect(await confirmOtpServerSession(owner, "admin@example.com", wrongEmail.request)).toBeNull();
    const missing = sessionResponse(200);
    expect(await confirmOtpServerSession(owner, "admin@example.com", missing.request)).toBeNull();
  });
});
