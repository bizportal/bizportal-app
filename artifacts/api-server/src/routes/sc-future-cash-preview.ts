import { Router, type IRouter } from "express";
import { createHash, randomUUID, randomInt } from "node:crypto";
import { hash } from "bcryptjs";
import { sendFutureCashVoucherOtpEmail } from "../lib/smtp";
import { futureCashOtpPurpose } from "../lib/future-cash-purpose-otp-reader";
import { readVerifiedFutureCashDocument } from "../lib/future-cash-document-registry-read";
import { verifyPrivateFutureCashReceipt } from "../lib/future-cash-private-receipt";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import { makeFileFilter, IMAGE_OR_PDF_ALLOWED_MIME } from "../lib/uploadMiddleware";
import { ObjectStorageService } from "../lib/objectStorage";
import { prepareFutureCashSource } from "../lib/future-cash-source-identity";
import { auditPendingFutureCashBytes } from "../lib/future-cash-pending-integrity";
import type { PendingPrivateCashEvidence } from "../lib/future-cash-private-upload";
import { pool } from "@workspace/db";
import {
  getProductionSession,
  getProductionUser,
  isDevelopmentEnvironment,
  isSignedOtpDevEnabled,
} from "./dev-auth";
import { prepareCashJournal } from "../lib/cash-ledger-posting";

/**
 * CST DEV Owner/Super Admin cash-entry *preview only*.
 * This has no writer, document issuer, approval side effect, or storage.
 * In particular this DOES NOT import historical Sheet Config #5.
 */
const router: IRouter = Router();
const PATH = "/cash-bank/sc-new";
const CASH_ACCOUNT_ID = 18;
const CASH_COA_ID = 75839;
const CASH_COA_CODE = "1-1011-CST";
const OWNER_ORIGIN = "https://dev-bizportal.cstlogistic.co.id";
const pendingEvidenceStorage = new ObjectStorageService();
const cashDocumentUploadLimit = 8 * 1024 * 1024;
const cashDocumentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: cashDocumentUploadLimit, files: 1, fields: 5, parts: 7 },
  fileFilter: makeFileFilter(IMAGE_OR_PDF_ALLOWED_MIME),
}).single("file");
const cashDocumentRateLimit = rateLimit({
  windowMs: 10 * 60_000, limit: 6, standardHeaders: "draft-7",
  legacyHeaders: false, validate: false,
});

type CashAccount = {
  id: number; name: string; account_type: string; is_active: boolean;
  opening_balance: string; created_at: string; notes: string | null;
  cash_coa_id: number; cash_coa_code: string;
  coa_active: boolean; is_postable: boolean; is_header: boolean;
};
type ContraCoa = {
  id: number; company_id: number; code: string; name: string;
  is_active: boolean; is_postable: boolean; is_header: boolean;
};
const blockCodes = [
  "PRIMARY_CASH_DOCUMENT_NOT_VERIFIED",
  "FRESH_OWNER_APPROVAL_NOT_VERIFIED",
  "BUSINESS_POSTING_WRITER_NOT_ENABLED",
] as const;
const positiveInt = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};
const validAccount = (a: CashAccount | undefined): a is CashAccount =>
  Boolean(a && Number(a.id) === CASH_ACCOUNT_ID
    && a.account_type === "cash" && a.is_active === true
    && Number(a.cash_coa_id) === CASH_COA_ID
    && a.cash_coa_code === CASH_COA_CODE
    && a.coa_active === true && a.is_postable === true && a.is_header === false
    && a.notes?.includes("tidak digunakan untuk migrasi transaksi historis"));
const validContra = (c: ContraCoa | undefined): c is ContraCoa =>
  Boolean(c && c.company_id === 1 && c.id !== CASH_COA_ID
    && c.is_active === true && c.is_postable === true && c.is_header === false);

async function cashAccount(): Promise<CashAccount | undefined> {
  const result = await pool.query<CashAccount>(
    `select a.id,a.name,a.account_type,a.is_active,
            a.opening_balance::text,a.created_at::text,a.notes,
            coa.id as cash_coa_id,coa.code as cash_coa_code,
            coa.is_active as coa_active,coa.is_postable,coa.is_header
       from public.company_bank_accounts a
       join public.chart_of_accounts coa
         on coa.id=a.coa_id and coa.company_id=a.company_id
      where a.id=$1 and a.company_id=$2 limit 1`,
    [CASH_ACCOUNT_ID, 1],
  );
  return result.rows[0];
}
const decimal = (n: bigint): string =>
  (n / 100n).toString() + "." + (n % 100n).toString().padStart(2, "0");

router.use(PATH, async (req, res, next): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  if (process.env.APP_ENV !== "development" || !isDevelopmentEnvironment()) {
    res.status(404).json({ code: "SC_CASH_DEV_ONLY" });
    return;
  }
  if (!isSignedOtpDevEnabled()) {
    res.status(503).json({ code: "SC_CASH_SIGNED_OTP_UNAVAILABLE" });
    return;
  }
  const session = getProductionSession(req);
  if (!session) {
    res.status(401).json({ code: "SC_CASH_SIGNED_OWNER_SESSION_REQUIRED" });
    return;
  }
  try {
    const actor = await getProductionUser(session);
    if (!actor || !["owner", "super_admin"].includes(actor.role.toLowerCase())
        || (actor.companyId !== null && actor.companyId !== 1)) {
      res.status(403).json({ code: "SC_CASH_OWNER_COMPANY_SCOPE_DENIED" });
      return;
    }
    res.locals.scCashOwnerEmail = typeof actor.email === "string" ? actor.email : null;
    res.locals.scCashOwnerRole = actor.role.toLowerCase();
    next();
  } catch {
    res.status(503).json({ code: "SC_CASH_OWNER_REVALIDATION_UNAVAILABLE" });
  }
});

router.get(PATH + "/readiness", async (req, res): Promise<void> => {
  if (String(req.query.company_id ?? "") !== "1") {
    res.status(403).json({ code: "SC_CASH_COMPANY1_REQUIRED" });
    return;
  }
  try {
    const account = await cashAccount();
    if (!validAccount(account)) {
      res.status(409).json({ code: "SC_CASH_ACCOUNT18_BASELINE_INVALID" });
      return;
    }
    // Candidates only — a COA is NOT an authenticated transaction allocation.
    const result = await pool.query<ContraCoa>(
      `select id,company_id,code,name,is_active,is_postable,is_header
         from public.chart_of_accounts
        where company_id=$1 and is_active=true and is_postable=true
          and is_header=false and id<>$2 order by code,id limit 300`,
      [1, CASH_COA_ID],
    );
    res.json({
      mode: "READ_ONLY_FUTURE_CASH_DEV",
      account: { id: account.id, name: account.name, coaId: account.cash_coa_id,
        coaCode: account.cash_coa_code, openingBalance: account.opening_balance,
        createdAt: account.created_at },
      contraCandidates: result.rows.map(row =>
        ({ id: row.id, code: row.code, name: row.name })),
      signedOwnerSession: "VERIFIED",
      documentVerification: "NOT_CONNECTED",
      freshPostingApproval: "NOT_VERIFIED",
      postingAllowed: false,
      reasons: blockCodes,
      historicalSheetConfig5: "NOT_USED_NONMIGRATION",
    });
  } catch {
    res.status(503).json({ code: "SC_CASH_READINESS_UNAVAILABLE" });
  }
});

/**
 * Server-owned PENDING receipt discovery for a signed Owner/Super Admin.
 * No browser-supplied UUID is trusted; list is limited and read-only.
 * Exposes no private storage path, hash, uploader, or approval capability.
 */
router.get(PATH + "/documents/pending", cashDocumentRateLimit, async (_req, res): Promise<void> => {
  try {
    const result = await pool.query<{
      transaction_id: string; direction: "IN" | "OUT";
      transaction_date: string; amount_cents: string;
    }>([
      "select d.transaction_id::text, d.direction,",
      " d.transaction_date::text, d.amount_cents::text",
      " from public.sc_future_cash_documents d",
      " where d.company_id=1 and d.account_id=18 and d.cash_coa_id=75839",
      " and not exists (select 1 from public.sc_future_cash_document_events e",
      " where e.transaction_id=d.transaction_id)",
      " order by d.uploaded_at desc, d.transaction_id desc limit 20",
    ].join("\n"));
    const documents = result.rows.map(row => ({
      transactionId: row.transaction_id,
      status: "PENDING_VERIFICATION" as const,
      date: row.transaction_date,
      direction: row.direction,
      amount: decimal(BigInt(row.amount_cents)),
    }));
    res.json({
      mode: "ACCOUNT18_PENDING_SERVER_RECORDS",
      accountId: 18, companyId: 1,
      documents, postingAllowed: false,
      historicalSheetConfig5: "NOT_USED_NONMIGRATION",
    });
  } catch {
    res.status(503).json({
      code: "SC_CASH_PENDING_LIST_UNAVAILABLE", postingAllowed: false,
    });
  }
});

router.post(PATH + "/preview", async (req, res): Promise<void> => {
  if (req.get("origin") !== OWNER_ORIGIN) {
    res.status(403).json({ code: "SC_CASH_SAME_ORIGIN_REQUIRED" });
    return;
  }
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown> : {};
  if (body.companyId !== 1 || body.accountId !== CASH_ACCOUNT_ID) {
    res.status(403).json({ code: "SC_CASH_COMPANY1_ACCOUNT18_ONLY" });
    return;
  }
  // This endpoint is a mathematical preview, never a source/approval intake.
  // Fail closed on ALL unrecognized fields, including nested or renamed
  // browser-supplied document and posting claims.
  const allowed = new Set([
    "companyId", "accountId", "date", "direction", "amount", "counterCoaId",
  ]);
  if (Object.keys(body).some(key => !allowed.has(key))) {
    res.status(400).json({ code: "SC_CASH_SERVER_VERIFIED_PROOFS_ONLY" });
    return;
  }
  const contraId = positiveInt(body.counterCoaId);
  if (!contraId || contraId === CASH_COA_ID ||
      typeof body.date !== "string" ||
      typeof body.amount !== "string" ||
      !["IN", "OUT"].includes(String(body.direction))) {
    res.status(400).json({ code: "SC_CASH_INVALID_DRAFT" });
    return;
  }
  try {
    const account = await cashAccount();
    if (!validAccount(account)) {
      res.status(409).json({ code: "SC_CASH_ACCOUNT18_BASELINE_INVALID" });
      return;
    }
    const contra = await pool.query<ContraCoa>(
      `select id,company_id,code,name,is_active,is_postable,is_header
         from public.chart_of_accounts where id=$1 and company_id=$2 limit 1`,
      [contraId, 1],
    );
    if (!validContra(contra.rows[0])) {
      res.status(422).json({ code: "SC_CASH_COUNTER_COA_NOT_ELIGIBLE" });
      return;
    }
    let draft;
    try {
      // Reuses exact-cent, date and double-entry validation; synthetic scope
      // never leaves memory, and no source ID/fingerprint is issued.
      draft = prepareCashJournal(
        { companyId: 1, accountId: CASH_ACCOUNT_ID, accountType: "cash",
          cashCoaId: CASH_COA_ID, counterpartyCoaId: contraId, configId: 9001 },
        { rowNumber: 1, date: body.date, direction: body.direction as "IN"|"OUT",
          amount: body.amount, sourceFingerprint: "0".repeat(64) },
      );
    } catch {
      res.status(400).json({ code: "SC_CASH_DATE_OR_AMOUNT_INVALID" });
      return;
    }
    // Account18 is a NEW cash account; its old Sheet opening is unrelated.
    if (body.date < account.created_at.slice(0, 10)) {
      res.status(400).json({ code: "SC_CASH_BEFORE_ACCOUNT_CREATED" });
      return;
    }
    res.json({
      mode: "READ_ONLY_IN_MEMORY_DRAFT",
      accountId: CASH_ACCOUNT_ID,
      direction: body.direction,
      date: body.date,
      amount: decimal(draft.amountCents),
      proposedLines: draft.lines.map((line, index) => ({
        coaId: line.accountId,
        coaCode: index === 0 ? CASH_COA_CODE : contra.rows[0]!.code,
        name: index === 0 ? account.name : contra.rows[0]!.name,
        debit: decimal(line.debitCents),
        credit: decimal(line.creditCents),
      })),
      counterCoaClassification: "UNVERIFIED_PRIMARY_DOCUMENT",
      historicalSheetConfig5: "NOT_USED_NONMIGRATION",
      postingAllowed: false,
      reasons: blockCodes,
    });
  } catch {
    res.status(503).json({ code: "SC_CASH_DRAFT_PREVIEW_UNAVAILABLE" });
  }
});


/**
 * CST DEV only: signed Owner/Super Admin stores a NEW private proof as PENDING.
 * This is NOT an approval, trusted VERIFIED receipt, voucher posting, or
 * historical cash-sheet import. The existing signed-owner guard runs first.
 */
router.post(PATH + "/documents/pending", cashDocumentRateLimit, (req, res, next) => {
  if (req.get("origin") !== OWNER_ORIGIN) {
    res.status(403).json({ code: "SC_CASH_SAME_ORIGIN_REQUIRED" });
    return;
  }
  cashDocumentUpload(req, res, (err: unknown) => {
    if (err) {
      res.status(err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE"
        ? 413 : 400).json({ code: "SC_CASH_DOCUMENT_UPLOAD_INVALID" });
      return;
    }
    next();
  });
}, async (req, res): Promise<void> => {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown> : {};
  const allowed = new Set(["companyId", "accountId", "date", "direction", "amount"]);
  if (Object.keys(body).some(key => !allowed.has(key)) ||
      body.companyId !== "1" || body.accountId !== "18" ||
      typeof body.date !== "string" || typeof body.amount !== "string" ||
      (body.direction !== "IN" && body.direction !== "OUT") ||
      !req.file?.buffer || !res.locals.scCashOwnerEmail) {
    res.status(400).json({ code: "SC_CASH_INVALID_PENDING_DOCUMENT" });
    return;
  }
  const transactionId = randomUUID();
  const digest = createHash("sha256").update(req.file.buffer).digest("hex");
  const source = {
    companyId: 1, accountId: CASH_ACCOUNT_ID, cashCoaId: CASH_COA_ID,
    transactionId, sourceDocumentSha256: digest,
    direction: body.direction, date: body.date, amount: body.amount,
  } as const;
  let fingerprint: string, amountCents: bigint;
  try {
    fingerprint = prepareFutureCashSource(source).sourceFingerprint;
    const [whole, frac = ""] = source.amount.split(".");
    amountCents = BigInt(whole!) * 100n + BigInt(frac.padEnd(2, "0") || "0");
  } catch {
    res.status(400).json({ code: "SC_CASH_PENDING_SOURCE_INVALID" });
    return;
  }
  let pending: PendingPrivateCashEvidence | null = null;
  let inserted = false;
  try {
    const account = await cashAccount();
    if (!validAccount(account) || source.date < account.created_at.slice(0, 10)) {
      res.status(409).json({ code: "SC_CASH_ACCOUNT18_BASELINE_INVALID" });
      return;
    }
    pending = await pendingEvidenceStorage.uploadFutureCashPrivateEvidence(
      { companyId: 1, accountId: CASH_ACCOUNT_ID, transactionId },
      req.file.buffer,
    );
    if (pending.sha256 !== digest || pending.transactionId !== transactionId ||
        pending.byteLength !== req.file.buffer.length) {
      throw Error("CASH_EVIDENCE_UPLOAD_DIGEST_MISMATCH");
    }
    // Read-after-write confirms the stored bytes, not client MIME or file URL.
    const actualSize = await pendingEvidenceStorage.getObjectEntitySize(pending.objectPath);
    const handle = await pendingEvidenceStorage.getObjectEntityFile(pending.objectPath);
    if (actualSize !== pending.byteLength || handle.bucket !== "private-uploads" ||
        handle.path !== pending.objectPath.slice("/objects/".length)) {
      throw Error("CASH_EVIDENCE_PRIVATE_READBACK_INVALID");
    }
    const readback = Buffer.from(await (await pendingEvidenceStorage
      .downloadObject(handle, 0)).arrayBuffer());
    if (readback.length !== pending.byteLength ||
        createHash("sha256").update(readback).digest("hex") !== digest) {
      throw Error("CASH_EVIDENCE_PRIVATE_READBACK_MISMATCH");
    }
    await pool.query([
      "insert into public.sc_future_cash_documents",
      " (transaction_id,company_id,account_id,cash_coa_id,object_path,",
      "  document_sha256,source_fingerprint,direction,transaction_date,",
      "  amount_cents,byte_length,uploaded_by)",
      " values ($1,1,18,75839,$2,$3,$4,$5,$6,$7,$8,$9)",
    ].join("\n"), [
      transactionId, pending.objectPath, digest, fingerprint, source.direction,
      source.date, amountCents.toString(), pending.byteLength,
      res.locals.scCashOwnerEmail,
    ]);
    inserted = true;
    res.status(201).json({
      mode: "PENDING_PRIVATE_CASH_EVIDENCE_DEV",
      transactionId,
      status: "PENDING_VERIFICATION",
      postingAllowed: false,
      historicalSheetConfig5: "NOT_USED_NONMIGRATION",
    });
  } catch {
    // Cleanup only the fresh server-issued path on failure before DB insert.
    if (pending && !inserted) {
      await pendingEvidenceStorage.deletePrivateEntity(pending.objectPath)
        .catch(() => undefined);
    }
    res.status(503).json({ code: "SC_CASH_DOCUMENT_INTAKE_UNAVAILABLE" });
  }
});

/**
 * Signed Owner/Super Admin, CST-DEV-only, read-only integrity audit.
 * It NEVER marks a document VERIFIED or creates a posting approval.
 */
router.get(PATH + "/documents/:transactionId/integrity", cashDocumentRateLimit,
  async (req, res): Promise<void> => {
    const id = String(req.params.transactionId ?? "");
    const result = await auditPendingFutureCashBytes(id, pool, pendingEvidenceStorage);
    if (result !== "MATCH") {
      res.status(404).json({ code: "SC_CASH_PENDING_INTEGRITY_UNAVAILABLE",
        postingAllowed: false });
      return;
    }
    res.json({ transactionId: id, status: "PENDING_VERIFICATION",
      storageIntegrity: "MATCH", documentApproval: "NOT_VERIFIED",
      postingAllowed: false, historicalSheetConfig5: "NOT_USED_NONMIGRATION" });
  });

/** Explicit Owner review of a server-owned pending document; no financial write. */
router.post(PATH + "/documents/verify", cashDocumentRateLimit, async (req, res): Promise<void> => {
  if (req.get("origin") !== OWNER_ORIGIN) {
    res.status(403).json({ code: "SC_CASH_SAME_ORIGIN_REQUIRED" });
    return;
  }
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown> : {};
  const allowed = new Set(["companyId", "accountId", "transactionId", "confirmed"]);
  const actorEmail = res.locals.scCashOwnerEmail;
  const actorRole = res.locals.scCashOwnerRole;
  if (Object.keys(body).some(key => !allowed.has(key)) ||
      body.companyId !== 1 || body.accountId !== 18 || body.confirmed !== true ||
      typeof body.transactionId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.transactionId) ||
      typeof actorEmail !== "string" || !actorEmail.trim() ||
      !["owner", "super_admin"].includes(actorRole)) {
    res.status(400).json({ code: "SC_CASH_INVALID_DOCUMENT_REVIEW" });
    return;
  }
  try {
    const account = await cashAccount();
    if (!validAccount(account)) {
      res.status(409).json({ code: "SC_CASH_ACCOUNT18_BASELINE_INVALID" });
      return;
    }
    const result = await pool.query<{
      transaction_id: string; object_bucket: string; object_path: string;
      document_sha256: string; source_fingerprint: string; direction: "IN" | "OUT";
      transaction_date: string; amount_cents: string; byte_length: number;
      event_type: string | null;
    }>([
      "select d.transaction_id::text, d.object_bucket, d.object_path,",
      " d.document_sha256, d.source_fingerprint, d.direction,",
      " d.transaction_date::text, d.amount_cents::text, d.byte_length, ev.event_type",
      " from public.sc_future_cash_documents d",
      " left join lateral (select event_type from public.sc_future_cash_document_events",
      " where transaction_id=d.transaction_id order by event_id desc limit 1) ev on true",
      " where d.transaction_id=$1::uuid and d.company_id=1 and d.account_id=18",
      " and d.cash_coa_id=75839 limit 1",
    ].join("\n"), [body.transactionId]);
    const doc = result.rows[0];
    if (!doc) {
      res.status(404).json({ code: "SC_CASH_DOCUMENT_NOT_FOUND" });
      return;
    }
    if (doc.event_type !== null) {
      res.status(409).json({ code: "SC_CASH_DOCUMENT_NOT_PENDING" });
      return;
    }
    const source = {
      companyId: 1, accountId: 18, cashCoaId: 75839,
      transactionId: doc.transaction_id, sourceDocumentSha256: doc.document_sha256,
      direction: doc.direction, date: doc.transaction_date,
      amount: decimal(BigInt(doc.amount_cents)),
    };
    if (doc.transaction_id !== body.transactionId ||
        prepareFutureCashSource(source).sourceFingerprint !== doc.source_fingerprint ||
        source.date < account.created_at.slice(0, 10) ||
        doc.object_bucket !== "private-uploads" ||
        !/^\/objects\/uploads\/[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(pdf|png|jpe?g|webp)$/.test(doc.object_path) ||
        !Number.isSafeInteger(doc.byte_length) || doc.byte_length < 1 ||
        doc.byte_length > cashDocumentUploadLimit) {
      res.status(409).json({ code: "SC_CASH_DOCUMENT_BINDING_INVALID" });
      return;
    }
    const size = await pendingEvidenceStorage.getObjectEntitySize(doc.object_path);
    const file = await pendingEvidenceStorage.getObjectEntityFile(doc.object_path);
    if (size !== doc.byte_length || file.bucket !== doc.object_bucket ||
        file.path !== doc.object_path.slice("/objects/".length)) {
      res.status(409).json({ code: "SC_CASH_DOCUMENT_READBACK_INVALID" });
      return;
    }
    const bytes = Buffer.from(await (await pendingEvidenceStorage.downloadObject(file, 0)).arrayBuffer());
    const magic = doc.object_path.endsWith(".pdf") ? bytes.subarray(0, 5).toString("ascii") === "%PDF-"
      : doc.object_path.endsWith(".png") ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : doc.object_path.endsWith(".webp") ? bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP"
      : bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (bytes.length !== size || !magic ||
        createHash("sha256").update(bytes).digest("hex") !== doc.document_sha256) {
      res.status(409).json({ code: "SC_CASH_DOCUMENT_READBACK_INVALID" });
      return;
    }
    const event = await pool.query([
      "insert into public.sc_future_cash_document_events",
      " (transaction_id,event_type,document_sha256,source_fingerprint,actor_email,actor_role)",
      " select d.transaction_id,'VERIFIED',d.document_sha256,d.source_fingerprint,$4,$5",
      " from public.sc_future_cash_documents d",
      " where d.transaction_id=$1::uuid and d.company_id=1 and d.account_id=18",
      " and d.cash_coa_id=75839 and d.document_sha256=$2 and d.source_fingerprint=$3",
      " and not exists (select 1 from public.sc_future_cash_document_events e where e.transaction_id=d.transaction_id)",
      " returning event_id",
    ].join("\n"), [body.transactionId, doc.document_sha256, doc.source_fingerprint, actorEmail, actorRole]);
    if (event.rowCount !== 1) {
      res.status(409).json({ code: "SC_CASH_DOCUMENT_NOT_PENDING" });
      return;
    }
    res.status(201).json({ transactionId: body.transactionId, status: "VERIFIED", postingAllowed: false });
  } catch {
    res.status(503).json({ code: "SC_CASH_DOCUMENT_VERIFICATION_UNAVAILABLE" });
  }
});

/** DEV only: issue one purpose-bound OTP, never consume it or post a journal. */
router.post(PATH + "/voucher/otp/send", async (req, res): Promise<void> => {
  if (req.get("origin") !== OWNER_ORIGIN) {
    res.status(403).json({ code: "SC_CASH_SAME_ORIGIN_REQUIRED" });
    return;
  }
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown> : {};
  const allowed = new Set(["companyId", "accountId", "transactionId", "counterCoaId"]);
  const email = typeof res.locals.scCashOwnerEmail === "string"
    ? res.locals.scCashOwnerEmail.trim().toLowerCase() : "";
  const id = body.transactionId;
  const contraId = body.counterCoaId;
  if (Object.keys(body).some(k => !allowed.has(k)) || body.companyId !== 1 ||
      body.accountId !== 18 || typeof id !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id) ||
      typeof contraId !== "number" || !Number.isSafeInteger(contraId) ||
      contraId <= 0 || contraId > 2147483647 || contraId === CASH_COA_ID ||
      email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ code: "SC_CASH_INVALID_VOUCHER_OTP_REQUEST" });
    return;
  }
  try {
    const account = await cashAccount();
    if (!validAccount(account)) {
      res.status(409).json({ code: "SC_CASH_ACCOUNT18_BASELINE_INVALID" });
      return;
    }
    const documents = await pool.query<{
      transaction_id: string; document_sha256: string; source_fingerprint: string;
      direction: "IN" | "OUT"; transaction_date: string; amount_cents: string;
    }>(
      "select transaction_id::text, document_sha256, source_fingerprint, direction, transaction_date::text, amount_cents::text from public.sc_future_cash_documents where transaction_id=$1::uuid and company_id=1 and account_id=18 and cash_coa_id=75839",
      [id],
    );
    const d = documents.rows[0];
    if (documents.rows.length !== 1 || !d || d.transaction_id !== id) {
      res.status(404).json({ code: "SC_CASH_DOCUMENT_NOT_FOUND" });
      return;
    }
    const source = {
      companyId: 1, accountId: 18, cashCoaId: 75839, transactionId: id,
      sourceDocumentSha256: d.document_sha256, direction: d.direction,
      date: d.transaction_date, amount: decimal(BigInt(d.amount_cents)),
    };
    const { sourceFingerprint } = prepareFutureCashSource(source);
    const purpose = futureCashOtpPurpose(id, sourceFingerprint, contraId);
    if (sourceFingerprint !== d.source_fingerprint || source.date < account.created_at.slice(0, 10)) {
      res.status(409).json({ code: "SC_CASH_DOCUMENT_BINDING_INVALID" });
      return;
    }
    const receipt = await readVerifiedFutureCashDocument(source, pool);
    if (!await verifyPrivateFutureCashReceipt(source, receipt, pendingEvidenceStorage)) {
      res.status(409).json({ code: "SC_CASH_VERIFIED_DOCUMENT_REQUIRED" });
      return;
    }
    const code = String(randomInt(100000, 1000000));
    const codeHash = await hash(code, 10);
    const client = await pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      // Serialize voucher requests by recipient, then source. Do not lock login OTPs.
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", ["sc-cash-otp-email:"+email]);
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", ["sc-cash-otp-source:"+id]);
      const locked = await client.query(
        "select transaction_id from public.sc_future_cash_documents where transaction_id=$1::uuid and company_id=1 and account_id=18 and source_fingerprint=$2 for update",
        [id, sourceFingerprint],
      );
      if (locked.rowCount !== 1 || !await readVerifiedFutureCashDocument(source, client))
        throw Error("SC_CASH_VERIFIED_DOCUMENT_REQUIRED");
      const contra = await client.query<ContraCoa>(
        "select id,company_id,code,name,is_active,is_postable,is_header from public.chart_of_accounts where id=$1 and company_id=1 limit 1",
        [contraId],
      );
      if (!validContra(contra.rows[0])) throw Error("SC_CASH_COUNTER_COA_NOT_ELIGIBLE");
      const approved = await client.query(
        "select id from public.approval_requests where company_id=1 and module='cash_bank' and doc_type='sc_future_cash_voucher' and metadata->>'transactionId'=$1 and lower(status)='approved' limit 1",
        [id],
      );
      if (approved.rowCount) throw Error("SC_CASH_VOUCHER_ALREADY_APPROVED");
      const recent = await client.query<{ count: string }>(
        "select count(*)::text as count from public.bizportal_email_otp_codes where purpose like 'sc-cash-voucher:%' and created_at >= now() - interval '10 minutes' and (email=$1 or purpose like $2)",
        [email, "sc-cash-voucher:"+id+":%"],
      );
      if (Number(recent.rows[0]?.count ?? "3") >= 3) {
        await client.query("ROLLBACK");
        res.setHeader("Retry-After", "600");
        res.status(429).json({ code: "SC_CASH_VOUCHER_OTP_RATE_LIMIT" });
        return;
      }
      // Invalidation must NOT populate verified_at. Retain rows for rate counting.
      await client.query(
        "update public.bizportal_email_otp_codes set attempts=5, code_hash=null where purpose like $1 and verified_at is null",
        ["sc-cash-voucher:"+id+":%"],
      );
      const inserted = await client.query<{ id: string }>(
        "insert into public.bizportal_email_otp_codes (email,request_ip,purpose,code_hash,expires_at) values ($1,$2,$3,$4,clock_timestamp()+interval '5 minutes') returning id::text",
        [email, req.ip || "unknown", purpose, codeHash],
      );
      if (inserted.rows.length !== 1) throw Error("SC_CASH_OTP_INSERT_FAILED");
      await client.query("COMMIT");
      committed = true;
      try {
        await sendFutureCashVoucherOtpEmail(email, code, id);
      } catch {
        // Disable this specific unsent code, never mark it verified.
        await pool.query(
          "update public.bizportal_email_otp_codes set attempts=5,code_hash=null where id=$1 and verified_at is null and purpose=$2",
          [inserted.rows[0]!.id, purpose],
        ).catch(() => undefined);
        res.status(503).json({ code: "SC_CASH_VOUCHER_OTP_DELIVERY_FAILED" });
        return;
      }
      res.status(202).json({ transactionId: id, counterCoaId: contraId,
        status: "OTP_SENT", expiresInSeconds: 300, postingAllowed: false });
    } catch {
      if (!committed) await client.query("ROLLBACK").catch(() => undefined);
      res.status(409).json({ code: "SC_CASH_VOUCHER_OTP_NOT_ISSUED" });
    } finally { client.release(); }
  } catch {
    res.status(503).json({ code: "SC_CASH_VOUCHER_OTP_UNAVAILABLE" });
  }
});

export default router;
