import pino from "pino";

// Embedded original Accounting owner may run in Portal DEV without pino-pretty.
// This opt-in changes only the logging transport, not posting permissions.
const useJsonOnly = process.env.NODE_ENV === "production" ||
  process.env.CST_ACCOUNTING_OWNER_JSON_LOG_DEV === "true";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  ...(useJsonOnly
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
