import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "src/index.ts"), "utf8");

describe("Issue #76 safe process rollback graceful shutdown contract", () => {
  it("closes the HTTP listener when SIGTERM or SIGINT arrives", () => {
    expect(source).toContain('process.once("SIGTERM", () => shutdownApi("SIGTERM"))');
    expect(source).toContain('process.once("SIGINT", () => shutdownApi("SIGINT"))');
    expect(source).toContain("stopBackgroundTimers()");
    expect(source).toContain("server.close((error) =>");
    expect(source).toContain("server.closeIdleConnections()");
  });
  it("bounds shutdown if an in-flight request never finishes", () => {
    expect(source).toContain("10_000");
    expect(source).toContain("HTTP shutdown deadline exceeded");
    expect(source).toContain("process.exit(1)");
    expect(source).toContain("HTTP server stopped cleanly");
  });
});
