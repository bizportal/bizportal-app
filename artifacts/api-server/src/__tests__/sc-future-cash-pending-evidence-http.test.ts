import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

const mock = vi.hoisted(() => ({
  signed: true, enabled: true, actorRole: "owner", actorCompany: 1,
  actorEmail: "owner@example.test", accountValid: true,
  otpRows: [] as unknown[][], otpInvalidations: [] as string[], smtpCalls: [] as unknown[][],
  smtpFail: false, recentOtpCount: 0, contraValid: true, approved: false,
  otpConsumed: false, otpAttempts: 0, otpExpired: false, otpDisabled: false,
  approvalFail: false, approvalRows: [] as unknown[][],
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
vi.mock("../lib/smtp", () => ({ sendFutureCashVoucherOtpEmail: async (...args: unknown[]) => {
  mock.smtpCalls.push(args); if (mock.smtpFail) throw Error("SMTP_FAILED");
} }));
vi.mock("@workspace/db", () => {
  let snapshot: { consumed:boolean; attempts:number; approved:boolean; count:number } | null = null;
  const query = async (sql: string, args: unknown[] = []) => {
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
    if (sql.includes("ev.event_type='VERIFIED'") &&
        sql.includes("order by d.uploaded_at")) {
      const doc=mock.pendingDoc;
      return { rows: doc && doc.event_type==="VERIFIED" && !mock.approved ? [{
        transaction_id:doc.transaction_id,direction:doc.direction,
        transaction_date:doc.transaction_date,amount_cents:doc.amount_cents,
      }] : [] };
    }
    if (sql.includes("from public.sc_future_cash_documents d") &&
        sql.includes("and not exists") && sql.includes("order by d.uploaded_at")) {
      const doc = mock.pendingDoc;
      return {rows: doc && doc.event_type === null ? [{
        transaction_id: doc.transaction_id, direction: doc.direction,
        transaction_date: doc.transaction_date, amount_cents: doc.amount_cents,
      }] : []};
    }
    if (sql.toLowerCase().includes("from public.sc_future_cash_documents d") && sql.trimStart().toLowerCase().startsWith("select")) return { rows: mock.pendingDoc && mock.pendingDoc.transaction_id === args[0] ? [mock.pendingDoc] : [] };
    if (sql.includes("from public.sc_future_cash_documents where")) {
      const match = mock.pendingDoc && mock.pendingDoc.transaction_id === args[0];
      return { rowCount: match ? 1 : 0, rows: match ? [mock.pendingDoc] : [] };
    }
    if (sql.includes("from public.chart_of_accounts where")) return { rows: [{
      id: args[0], company_id: 1, code: "5-1000", name: "Expense",
      is_active: mock.contraValid, is_postable: true, is_header: false,
    }] };
    if (sql.includes("from public.approval_requests")) return { rowCount: mock.approved ? 1 : 0, rows: [] };
    if (sql.includes("select count(*)::text as count from public.bizportal_email_otp_codes"))
      return { rows: [{ count: String(mock.recentOtpCount) }] };
    if (sql.includes("select event_id::text from public.sc_future_cash_document_events"))
      return { rows: mock.pendingDoc?.event_type === "VERIFIED" ? [{ event_id: "1" }] : [] };
    if (sql.includes("select id::text,code_hash from public.bizportal_email_otp_codes")) {
      const otp = mock.otpRows.at(-1);
      return { rows: otp && otp[0] === args[0] && otp[2] === args[1] &&
        !mock.otpConsumed && !mock.otpExpired && !mock.otpDisabled && mock.otpAttempts < 5
        ? [{ id:"101", code_hash:otp[3] }] : [] };
    }
    if (sql.includes("set attempts=attempts+1")) {
      mock.otpAttempts++; return {rowCount:1,rows:[]};
    }
    if (sql.includes("set verified_at=clock_timestamp()")) {
      if (mock.otpConsumed || mock.otpExpired || mock.otpDisabled) return {rowCount:0,rows:[]};
      mock.otpConsumed=true; return {rowCount:1,rows:[{id:"101",verified_at:new Date()}]};
    }
    if (sql.includes("insert into public.approval_requests")) {
      if(mock.approvalFail) throw Error("APPROVAL_INSERT_FAILED");
      mock.approvalRows.push(args); mock.approved=true;
      return {rowCount:1,rows:[{id:55}]};
    }
    if (sql.includes("update public.bizportal_email_otp_codes")) {
      mock.otpInvalidations.push(sql); mock.otpDisabled=true; return { rowCount: 1, rows: [] };
    }
    if (sql.includes("insert into public.bizportal_email_otp_codes")) {
      mock.otpRows.push(args); mock.otpDisabled=false; mock.otpConsumed=false; mock.otpAttempts=0; return { rowCount: 1, rows: [{ id: "101" }] };
    }
    if (sql==="BEGIN") {
      snapshot={consumed:mock.otpConsumed,attempts:mock.otpAttempts,approved:mock.approved,count:mock.approvalRows.length};
      return {rows:[]};
    }
    if (sql==="ROLLBACK") {
      if(snapshot){mock.otpConsumed=snapshot.consumed;mock.otpAttempts=snapshot.attempts;
        mock.approved=snapshot.approved;mock.approvalRows.length=snapshot.count;}
      snapshot=null;return {rows:[]};
    }
    if (sql==="COMMIT") {snapshot=null;return {rows:[]};}
    if (sql.includes("pg_advisory_xact_lock")) return {rows:[]};
    if (sql.includes("insert into public.sc_future_cash_document_events")) {
      if (!mock.pendingDoc || mock.pendingDoc.event_type !== null) return { rowCount: 0, rows: [] };
      mock.pendingDoc.event_type = "VERIFIED"; mock.pendingDoc.event_at = "2026-11-27T00:00:00.000Z";
      mock.pendingDoc.actor_email = mock.actorEmail; mock.pendingDoc.company_id=1; mock.pendingDoc.account_id=18; mock.pendingDoc.cash_coa_id=75839; mock.verifiedEvents++;
      return { rowCount: 1, rows: [{ event_id: 1 }] };
    }
    throw Error("UNEXPECTED_SQL");
  };
  let checkedOut = false;
  return { pool: { query: async (sql: string, args: unknown[] = []) => {
    if (checkedOut) throw Error("SINGLE_CONNECTION_POOL_EXHAUSTED");
    return query(sql, args);
  }, connect: async () => {
    if (checkedOut) throw Error("SINGLE_CONNECTION_POOL_EXHAUSTED");
    checkedOut = true;
    return { query, release: () => { checkedOut = false; } };
  } } };
});
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
    mock.otpRows.length=0; mock.otpInvalidations.length=0; mock.smtpCalls.length=0;
    mock.smtpFail=false; mock.recentOtpCount=0; mock.contraValid=true; mock.approved=false;
    mock.otpConsumed=false;mock.otpAttempts=0;mock.otpExpired=false;mock.otpDisabled=false;
    mock.approvalFail=false;mock.approvalRows.length=0;
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
  it("lists only VERIFIED and unapproved vouchers from signed Owner registry", async () => {
    const id="25088529-6fa1-4ddb-80bf-390c157e64d4";
    mock.pendingDoc={
      transaction_id:id,event_type:"VERIFIED",direction:"IN",
      transaction_date:"2026-11-27",amount_cents:"1000000",
    };
    const url=base+"/api/cash-bank/sc-new/documents/verified";
    const response=await fetch(url);
    expect(response.status).toBe(200);
    const data=await response.json() as {
      mode:string;companyId:number;accountId:number;postingAllowed:boolean;
      documents:Array<{transactionId:string;status:string;date:string;direction:string;amount:string}>;
    };
    expect(data).toMatchObject({
      mode:"ACCOUNT18_VERIFIED_UNAPPROVED_SERVER_RECORDS",
      companyId:1,accountId:18,postingAllowed:false,
    });
    expect(data.documents).toEqual([{
      transactionId:id,status:"VERIFIED",date:"2026-11-27",
      direction:"IN",amount:"10000.00",
    }]);
    expect(JSON.stringify(data)).not.toMatch(/document_sha256|object_path|uploaded_by|otpEvidenceId/);
    mock.approved=true;
    expect(((await (await fetch(url)).json()) as {documents:unknown[]}).documents).toEqual([]);
    mock.approved=false;
    mock.pendingDoc.event_type=null;
    expect(((await (await fetch(url)).json()) as {documents:unknown[]}).documents).toEqual([]);
    expect(mock.queries.some(q=>q.includes("insert into"))).toBe(false);
  });
  it("denies unsigned, finance, and foreign-company verified voucher lists", async()=>{
    const url=base+"/api/cash-bank/sc-new/documents/verified";
    mock.signed=false;
    expect((await fetch(url)).status).toBe(401);
    mock.signed=true;mock.actorRole="finance";
    expect((await fetch(url)).status).toBe(403);
    mock.actorRole="owner";mock.actorCompany=2;
    expect((await fetch(url)).status).toBe(403);
    expect(mock.queries).toHaveLength(0);
  });
  it("accepts exactly five fields plus one file at multipart boundary", async () => {
    // There are six legitimate parts; Busboy may emit LIMIT_PART_COUNT when
    // parts equals the configured ceiling, so retain one spare slot.
    const response = await post();
    expect(response.status).toBe(201);
    expect(mock.storageWrites).toBe(1);
  });
  it("denies private pending proof download to unsigned, finance and foreign-company callers", async () => {
    const url=base+"/api/cash-bank/sc-new/documents/25088529-6fa1-4ddb-80bf-390c157e64d4/download";
    mock.signed=false;
    expect((await fetch(url)).status).toBe(401);
    mock.signed=true;mock.actorRole="finance";
    expect((await fetch(url)).status).toBe(403);
    mock.actorRole="owner";mock.actorCompany=2;
    expect((await fetch(url)).status).toBe(403);
    expect(mock.storageWrites).toBe(0);
    expect(mock.queries).toHaveLength(0);
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

  const sendOtp = (transactionId: string, updates: Record<string, unknown> = {}, from = origin) =>
    fetch(base + "/api/cash-bank/sc-new/voucher/otp/send", {
      method: "POST", headers: { Origin: from, "Content-Type": "application/json" },
      body: JSON.stringify({ companyId: 1, accountId: 18, transactionId, counterCoaId: 902, ...updates }),
    });
  const verifiedDoc = async () => {
    const { transactionId } = await (await post()).json() as {transactionId:string};
    expect((await verify(transactionId)).status).toBe(201);
    return transactionId;
  };
  it("issues hashed scoped OTP to signed Owner only after document verification", async () => {
    const { transactionId } = await (await post()).json() as {transactionId:string};
    expect((await sendOtp(transactionId)).status).toBe(409);
    expect(mock.smtpCalls).toHaveLength(0);
    expect((await verify(transactionId)).status).toBe(201);
    const response = await sendOtp(transactionId);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({transactionId,counterCoaId:902,status:"OTP_SENT",expiresInSeconds:300,postingAllowed:false});
    expect(mock.otpRows).toHaveLength(1);
    expect(mock.smtpCalls).toHaveLength(1);
    expect(mock.smtpCalls[0]![0]).toBe("owner@example.test");
    expect(mock.smtpCalls[0]![2]).toBe(transactionId);
    expect(mock.otpRows[0]![2]).toBe("sc-cash-voucher:"+transactionId+":"+mock.pendingDoc?.source_fingerprint+":902");
    expect(String(mock.otpRows[0]![3])).toMatch(/^\$2[aby]\$/);
    expect(mock.otpRows[0]![3]).not.toBe(mock.smtpCalls[0]![1]);
    expect(mock.otpInvalidations.every(q=>!q.includes("set verified_at"))).toBe(true);
    expect(mock.queries.some(q=>/insert into public\.(approval_requests|accounting_entries|bank_mutations)/.test(q))).toBe(false);
  });
  it("rejects unauthorized or forged voucher scope", async () => {
    const id=await verifiedDoc();
    expect((await sendOtp(id,{email:"other@example.test"})).status).toBe(400);
    expect((await sendOtp(id,{counterCoaId:75839})).status).toBe(400);
    expect((await sendOtp(id,{},"https://malicious.invalid")).status).toBe(403);
    mock.signed=false; expect((await sendOtp(id)).status).toBe(401);
    expect(mock.smtpCalls).toHaveLength(0);
  });
  it("rejects tampered bytes, unavailable COA, existing approval and rate excess", async () => {
    const id=await verifiedDoc();
    mock.wrongStoredBytes=true; expect((await sendOtp(id)).status).toBe(409);
    mock.wrongStoredBytes=false; mock.contraValid=false; expect((await sendOtp(id)).status).toBe(409);
    mock.contraValid=true; mock.approved=true; expect((await sendOtp(id)).status).toBe(409);
    mock.approved=false; mock.recentOtpCount=3; expect((await sendOtp(id)).status).toBe(429);
    expect(mock.otpRows).toHaveLength(0); expect(mock.smtpCalls).toHaveLength(0);
  });
  it("disables failed delivery without marking OTP verified", async () => {
    const id=await verifiedDoc(); mock.smtpFail=true;
    expect((await sendOtp(id)).status).toBe(503);
    expect(mock.otpRows).toHaveLength(1);
    expect(mock.otpInvalidations).toHaveLength(2);
    expect(mock.otpInvalidations[1]).toContain("attempts=5,code_hash=null");
    expect(mock.otpInvalidations.every(q=>!q.includes("set verified_at"))).toBe(true);
  });

  const confirmOtp = (transactionId:string, code:string, updates:Record<string,unknown>={}, from=origin) =>
    fetch(base+"/api/cash-bank/sc-new/voucher/otp/confirm",{
      method:"POST",headers:{Origin:from,"Content-Type":"application/json"},
      body:JSON.stringify({companyId:1,accountId:18,transactionId,counterCoaId:902,code,...updates}),
    });
  const issuedVoucher=async()=>{
    const id=await verifiedDoc();
    expect((await sendOtp(id)).status).toBe(202);
    return {id,code:String(mock.smtpCalls[0]![1])};
  };
  it("consumes exact voucher OTP and records one scoped approval without posting",async()=>{
    const {id,code}=await issuedVoucher();
    const response=await confirmOtp(id,code);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({transactionId:id,counterCoaId:902,status:"APPROVED",postingAllowed:false});
    expect(mock.otpConsumed).toBe(true);
    expect(mock.approvalRows).toHaveLength(1);
    expect(mock.approvalRows[0]!.slice(0,4)).toEqual([1,id,"owner@example.test","owner"]);
    expect(JSON.parse(String(mock.approvalRows[0]![4]))).toEqual({
      transactionId:id,sourceFingerprint:mock.pendingDoc?.source_fingerprint,accountId:18,counterCoaId:902,otpEvidenceId:"101",
    });
    expect((await confirmOtp(id,code)).status).toBe(409);
    expect(mock.approvalRows).toHaveLength(1);
    expect(mock.queries.some(q=>/insert into public\.(accounting_entries|bank_mutations)/.test(q))).toBe(false);
  });
  it("rejects wrong COA, forged fields, foreign origin and unauthorized caller",async()=>{
    const {id,code}=await issuedVoucher();
    expect((await confirmOtp(id,code,{counterCoaId:903})).status).toBe(400);
    expect((await confirmOtp(id,code,{approvedBy:"forged"})).status).toBe(400);
    expect((await confirmOtp(id,code,{},"https://malicious.invalid")).status).toBe(403);
    mock.signed=false;expect((await confirmOtp(id,code)).status).toBe(401);
    mock.signed=true;mock.actorRole="finance";expect((await confirmOtp(id,code)).status).toBe(403);
    expect(mock.otpConsumed).toBe(false);expect(mock.approvalRows).toHaveLength(0);
  });
  it("counts wrong attempts, rejects locked or expired OTP",async()=>{
    const {id,code}=await issuedVoucher();
    const wrong=code==="000000"?"111111":"000000";
    expect((await confirmOtp(id,wrong)).status).toBe(400);
    expect(mock.otpAttempts).toBe(1);
    mock.otpAttempts=5;expect((await confirmOtp(id,code)).status).toBe(400);
    mock.otpAttempts=0;mock.otpExpired=true;expect((await confirmOtp(id,code)).status).toBe(400);
    expect(mock.otpConsumed).toBe(false);expect(mock.approvalRows).toHaveLength(0);
  });
  it("rolls back consumed OTP when approval insert fails and allows retry",async()=>{
    const {id,code}=await issuedVoucher();
    mock.approvalFail=true;
    expect((await confirmOtp(id,code)).status).toBe(409);
    expect(mock.queries.at(-1)).toBe("ROLLBACK");
    expect(mock.otpConsumed).toBe(false);expect(mock.approvalRows).toHaveLength(0);
    mock.approvalFail=false;
    expect((await confirmOtp(id,code)).status).toBe(201);
    expect(mock.approvalRows).toHaveLength(1);
  });

});
