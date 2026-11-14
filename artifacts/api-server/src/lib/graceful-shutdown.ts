/**
 * Drain the HTTP listener on SIGTERM/SIGINT so a DEV release or rollback can
 * stop its old process. Never close or change external services or databases.
 */
type ClosableServer = {
  close(callback: (error?: Error) => void): unknown;
  closeAllConnections(): void;
};
type SignalName = "SIGTERM" | "SIGINT";
type SignalSource = {
  once(event: SignalName, listener: () => void): unknown;
};

export function registerGracefulShutdown(
  server: ClosableServer,
  stopBackgroundTimers: () => void,
  options: {
    signalSource?: SignalSource;
    onExit?: (code: number) => void;
    onError?: (error: unknown) => void;
    graceMs?: number;
  } = {},
): void {
  const signalSource = options.signalSource ?? process;
  const onExit = options.onExit ?? ((code: number) => process.exit(code));
  const onError = options.onError ?? (() => {});
  const graceMs = options.graceMs ?? 30_000;
  let stopping = false;
  let finished = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  function finish(code: number): void {
    if (finished) return;
    finished = true;
    if (timeout) clearTimeout(timeout);
    onExit(code);
  }

  function shutdown(): void {
    if (stopping) return;
    stopping = true;
    try {
      stopBackgroundTimers();
    } catch (error) {
      onError(error);
    }
    timeout = setTimeout(() => {
      try {
        server.closeAllConnections();
      } catch (error) {
        onError(error);
      }
      finish(1);
    }, graceMs);
    timeout.unref();

    try {
      server.close((error) => {
        if (error) onError(error);
        finish(error ? 1 : 0);
      });
    } catch (error) {
      onError(error);
      finish(1);
    }
  }

  signalSource.once("SIGTERM", shutdown);
  signalSource.once("SIGINT", shutdown);
}
