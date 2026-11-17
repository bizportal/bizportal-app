import { createFleetFinanceDevApp } from "./fleet-finance-dev-app";
import { closeFleetFinanceDevPool } from "@workspace/db/fleet-finance-dev";

if (process.env.APP_ENV !== "development" || process.env.FLEET_FINANCE_DATABASE_ENABLED_DEV !== "true") {
  throw new Error("FLEET_FINANCE_DEV_RUNTIME_DISABLED");
}
if (!process.env.FLEET_FINANCE_SERVICE_TOKEN?.trim()) {
  throw new Error("FLEET_FINANCE_DEV_SERVICE_TOKEN_REQUIRED");
}
const host = process.env.FLEET_FINANCE_DEV_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.FLEET_FINANCE_DEV_PORT || 19888);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  throw new Error("FLEET_FINANCE_DEV_PORT_INVALID");
}

const server = createFleetFinanceDevApp().listen(port, host, () => {
  console.info(JSON.stringify({ event: "fleet_finance_dev_listening", host, port }));
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 10_000).unref();
  server.close(async () => {
    try { await closeFleetFinanceDevPool(); } finally { clearTimeout(deadline); process.exit(0); }
  });
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
