import { createServer } from "node:http";
import { Writable } from "node:stream";
import pino from "pino";
import pinoHttp from "pino-http";
import { describe, expect, it } from "vitest";
import { serializeHttpRequestForLog, vendorFailureLog } from "./vendorCapabilityLogPrivacy";

const token = "a98f".repeat(16);
describe("vendor capability log privacy", () => {
  it.each([token, "malformed-token", "bad%2Fencoded%20token"])("redacts a valid or malformed token segment: %s", capability => {
    expect(serializeHttpRequestForLog({ url: `/api/mkt/vendor-invoice/${capability}/invoices/42/submit?secret=${token}` }).url)
      .toBe("/api/mkt/vendor-invoice/[redacted]/invoices/42/submit");
  });
  it("preserves unrelated route logging and handles Express's case-insensitive route", () => {
    expect(serializeHttpRequestForLog({ url: "/api/health?probe=true" }).url).toBe("/api/health");
    expect(serializeHttpRequestForLog({ url: `/API/MKT/VENDOR-INVOICE/${token}` }).url)
      .toBe("/API/MKT/VENDOR-INVOICE/[redacted]");
  });
  it("emits no token from real pino HTTP success/error logs or nested database errors", async () => {
    const chunks: string[] = [];
    const sink = new Writable({ write(chunk, _encoding, done) { chunks.push(String(chunk)); done(); } });
    const logger = pino({ level: "info" }, sink);
    const middleware = pinoHttp({ logger, serializers: { req: serializeHttpRequestForLog } });
    const databaseError = Object.assign(new Error(`query failed token=${token}`), {
      query: "select ... vendor_token=$1", params: [token],
      cause: Object.assign(new Error(`private cause ${token}`), { code: "40P01", params: [token] }),
    });
    const server = createServer((request, response) => middleware(request, response, () => {
      if (request.url?.endsWith("/submit")) {
        logger.warn(vendorFailureLog("invoice_submit", databaseError), "vendor operation failed");
        response.statusCode = 503;
      }
      response.end("ok");
    }));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS");
      for (const suffix of ["/invoices", "/invoices/42/submit"]) {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/mkt/vendor-invoice/${token}${suffix}`);
        await response.text();
      }
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    const emitted = chunks.join("");
    expect(emitted).not.toContain(token);
    expect(emitted).not.toContain("private cause");
    expect(emitted).not.toContain("vendor_token=$1");
    const rows = emitted.trim().split("\n").map(line => JSON.parse(line));
    expect(rows.filter(row => row.req).map(row => row.req.url)).toEqual([
      "/api/mkt/vendor-invoice/[redacted]/invoices",
      "/api/mkt/vendor-invoice/[redacted]/invoices/42/submit",
    ]);
    expect(rows.find(row => row.operation === "invoice_submit")).toMatchObject({
      errorCode: "VENDOR_DATABASE_ERROR", sqlState: "40P01",
    });
  });
});
