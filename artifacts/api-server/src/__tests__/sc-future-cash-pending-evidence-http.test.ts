import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

const mock = vi.hoisted(() => ({
  signed: true, enabled: true, actorRole: "owner", actorCompany: 1,
  actorEmail: "owner@example.test", accountValid: true,
  verifiedEvents: 0, pendingDoc: null as Record<string, unknown> | null,
  storageWrites: 0, storageDeletes: [] as string[],
  storageBytes: null as Buffer | null,
  wrongStoredBytes: false, dbInsertFailure: false, queries: [] as string[],
}));
// Each regression needs an independent authorization result, not a shared
// production rate-limit bucket; rate-limiting remains enabled in the route.
vi.mock("express-rate-limit", () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../routes/dev-auth", () => ({
  isDevelopmentEnvironment: () => process.env.APP_ENV === "development",
  isSignedOtpDevEnabled: () => mock.enabled,
  getProductionSession: () => mock.signed ? { id: "signed-owner-session" } : null,
  getProductionUser: async () => ({
    role: mock.actorRole, companyId: mock.actorCompany,
    email: mock.actorEmail,
  }),
}));
vi.mock("@workspace/db", () => ({
  pool: { query: async (sql: string, args: unknown[] = []) => {
    mock.queries.push(sql);
    if (sql.includes("from public.company_bank_accounts a")) return { rows: [{
      id: 18, name: "Kas Besar SC", account_type: "cash",
      is_active: true, opening_balance: "0.00",
      created_at: "2026-11-25 18:01:03.692741",
      notes: mock.accountValid ? "tidak digunakan untuk migrasi transaksi historis" : "",
      cash_coa_id: 75839, cash_coa_code: "1-1011-CST",
      coa_active: true, is_postable: true, is_header: false,
    }] };
    if (sql.includes("insert into public.sc_future_cash_documents")) {
      if (mock.dbInsertFailure) throw Error("INSERT_FAILED");
      mock.pendingDoc = { transaction_id: args[0], object_bucket: "private-uploads", object_path: args[1], document_sha256: args[2], source_fingerprint: args[3], direction: args[4], transaction_date: args[5], amount_cents: args[6], byte_length: args[7], event_type: null };
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes("from public.sc_future_cash_documents d") &&
        sql.includes("and not exists") && sql.includes("order by d.uploaded_at")) {
      const doc = mock.pendingDoc;
      return {rows: doc && doc.event_type === null ? [{
        transaction_id: doc.transaction_id, direction: doc.direction,
        transaction_date: doc.transaction_date, amount_cents: doc.amount_cents,
      }] : []};
    }
    if (sql.includes("from public.sc_future_cash_documents d") && sql.startsWith("select")) return { rows: mock.pendingDoc && mock.pendingDoc.transaction_id === args[0] ? [mock.pendingDoc] : [] };
    if (sql.includes("insert into public.sc_future_cash_document_events")) {
      if (!mock.pendingDoc || mock.pendingDoc.event_type !== null) return { rowCount: 0, rows: [] };
      mock.pendingDoc.event_type = "VERIFIED"; mock.verifiedEvents++;
      return { rowCount: 1, rows: [{ event_id: 1 }] };
    }
    throw Error("UNEXPECTED_SQL");
  } },
}));
vi.mock("../lib/objectStorage", () => ({
  ObjectStorageService: class {
    async uploadFutureCashPrivateEvidence(
      scope: { transactionId: string }, bytes: Buffer,
    ) {
      mock.storageWrites++;
      mock.storageBytes = Buffer.from(bytes);
      return {
        companyId: 1, accountId: 18, transactionId: scope.transactionId,
        objectPath: "/objects/uploads/44444444-4444-4444-8444-444444444444.pdf",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.length, status: "PENDING_VERIFICATION",
      };
    }
    async getObjectEntitySize() { return mock.storageBytes?.length ?? 0; }
    async getObjectEntityFile() {
      return {
        bucket: "private-uploads",
        path: "uploads/44444444-4444-4444-8444-444444444444.pdf",
      };
    }
    async downloadObject() {
      const file = mock.wrongStoredBytes
        ? Buffer.from("%PDF-1.7\nMODIFIED")
        : mock.storageBytes ?? Buffer.alloc(0);
      return { arrayBuffer: async () => Uint8Array.from(file).buffer as ArrayBuffer };
    }
    async deletePrivateEntity(path: string) { mock.storageDeletes.push(path); }
  },
}));

import route from "../routes/sc-future-cash-preview";

describe("Account18 pending receipt intake HTTP — no journal or approval", () => {
  const endpoint = "/api/cash-bank/sc-new/documents/pending";
  const origin = "https://dev-bizportal.cstlogistic.co.id";
  const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
  let server: Server, base: string;
  beforeAll(async () => {
    const app = express(); app.use(express.json()); app.use("/api", route);
    server = createServer(app); server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    if (!addr || typeof addr === "string") throw Error("PORT");
    base = "http://127.0.0.1:" + addr.port;
  });
  afterAll(async () =>
    await new Promise<void>(resolve => server.close(() => resolve())));
  beforeEach(() => {
    vi.stubEnv("APP_ENV", "development");
    mock.signed = true; mock.enabled = true;
    mock.actorRole = "owner"; mock.actorCompany = 1;
    mock.actorEmail = "owner@example.test"; mock.accountValid = true;
    mock.storageWrites = 0; mock.storageBytes = null;
    mock.pendingDoc = null; mock.verifiedEvents = 0;
    mock.wrongStoredBytes = false; mock.dbInsertFailure = false;
    mock.storageDeletes.length = 0; mock.queries.length = 0;
  });
  afterEach(() => vi.unstubAllEnvs());
  const post = (updates: Record<string, string> = {},
    from = origin, includeFile = true) => {
    const form = new FormData();
    const params = {
      companyId: "1", accountId: "18",
      date: "2026-11-27", direction: "OUT", amount: "50000.00",
      ...updates,
    };
    for (const [key, value] of Object.entries(params)) form.append(key, value);
    if (includeFile) form.append("file",
      new Blob([pdf], { type: "application/pdf" }), "receipt.pdf");
    return fetch(base + endpoint, { method: "POST", headers: { Origin: from }, body: form });
  };

  it("inserts only a pending UUID-bound document after exact private byte readback", async () => {
    const response = await post();
    expect(response.status).toBe(201);
    const result = await response.json() as { transactionId: string; status: string; postingAllowed: boolean };
    expect(result).toMatchObject({
      mode: "PENDING_PRIVATE_CASH_EVIDENCE_DEV",
      status: "PENDING_VERIFICATION",
      postingAllowed: false,
      historicalSheetConfig5: "NOT_USED_NONMIGRATION",
    });
    expect(result.transactionId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    expect(JSON.stringify(result)).not.toContain("sha256");
    expect(JSON.stringify(result)).not.toContain("objectPath");
    expect(mock.storageWrites).toBe(1);
    expect(mock.storageDeletes).toHaveLength(0);
    expect(mock.queries.filter(q => q.includes("insert into public.sc_future_cash_documents")))
      .toHaveLength(1);
    expect(mock.queries.some(q => /accounting_entries|bank_mutations|approval_requests|bank_sheet_configs/.test(q)))
      .toBe(false);
  });
  it("discovers signed Owner pending UUID from server even without browser storage", async () => {
    const uploaded=await (await post()).json() as {transactionId:string};
    const response=await fetch(base+endpoint);
    expect(response.status).toBe(200);
    const result=await response.json() as {
      mode:string;companyId:number;accountId:number;postingAllowed:boolean;
      documents:Array<{transactionId:string;status:string;date:string;direction:string;amount:string}>;
    };
    expect(result.mode).toBe("ACCOUNT18_PENDING_SERVER_RECORDS");
    expect(result).toMatchObject({companyId:1,accountId:18,postingAllowed:false});
    expect(result.documents).toEqual([{
      transactionId:uploaded.transactionId,status:"PENDING_VERIFICATION",
      date:"2026-11-27",direction:"OUT",amount:"50000.00",
    }]);
    expect(JSON.stringify(result)).not.toMatch(/object_path|sha256|uploaded_by|source_fingerprint/);
    expect(mock.queries.some(q=>q.includes("insert into public.sc_future_cash_document_events"))).toBe(false);
  });
  it("rejects unsigned, foreign-company and finance pending document discovery", async () => {
    mock.signed=false;
    expect((await fetch(base+endpoint)).status).toBe(401);
    mock.signed=true;mock.actorRole="finance";
    expect((await fetch(base+endpoint)).status).toBe(403);
    mock.actorRole="owner";mock.actorCompany=3;
    expect((await fetch(base+endpoint)).status).toBe(403);
    expect(mock.queries).toHaveLength(0);
  });
  it("accepts exactly five fields plus one file at multipart boundary", async () => {
    // There are six legitimate parts; Busboy may emit LIMIT_PART_COUNT when
    // parts equals the configured ceiling, so retain one spare slot.
    const response = await post();
    expect(response.status).toBe(201);
    expect(mock.storageWrites).toBe(1);
  });
  it("blocks wrong origin, PROD, missing signed session and non-owner before any write", async () => {
    expect((await post({}, "https://malicious.invalid")).status).toBe(403);
    vi.stubEnv("APP_ENV", "production");
    expect((await post()).status).toBe(404);
    vi.stubEnv("APP_ENV", "development");
    mock.signed = false;
    expect((await post()).status).toBe(401);
    mock.signed = true; mock.actorRole = "finance";
    expect((await post()).status).toBe(403);
    mock.actorRole = "owner"; mock.actorCompany = 3;
    expect((await post()).status).toBe(403);
    expect(mock.storageWrites).toBe(0);
    expect(mock.queries).toHaveLength(0);
  });
  it("rejects forged scope, injected proof keys and invalid source before storage", async () => {
    expect((await post({ companyId: "3" })).status).toBe(400);
    expect((await post({ accountId: "1" })).status).toBe(400);
    expect((await post({ ownerApproved: "true" })).status).toBe(400);
    expect((await post({ date: "2026-02-31" })).status).toBe(400);
    expect((await post({ amount: "50000.001" })).status).toBe(400);
    expect((await post({}, origin, false)).status).toBe(400);
    expect(mock.storageWrites).toBe(0);
    expect(mock.queries.filter(q => q.includes("insert into"))).toHaveLength(0);
  });
  it("removes new storage object and does not insert when stored bytes changed", async () => {
    mock.wrongStoredBytes = true;
    const response = await post();
    expect(response.status).toBe(503);
    expect(mock.storageDeletes).toHaveLength(1);
    expect(mock.queries.filter(q => q.includes("insert into"))).toHaveLength(0);
  });
  it("cleans up file after database write failure without authorizing posting", async () => {
    mock.dbInsertFailure = true;
    const response = await post();
    expect(response.status).toBe(503);
    expect(mock.storageDeletes).toHaveLength(1);
    expect(mock.queries.filter(q => q.includes("insert into public.sc_future_cash_documents")))
      .toHaveLength(1);
  });
  it("rejects invalid account baseline before any real upload", async () => {
    mock.accountValid = false;
    expect((await post()).status).toBe(409);
    expect(mock.storageWrites).toBe(0);
  });
  const verify = (transactionId: string, updates: Record<string, unknown> = {}, from = origin) =>
    fetch(base + "/api/cash-bank/sc-new/documents/verify", {
      method: "POST", headers: { Origin: from, "Content-Type": "application/json" },
      body: JSON.stringify({ companyId: 1, accountId: 18, transactionId, confirmed: true, ...updates }),
    });
  it("explicit signed Owner review appends only one verified event after byte readback", async () => {
    const uploaded = await post();
    const { transactionId } = await uploaded.json() as { transactionId: string };
    expect((await verify(transactionId)).status).toBe(201);
    expect((await verify(transactionId)).status).toBe(409);
    expect(mock.verifiedEvents).toBe(1);
    expect(mock.queries.some(q => /accounting_entries|bank_mutations|approval_requests|bank_sheet_configs/.test(q))).toBe(false);
  });
  it("blocks unconfirmed, unauthorized, foreign-origin and forged verification", async () => {
    const { transactionId } = await (await post()).json() as { transactionId: string };
    expect((await verify(transactionId, { confirmed: false })).status).toBe(400);
    expect((await verify(transactionId, { document_sha256: "forged" })).status).toBe(400);
    expect((await verify(transactionId, {}, "https://malicious.invalid")).status).toBe(403);
    mock.signed = false;
    expect((await verify(transactionId)).status).toBe(401);
    mock.signed = true; mock.actorRole = "finance";
    expect((await verify(transactionId)).status).toBe(403);
    expect(mock.verifiedEvents).toBe(0);
  });
  it("does not verify changed stored bytes or mismatched server source", async () => {
    const { transactionId } = await (await post()).json() as { transactionId: string };
    mock.wrongStoredBytes = true;
    expect((await verify(transactionId)).status).toBe(409);
    mock.wrongStoredBytes = false;
    if (!mock.pendingDoc) throw Error("MISSING_FIXTURE");
    mock.pendingDoc.source_fingerprint = "0".repeat(64);
    expect((await verify(transactionId)).status).toBe(409);
    expect(mock.verifiedEvents).toBe(0);
  });

});
