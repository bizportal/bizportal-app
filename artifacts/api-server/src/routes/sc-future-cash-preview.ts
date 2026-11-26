import { Router, type IRouter } from "express";
import { createHash, randomUUID } from "node:crypto";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import { makeFileFilter, IMAGE_OR_PDF_ALLOWED_MIME } from "../lib/uploadMiddleware";
import { ObjectStorageService } from "../lib/objectStorage";
import { prepareFutureCashSource } from "../lib/future-cash-source-identity";
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

export default router;
