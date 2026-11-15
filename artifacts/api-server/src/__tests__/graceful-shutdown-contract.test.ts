import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Issue #76 rollback contract must reuse the original PR72 shutdown helper,
// rather than install a second competing pair of process signal handlers.
const entry = readFileSync(resolve(process.cwd(), "src/index.ts"), "utf8");
const helper = readFileSync(resolve(process.cwd(), "src/lib/graceful-shutdown.ts"), "utf8");

describe("Issue #76 safe rollback uses existing graceful shutdown", () => {
  it("binds SIGTERM/SIGINT exactly once through the existing helper", () => {
    expect(entry).toContain("registerGracefulShutdown(server, stopBackgroundTimers");
    expect(helper).toContain('signalSource.once("SIGTERM", shutdown)');
    expect(helper).toContain('signalSource.once("SIGINT", shutdown)');
    expect(entry).not.toContain("shutdownApi(");
    expect(helper).toContain("stopBackgroundTimers()");
  });
  it("drains the HTTP server with a bounded fallback, retaining error handling", () => {
    expect(helper).toContain("server.close((error) =>");
    expect(helper).toContain("server.closeAllConnections()");
    expect(helper).toContain("const graceMs = options.graceMs ?? 30_000");
    expect(helper).toContain("finish(error ? 1 : 0)");
    expect(helper).toContain("onExit(code)");
  });
});
