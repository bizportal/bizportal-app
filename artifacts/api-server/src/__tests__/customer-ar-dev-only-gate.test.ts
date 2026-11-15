import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const route = readFileSync(new URL("../routes/customer-ar-match-preview.ts", import.meta.url), "utf8");
const routerIndex = readFileSync(new URL("../routes/index.ts", import.meta.url), "utf8");
describe("Customer AR preview is DEV only and read-only", () => {
  it("returns 404 outside development before querying any invoices or mutations", () => {
    const begin = route.indexOf('router.get("/sales/customer-invoices/auto-match-preview"');
    expect(begin).toBeGreaterThanOrEqual(0);
    const guard = route.slice(begin, begin + 300);
    expect(guard).toContain("if (!isDevelopmentEnvironment())");
    expect(guard).toContain("response.status(404)");
  });
  it("retains the default-OFF feature gate without unconditional Customer AR mounts", () => {
    expect(routerIndex).toContain('BIZPORTAL_CUSTOMER_AR_PREVIEW_ENABLED_DEV');
    expect(routerIndex).toContain('import("./customer-ar-match-preview")');
    expect(routerIndex).not.toMatch(/router\.use\(\s*customerArMatchPreviewRouter\s*\)/);
  });
  it("mounts the authenticated driver geofence router exactly once", () => {
    expect(routerIndex.match(/router\.use\(driverGeofenceRouter\);/g)).toHaveLength(1);
    expect(routerIndex.match(/import driverGeofenceRouter from/g)).toHaveLength(1);
  });
  it("never adds a second payment or Accounting write endpoint", () => {
    expect(route).not.toMatch(/router\.(post|patch|put|delete)\(/);
    expect(route).toContain('autoApproveEnabled: false');
    expect(route).toContain('autoPostEnabled: false');
  });
});
