import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import {
  getProductionSession,
  isSignedOtpDevEnabled,
  setProductionSessionCookie,
} from "./dev-auth";

const keys = ["APP_ENV", "NODE_ENV", "SESSION_SECRET", "BIZPORTAL_SESSION_SECRET", "BIZPORTAL_SIGNED_OTP_ENABLED_DEV"] as const;
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]])) as Record<(typeof keys)[number], string | undefined>;

function signedRequest(expiresAt = Date.now() + 60_000): Request {
  let value = "";
  const response = {
    append: (name: string, cookie: string) => {
      if (name === "Set-Cookie") value = cookie;
      return response;
    },
  } as unknown as Response;
  setProductionSessionCookie(response, {
    id: "otp-user-1",
    email: "Admin@Example.com",
    issuedAt: Date.now(),
    expiresAt,
  });
  return { headers: { cookie: value.split(";")[0] } } as unknown as Request;
}

describe("signed OTP bridge is fail-closed in development", () => {
  beforeEach(() => {
    process.env.APP_ENV = "development";
    process.env.NODE_ENV = "test";
    process.env.SESSION_SECRET = "dev-opt-in-test-secret-longer-than-32-characters";
    delete process.env.BIZPORTAL_SESSION_SECRET;
    delete process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV;
  });
  afterEach(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  it("rejects valid signed cookies when DEV opt-in is absent", () => {
    const request = signedRequest();
    expect(isSignedOtpDevEnabled()).toBe(false);
    expect(getProductionSession(request)).toBeNull();
  });

  it("requires an explicit signing secret even when opt-in flag is true", () => {
    const request = signedRequest();
    process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV = "true";
    delete process.env.SESSION_SECRET;
    expect(isSignedOtpDevEnabled()).toBe(false);
    expect(getProductionSession(request)).toBeNull();
  });

  it("accepts only signed nonexpired cookies under explicit DEV opt-in", () => {
    process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV = "true";
    expect(isSignedOtpDevEnabled()).toBe(true);
    const valid = getProductionSession(signedRequest());
    expect(valid).toMatchObject({ id: "otp-user-1", email: "admin@example.com" });
    expect(getProductionSession(signedRequest(Date.now() - 1000))).toBeNull();
    const tampered = signedRequest();
    tampered.headers.cookie = String(tampered.headers.cookie).replace("otp_user", "fake_user");
    // A malformed or modified cookie cannot change an authenticated actor.
    expect(getProductionSession({headers:{cookie:"bizportal_supabase_session=forged.invalid"}} as Request)).toBeNull();
  });

  it("never opts in DEV if NODE_ENV is production", () => {
    process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV = "true";
    process.env.NODE_ENV = "production";
    expect(isSignedOtpDevEnabled()).toBe(false);
    expect(getProductionSession(signedRequest())).toBeNull();
  });
});
