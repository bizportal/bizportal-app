import { describe, expect, it } from "vitest";
import { shouldShowDevLogout } from "./devOtpLogoutVisibility";

describe("Logout on signed-OTP DEV deployment", () => {
  it("shows logout in a production-built Hostinger DEV app requiring OTP", () => {
    expect(shouldShowDevLogout(false, true)).toBe(true);
  });
  it("shows logout on a local development build", () => {
    expect(shouldShowDevLogout(true, false)).toBe(true);
  });
  it("does not add a DEV-only logout button on PROD", () => {
    expect(shouldShowDevLogout(false, false)).toBe(false);
  });
});
