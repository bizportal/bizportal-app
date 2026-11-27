/** Real-PG cleanup regression. Only creates/drops generated QA DBs on localhost:55495. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(root, "artifacts/api-server/package.json"));
const pg = require("pg");
const pgPath = require.resolve("pg");
const { buildSync } = require("esbuild");
const built = buildSync({
  entryPoints: [path.join(root, "scripts/qa/po14-worker-cleanup.ts")],
  bundle: true, write: false, format: "esm", platform: "node", target: "node22",
});
const helperUrl = "data:text/javascript;base64," + Buffer.from(built.outputFiles[0].contents).toString("base64");
const bootstrapUrl = "postgres://postgres@127.0.0.1:55495/finance_approval_qa";

async function exercise(mode) {
  const databaseName = "po14_bank_ingestion_qa_" + randomBytes(6).toString("hex");
  assert.match(databaseName, /^po14_bank_ingestion_qa_[a-f0-9]{12}$/);
  const bootstrap = new pg.Client({ connectionString: bootstrapUrl,
    connectionTimeoutMillis: 4_000, query_timeout: 5_500, statement_timeout: 5_000 });
  await bootstrap.connect();
  try {
    await bootstrap.query(`create database "${databaseName}"`);
    // Delay the real driver's PostgreSQL Terminate write. This makes the old
    // end()+DROP FORCE race deterministic without mocking any database SQL.
    const source = `
      const pg=require(${JSON.stringify(pgPath)});
      (async()=>{
        const mode=${JSON.stringify(mode)}, databaseName=${JSON.stringify(databaseName)};
        const bootstrap=new pg.Client({connectionString:${JSON.stringify(bootstrapUrl)},
          connectionTimeoutMillis:4000,query_timeout:5500,statement_timeout:5000});
        await bootstrap.connect();
        const dsn='postgres://postgres@127.0.0.1:55495/'+databaseName;
        const pooledClients=new Set(); let client, pool, held, poolEndBeforeDisconnect=false;
        const delayedEnd=connection=>{
          const original=connection.connection.end.bind(connection.connection);
          connection.connection.end=()=>setTimeout(original,1500);
        };
        if(mode==='legacy'||mode==='graceful'){
          client=new pg.Client({connectionString:dsn}); await client.connect(); delayedEnd(client);
        }
        if(mode!=='legacy'){
          pool=new pg.Pool({connectionString:dsn,max:1,idleTimeoutMillis:0,
            connectionTimeoutMillis:4000,statement_timeout:5000,query_timeout:5500});
          pool.on('connect',connection=>{pooledClients.add(connection);
            connection.once('end',()=>pooledClients.delete(connection));});
          held=await pool.connect();
          if(mode==='graceful'||mode==='pool_end_early'){
            delayedEnd(held); held.release(); held=undefined;
            const original=pool.end.bind(pool);
            pool.end=()=>original().then(()=>{poolEndBeforeDisconnect=pooledClients.size>0;});
          }
        }
        if(mode==='legacy'){
          const closing=Promise.allSettled([client.end()]);
          await bootstrap.query('drop database if exists "'+databaseName+'" with (force)');
          await closing; await bootstrap.end(); console.log(JSON.stringify({oldCompleted:true}));
          return;
        }
        const {cleanupPo14WorkerDatabase}=await import(${JSON.stringify(helperUrl)});
        const cleanup=async()=>{
          const started=Date.now();
          const result=await cleanupPo14WorkerDatabase({databaseName,created:true,bootstrap,client,pool,pooledClients});
          if(held)held.release(true);
          console.log(JSON.stringify({...result,poolEndBeforeDisconnect,elapsedMs:Date.now()-started}));
        };
        if(mode==='sigterm'){
          const keepAlive=setInterval(()=>{},1000);
          process.once('SIGTERM',()=>{clearInterval(keepAlive);
            cleanup().then(()=>process.exit(143),()=>process.exit(1));});
          console.log(JSON.stringify({ready:true})); return;
        }
        await cleanup();
      })().catch(error=>{console.error(error.message);process.exitCode=1;});
    `;
    const outcome = await new Promise((resolve, reject) => {
      const started = Date.now();
      const child = spawn(process.execPath, ["-e", source], {
        shell: false, env: {}, stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "", sentSignal = false;
      const timeout = setTimeout(() => child.kill("SIGKILL"), 24_000);
      child.stdout.on("data", chunk => {
        stdout += chunk.toString();
        if (mode === "sigterm" && !sentSignal && stdout.includes('"ready":true')) {
          sentSignal = true; child.kill("SIGTERM");
        }
      });
      child.stderr.on("data", chunk => { stderr += chunk.toString(); });
      child.on("error", error => { clearTimeout(timeout); reject(error); });
      child.on("close", (code, signal) => {
        clearTimeout(timeout);
        const lastLine = stdout.trim().split("\n").filter(Boolean).at(-1);
        resolve({ code, signal, stderr, elapsedMs: Date.now() - started,
          result: lastLine ? JSON.parse(lastLine) : null });
      });
    });
    const remaining = await bootstrap.query("select count(*)::int n from pg_database where datname=$1", [databaseName]);
    return { ...outcome, remaining: remaining.rows[0].n };
  } finally {
    // This exact generated name is the only possible cleanup target.
    try {
      await bootstrap.query(`drop database if exists "${databaseName}" with (force)`);
      const remaining = await bootstrap.query("select count(*)::int n from pg_database where datname=$1", [databaseName]);
      assert.equal(remaining.rows[0].n, 0, "test cleanup must remove its exact generated database");
    } finally {
      await bootstrap.end();
    }
  }
}

test("old DROP FORCE ordering crashes through an unhandled real PostgreSQL error", async t => {
  const outcome = await exercise("legacy");
  assert.equal(outcome.code, 1);
  assert.match(outcome.stderr, /Unhandled 'error' event/);
  assert.match(outcome.stderr, /terminating connection due to administrator command/);
  t.diagnostic(JSON.stringify({ childExit: outcome.code, unhandledPgError: true,
    error: "terminating connection due to administrator command", databasesBeforeTestCleanup: outcome.remaining,
    databasesAfterTestCleanup: 0 }));
});

test("fixed cleanup awaits evidence-client and pool socket closure before dropping", async t => {
  const outcome = await exercise("graceful");
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(outcome.remaining, 0);
  assert.equal(outcome.result.removed, true);
  assert.equal(outcome.result.forced, false);
  assert.equal(outcome.result.connectionErrors, 0);
  t.diagnostic(JSON.stringify({ ...outcome.result, remaining: outcome.remaining }));
});

test("pool.end resolving early does not race DROP against its still-open sockets", async t => {
  const outcome = await exercise("pool_end_early");
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(outcome.result.poolEndBeforeDisconnect, true);
  assert.equal(outcome.result.forced, false);
  assert.equal(outcome.result.connectionErrors, 0);
  assert.equal(outcome.remaining, 0);
  t.diagnostic(JSON.stringify({ ...outcome.result, remaining: outcome.remaining }));
});

test("a checked-out pool connection is force-closed after a bounded drain", async t => {
  const outcome = await exercise("held");
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(outcome.result.forced, true);
  assert.ok(outcome.result.connectionErrors > 0);
  assert.ok(outcome.elapsedMs < 23_000);
  assert.equal(outcome.remaining, 0);
  t.diagnostic(JSON.stringify({ ...outcome.result, remaining: outcome.remaining }));
});

test("SIGTERM retains bounded cleanup and leaves no disposable database", async t => {
  const outcome = await exercise("sigterm");
  assert.equal(outcome.code, 143, outcome.stderr);
  assert.equal(outcome.signal, null);
  assert.equal(outcome.result.removed, true);
  assert.equal(outcome.result.forced, true);
  assert.ok(outcome.elapsedMs < 23_000);
  assert.equal(outcome.remaining, 0);
  t.diagnostic(JSON.stringify({ ...outcome.result, childExit: outcome.code, remaining: outcome.remaining }));
});

test("cleanup rejects every name outside the generated PO14 database pattern", async () => {
  const { cleanupPo14WorkerDatabase } = await import(helperUrl);
  for (const databaseName of ["postgres", "finance_approval_qa", "business", "po14_bank_ingestion_qa_;drop database postgres"]) {
    await assert.rejects(cleanupPo14WorkerDatabase({ databaseName, created: true }), /QA_CLEANUP_NAME_INVALID/);
  }
});
