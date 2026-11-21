import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Source-only contract: no database access, authentication or writes in tests.
const healthSource = readFileSync(resolve(process.cwd(), "src/routes/health.ts"), "utf8");
const poolSource = readFileSync(resolve(process.cwd(), "../../lib/db/src/index.ts"), "utf8");

describe("BizPortal DEV PostgreSQL diagnostic safeguards", () => {
  it("keeps liveness separate from actual database readiness", () => {
    const start = healthSource.indexOf('router.get("/health/ready"');
    expect(start).toBeGreaterThan(0);
    const ready = healthSource.slice(start, healthSource.indexOf("export default", start));
    expect(ready).toContain('await pool.query<{ ok: number }>("select 1 as ok")');
    expect(ready).toContain("getRuntimeDatabaseUrl()");
    expect(ready).toContain("res.status(503).json");
    expect(ready).toContain('database: "unavailable-or-auth-not-ready"');
  });

  it("never returns raw PostgreSQL error messages on public readiness failures", () => {
    const start = healthSource.indexOf('router.get("/health/ready"');
    const ready = healthSource.slice(start, healthSource.indexOf("export default", start));
    expect(ready).toContain('error: "RUNTIME_READINESS_UNAVAILABLE"');
    expect(ready).not.toContain("error.message");
    expect(ready).not.toContain("String(error)");
    expect(ready).not.toContain("err.stack");
  });

  it("labels only DEV as cst-bizportal-dev while PROD retains the original label", () => {
    expect(poolSource).toContain('application_name: process.env.APP_ENV?.trim().toLowerCase() === "development"');
    expect(poolSource).toContain('? "cst-bizportal-dev"');
    expect(poolSource).toContain(': "cst-bizportal"');
    expect(poolSource).not.toContain('application_name: "cst-bizportal",');
  });
});
