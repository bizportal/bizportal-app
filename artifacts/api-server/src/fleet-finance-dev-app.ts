import express, { type ErrorRequestHandler } from "express";
import fleetFinanceRouter from "./routes/fleet-finance-integration";

/** Private DEV host for the existing canonical integration, without app workers. */
export function createFleetFinanceDevApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  app.get("/healthz", (_req, res) => res.json({
    ok: true, service: "fleet-finance-dev", environment: "development",
    buildSha: process.env.FLEET_FINANCE_BUILD_SHA ?? "unbundled",
    buildDirty: process.env.FLEET_FINANCE_BUILD_DIRTY !== "false",
  }));
  app.use("/api/integrations/fleet", fleetFinanceRouter);
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error?.type === "entity.parse.failed" ? 400 : error?.type === "entity.too.large" ? 413 : 503;
    res.status(status).json({ error: status === 400 ? "Invalid JSON" : status === 413 ? "Payload too large" : "Fleet Finance unavailable" });
  };
  app.use(errors);
  return app;
}
