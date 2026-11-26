import type pg from "pg";

const databasePattern = /^po14_bank_ingestion_qa_[a-f0-9]{12}$/;
const drainMs = 4_000;
const totalMs = 20_000;

function settleWithin(work: Promise<unknown>, milliseconds: number): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), Math.max(1, milliseconds));
    work.then(() => { clearTimeout(timer); resolve(true); }, () => { clearTimeout(timer); resolve(true); });
  });
}

/** Only closes this worker's handles and drops its exact disposable database. */
export async function cleanupPo14WorkerDatabase(options: {
  databaseName: string;
  created: boolean;
  bootstrap?: pg.Client;
  client?: pg.Client;
  pool?: pg.Pool;
  pooledClients?: Iterable<pg.PoolClient>;
}): Promise<{ removed: boolean; forced: boolean; connectionErrors: number }> {
  const { databaseName, created, bootstrap, client, pool } = options;
  if (!databasePattern.test(databaseName)) throw new Error("QA_CLEANUP_NAME_INVALID");
  const deadline = Date.now() + totalMs;
  const drainDeadline = Date.now() + drainMs;
  let connectionErrors = 0;
  let forced = false;
  let removed = !created;
  const watched = new WeakSet<pg.Client>();
  const onError = () => { connectionErrors += 1; };
  const watch = (connection: pg.Client) => {
    if (watched.has(connection)) return;
    watched.add(connection);
    // A PostgreSQL FATAL is an EventEmitter error, not a rejected end()
    // promise. These handlers exist only during deliberate worker cleanup.
    connection.on("error", onError);
  };
  if (client) watch(client);
  if (bootstrap) watch(bootstrap);
  for (const connection of options.pooledClients ?? []) watch(connection);
  if (pool) {
    pool.on("error", onError);
    pool.on("connect", watch);
  }

  const closing = Promise.allSettled([
    ...(client ? [Promise.resolve().then(() => client.end())] : []),
    ...(pool ? [Promise.resolve().then(() => pool.end())] : []),
  ]);
  const query = async (text: string, values: unknown[] = []) => {
    const remaining = deadline - Date.now();
    if (!bootstrap || remaining <= 0) throw new Error("QA_CLEANUP_TIMEOUT");
    // pg supports a per-query timeout; its QueryConfig declaration omits it.
    const config: pg.QueryConfig & { query_timeout: number } = {
      text, values, query_timeout: Math.min(5_500, remaining),
    };
    return bootstrap.query(config);
  };

  try {
    await settleWithin(closing, drainMs);
    if (created) {
      if (!bootstrap) throw new Error("QA_CLEANUP_BOOTSTRAP_MISSING");
      let sessions = 0;
      do {
        // pg-pool resolves end() after removing clients from its registry,
        // sometimes before their sockets close. Observe the actual database
        // sessions instead of assuming that pool.end() means disconnected.
        const result = await query(
          "select count(*)::int sessions from pg_stat_activity where datname=$1",
          [databaseName],
        );
        sessions = Number(result.rows[0].sessions);
        if (!sessions || Date.now() >= drainDeadline) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (true);

      forced = sessions > 0;
      try {
        await query(`drop database if exists "${databaseName}"${forced ? " with (force)" : ""}`);
      } catch (error) {
        // A late connection can finish opening after the session check. It is
        // still this worker's database; close that bounded race with FORCE.
        if (forced || (error as { code?: string }).code !== "55006") throw error;
        forced = true;
        await query(`drop database if exists "${databaseName}" with (force)`);
      }
      const result = await query("select 1 from pg_database where datname=$1", [databaseName]);
      removed = result.rows.length === 0;
      if (!removed) throw new Error("QA_CLEANUP_INCOMPLETE");
    }
    // FORCE may interrupt a checked-out pool client whose caller never releases
    // it after cancellation. Do not wait indefinitely for the pool promise.
    await settleWithin(closing, Math.min(1_000, Math.max(1, deadline - Date.now())));
    return { removed, forced, connectionErrors };
  } finally {
    if (bootstrap) {
      // Total cleanup remains <=22s, below the parent's 25s SIGKILL grace.
      await settleWithin(Promise.resolve().then(() => bootstrap.end()), 2_000);
    }
  }
}
