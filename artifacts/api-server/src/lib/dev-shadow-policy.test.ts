import { describe, expect, it } from "vitest";
import { isBizPortalDevShadowMode, shouldScheduleEmbeddedJobs } from "./dev-shadow-policy";

describe("isolated DEV shadow startup policy", () => {
  it("keeps existing behavior unless shadow is explicitly requested", () => {
    expect(shouldScheduleEmbeddedJobs({ APP_ENV: "production" })).toBe(true);
    expect(shouldScheduleEmbeddedJobs({ APP_ENV: "development" })).toBe(true);
    expect(shouldScheduleEmbeddedJobs({ APP_ENV: "development", BIZPORTAL_SHADOW_MODE: "false" })).toBe(true);
  });

  it("disables all embedded schedulers for explicitly scoped DEV shadow", () => {
    const env = { APP_ENV: "development", NODE_ENV: "test", BIZPORTAL_SHADOW_MODE: "true" };
    expect(isBizPortalDevShadowMode(env)).toBe(true);
    expect(shouldScheduleEmbeddedJobs(env)).toBe(false);
  });

  it.each([
    { APP_ENV: "production", BIZPORTAL_SHADOW_MODE: "true" },
    { APP_ENV: "development", NODE_ENV: "production", BIZPORTAL_SHADOW_MODE: "true" },
    { BIZPORTAL_SHADOW_MODE: "true" },
    { APP_ENV: "test", BIZPORTAL_SHADOW_MODE: "true" },
  ])("fails closed for a shadow request outside explicit DEV %#", (env) => {
    expect(() => shouldScheduleEmbeddedJobs(env)).toThrow("BIZPORTAL_SHADOW_MODE_REQUIRES_DEV");
  });
});
