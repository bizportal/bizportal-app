import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerGracefulShutdown } from "./graceful-shutdown";

afterEach(() => {
  vi.useRealTimers();
});

describe("DEV API graceful shutdown for reversible cutover", () => {
  it("stops timers and closes the real listening HTTP server on SIGTERM", async () => {
    const server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const source = new EventEmitter();
    const stopTimers = vi.fn();
    const exit = vi.fn();
    registerGracefulShutdown(server, stopTimers, {
      signalSource: source,
      onExit: exit,
      graceMs: 2000,
    });

    source.emit("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(server.listening).toBe(false);
    expect(stopTimers).toHaveBeenCalledTimes(1);
    source.emit("SIGINT");
    expect(stopTimers).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("closes hanging connections and fails the process after its grace period", async () => {
    vi.useFakeTimers();
    const source = new EventEmitter();
    const stopTimers = vi.fn();
    const exit = vi.fn();
    const server = {
      close: vi.fn((_callback: (error?: Error) => void) => {}),
      closeAllConnections: vi.fn(),
    };
    registerGracefulShutdown(server, stopTimers, {
      signalSource: source,
      onExit: exit,
      graceMs: 100,
    });
    source.emit("SIGTERM");
    source.emit("SIGINT");
    expect(server.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(101);
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(stopTimers).toHaveBeenCalledTimes(1);
  });
});
