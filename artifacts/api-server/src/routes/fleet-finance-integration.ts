import { Router, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { pool } from "@workspace/db";

const router = Router();

function configuredToken(): string {
  return String(process.env.FLEET_FINANCE_SERVICE_TOKEN ?? "").trim();
}

function safeTokenEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireFleetFinanceService(req: Request, res: Response, next: NextFunction): void {
  const expected = configuredToken();
  if (!expected) {
    res.status(503).json({ error: "Fleet Finance integration belum dikonfigurasi." });
    return;
  }

  const authorization = req.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const supplied = match?.[1]?.trim() ?? "";
  if (!supplied || !safeTokenEqual(supplied, expected)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^[1-9]\d*$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

class FleetFinanceError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

type FleetCompanyScope = { companyId: number; sourceCompanyId: number };

function resolveFleetScope(req: Request, targetCompanyId: number | null): FleetCompanyScope {
  let configured: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(process.env.FLEET_FINANCE_COMPANY_MAP ?? "");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid map");
    configured = value as Record<string, unknown>;
    if (!Object.keys(configured).length || Object.entries(configured).some(([source, target]) =>
      !/^[1-9]\d*$/.test(source) || !parsePositiveInt(source) || typeof target !== "number" || !parsePositiveInt(target))) {
      throw new Error("invalid map");
    }
  } catch {
    throw new FleetFinanceError("Pemetaan perusahaan Fleet Finance belum dikonfigurasi.", 503);
  }
  const sourceCompanyId = parsePositiveInt(req.method === "GET" ? req.query.sourceCompanyId : req.body?.sourceCompanyId);
  if (!sourceCompanyId || !targetCompanyId || configured[String(sourceCompanyId)] !== targetCompanyId ||
      (req.method !== "GET" && req.body?.companyId !== undefined && parsePositiveInt(req.body.companyId) !== targetCompanyId)) {
    throw new FleetFinanceError("Perusahaan sumber/tujuan Fleet tidak diizinkan.", 403);
  }
  return { sourceCompanyId, companyId: targetCompanyId };
}

function requireFleetScope(req: Request, res: Response, targetCompanyId: number | null): FleetCompanyScope | null {
  try { return resolveFleetScope(req, targetCompanyId); }
  catch (error) {
    res.status(error instanceof FleetFinanceError ? error.status : 503).json({ error: (error as Error).message });
    return null;
  }
}

function minorUnits(value: unknown): number {
  const amount = Number(value);
  const minor = Math.round(amount * 100);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(minor) || Math.abs(amount * 100 - minor) > 0.0001) {
    throw new FleetFinanceError("Nominal Fleet tidak valid.");
  }
  return minor;
}

function requestAmount(value: unknown): number | null {
  if (typeof value !== "number") return null;
  try { minorUnits(value); return value; } catch { return null; }
}

async function requireActiveCompany(client: any, companyId: number) {
  const company = await client.query("SELECT id FROM public.companies WHERE id=$1 AND is_active=true", [companyId]);
  if (company.rowCount !== 1) throw new FleetFinanceError("Perusahaan tujuan Fleet tidak aktif atau tidak ditemukan.");
}

function paymentEvent(sourceCompanyId: number, paymentId: number): string {
  return `fleet-cash-payment:${sourceCompanyId}:${paymentId}`;
}

async function lockSourcePayment(client: any, args: FleetCompanyScope & {
  paymentId: number; amount: number; driverName: string; paymentDate?: string; referenceNo?: string | null;
  originalEntryId?: number;
}) {
  const event = paymentEvent(args.sourceCompanyId, args.paymentId);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [event]);
  const result = await client.query(
    `SELECT id,company_id,amount::text,driver_name,payment_date::text,reference_no,status,
            accounting_entry_id,recorded_by
       FROM public.fleet_cash_payments WHERE id=$1 AND company_id=$2 FOR UPDATE`,
    [args.paymentId, args.sourceCompanyId],
  );
  const row = result.rows[0];
  if (!row || minorUnits(row.amount) !== minorUnits(args.amount) || String(row.driver_name).trim() !== args.driverName ||
      (args.paymentDate !== undefined && row.payment_date !== args.paymentDate) ||
      (args.paymentDate !== undefined && String(row.reference_no ?? "").trim() !== String(args.referenceNo ?? "").trim()) ||
      !["confirmed", "posted", ...(args.originalEntryId ? ["cancelled"] : [])].includes(String(row.status))) {
    throw new FleetFinanceError("Bukti pembayaran sumber Fleet tidak valid atau berbeda.");
  }
  if (args.originalEntryId && Number(row.accounting_entry_id) !== args.originalEntryId) {
    throw new FleetFinanceError("Jurnal asal tidak cocok dengan pembayaran Fleet.");
  }
  return { row, event };
}

async function verifyDerivedLedger(client: any, entryId: number, companyId: number) {
  // The installed line trigger only warns on ledger INSERT failures. Verify its
  // complete result inside the transaction before committing or acknowledging a replay.
  const result = await client.query(
    `WITH expected AS (
       SELECT e.company_id,e.date AS ledger_date,e.source::text AS source_type,
              e.source_id,e.entry_number AS source_ref,l.account_id,l.debit,l.credit
         FROM public.accounting_entries e
         JOIN public.accounting_entry_lines l ON l.entry_id=e.id AND l.company_id=e.company_id
        WHERE e.id=$1 AND e.company_id=$2 AND e.status='posted' AND e.entry_status='POSTED'
     ), actual AS (
       SELECT l.company_id,l.ledger_date,l.source_type::text,l.source_id,l.source_ref,
              l.account_id,l.debit,l.credit
         FROM public.fleet_ledger_entries l
         JOIN public.accounting_entries e ON e.entry_number=l.source_ref
        WHERE e.id=$1 AND e.company_id=$2
     )
     SELECT (SELECT count(*)::int FROM expected) AS expected_count,
            (SELECT count(*)::int FROM actual) AS actual_count,
            NOT EXISTS(SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
            AND NOT EXISTS(SELECT * FROM actual EXCEPT ALL SELECT * FROM expected) AS matches`,
    [entryId, companyId],
  );
  const proof = result.rows[0];
  if (proof?.expected_count !== 2 || proof.actual_count !== 2 || proof.matches !== true) {
    throw new FleetFinanceError("Derived ledger Fleet tidak lengkap atau berbeda dari jurnal.");
  }
}

async function verifyPostedPayment(client: any, entry: any, args: FleetCompanyScope & {
  paymentId: number; amount: number; paymentDate: string; referenceNo?: string | null; driverName: string;
}) {
  if (Number(entry.company_id) !== args.companyId || entry.source_event_id !== paymentEvent(args.sourceCompanyId, args.paymentId) ||
      entry.status !== "posted" || entry.entry_status !== "POSTED" || entry.date !== args.paymentDate ||
      entry.ref !== (args.referenceNo?.trim() || `FCP-${args.paymentId}`) ||
      entry.description !== `Pembayaran driver fleet - ${args.driverName}` ||
      minorUnits(entry.total_debit) !== minorUnits(args.amount) || minorUnits(entry.total_credit) !== minorUnits(args.amount)) {
    throw new FleetFinanceError("Jurnal Fleet yang sudah ada berbeda dari bukti sumber.");
  }
  const journal = await client.query("SELECT id FROM public.accounting_journals WHERE id=$1 AND company_id=$2", [entry.journal_id, args.companyId]);
  if (journal.rowCount !== 1) throw new FleetFinanceError("Jurnal historis Fleet berbeda perusahaan.");
  const result = await client.query(
    `SELECT l.account_id,l.company_id,l.debit::text,l.credit::text,l.source_id,
            l.source_module,l.source_table,a.company_id AS account_company_id,
            a.is_active,a.is_postable,a.is_header,a.status AS account_status,a.type::text AS account_type
       FROM public.accounting_entry_lines l
       JOIN public.chart_of_accounts a ON a.id=l.account_id
      WHERE l.entry_id=$1 ORDER BY l.id`, [entry.id],
  );
  const lines = result.rows;
  if (lines.length !== 2 || new Set(lines.map((line: any) => Number(line.account_id))).size !== 2 || lines.some((line: any) =>
    Number(line.company_id) !== args.companyId || Number(line.account_company_id) !== args.companyId ||
    Number(line.source_id) !== args.paymentId || line.source_module !== "fleet_intelligence" || line.source_table !== "fleet_cash_payments" ||
    !((Number(line.debit) === 0 && minorUnits(line.credit) === minorUnits(args.amount)) ||
      (Number(line.credit) === 0 && minorUnits(line.debit) === minorUnits(args.amount)))) ||
    lines.filter((line: any) => Number(line.debit) > 0).length !== 1) {
    throw new FleetFinanceError("Baris jurnal Fleet tidak valid atau berbeda perusahaan.");
  }
  await verifyDerivedLedger(client, Number(entry.id), args.companyId);
  return lines;
}

function integrationErrorStatus(error: unknown): number {
  if (error instanceof FleetFinanceError) return error.status;
  const message = error instanceof Error ? error.message : "";
  return message.includes("belum dikonfigurasi") || message.includes("tidak valid") ? 409 : 503;
}

function requireIdempotencyKey(req: Request, res: Response): string | null {
  const key = String(req.get("idempotency-key") ?? "").trim();
  if (key.length < 8 || key.length > 200) {
    res.status(400).json({ error: "Idempotency-Key wajib 8-200 karakter." });
    return null;
  }
  return key;
}

async function resolvePostingSettings(client: any, companyId: number) {
  await requireActiveCompany(client, companyId);
  const result = await client.query(
    `SELECT s.fleet_cash_account_id,s.fleet_driver_receivable_account_id,
            COALESCE(
              s.cash_journal_id,
              s.bank_journal_id,
              (SELECT id
                 FROM public.accounting_journals j
                WHERE j.company_id=$1
                  AND COALESCE(j.is_active,true)=true
                ORDER BY id
                LIMIT 1)
            ) AS journal_id
       FROM public.accounting_settings s
      WHERE s.company_id=$1
      LIMIT 1`,
    [companyId],
  );

  const row = result.rows[0] as Record<string, unknown> | undefined;
  const cashId = Number(row?.fleet_cash_account_id);
  const receivableId = Number(row?.fleet_driver_receivable_account_id);
  const journalId = Number(row?.journal_id);
  if (!cashId || !receivableId || !journalId) {
    throw new Error("Fleet Cash Payment COA/journal belum dikonfigurasi.");
  }

  const accounts = await client.query(
    `SELECT id
       FROM public.chart_of_accounts
      WHERE company_id=$1
        AND id=ANY($2::int[])
        AND COALESCE(is_active,true)=true
        AND COALESCE(is_postable,true)=true
        AND COALESCE(is_header,false)=false
        AND type::text='asset'
        AND COALESCE(status,'ACTIVE')='ACTIVE'`,
    [companyId, [cashId, receivableId]],
  );
  if (accounts.rowCount !== 2) {
    throw new Error("COA Fleet Cash Payment tidak valid atau tidak postable.");
  }

  const journal = await client.query(
    `SELECT id FROM public.accounting_journals
      WHERE id=$1 AND company_id=$2 AND COALESCE(is_active,true)=true`, [journalId, companyId],
  );
  if (journal.rowCount !== 1) throw new FleetFinanceError("Jurnal Fleet tidak valid untuk perusahaan tujuan.");

  return { cashId, receivableId, journalId };
}

async function postCashPayment(client: any, args: {
  paymentId: number;
  companyId: number;
  sourceCompanyId: number;
  idempotencyKey: string;
  amount: number;
  driverName: string;
  paymentDate: string;
  referenceNo?: string | null;
  actor?: string | null;
}) {
  await requireActiveCompany(client, args.companyId);
  const source = await lockSourcePayment(client, args);
  if (args.idempotencyKey !== source.event) throw new FleetFinanceError("Idempotency-Key tidak cocok dengan sumber pembayaran Fleet.");
  const existing = await client.query(
    `SELECT id,company_id,status::text,entry_status,source_event_id,date::text,ref,description,
            total_debit::text,total_credit::text,journal_id
       FROM public.accounting_entries
      WHERE source='fleet_cash_payment' AND source_id=$1
      LIMIT 1`,
    [args.paymentId],
  );
  if (existing.rows[0]?.id) {
    await verifyPostedPayment(client, existing.rows[0], args);
    if (source.row.accounting_entry_id != null && Number(source.row.accounting_entry_id) !== Number(existing.rows[0].id)) {
      throw new FleetFinanceError("Referensi jurnal sumber Fleet berbeda.");
    }
    return { entryId: Number(existing.rows[0].id), idempotent: true };
  }
  if (source.row.status !== "confirmed" || source.row.accounting_entry_id != null) {
    throw new FleetFinanceError("Status sumber Fleet tidak cocok untuk jurnal baru.");
  }

  const settings = await resolvePostingSettings(client, args.companyId);
  const year = String(args.paymentDate || new Date().toISOString()).slice(0, 4);
  const entryNumber = `FLEET-${args.companyId}-${year}-${String(args.paymentId).padStart(8, "0")}`;
  const ref = args.referenceNo?.trim() || `FCP-${args.paymentId}`;
  const description = `Pembayaran driver fleet - ${args.driverName}`;

  const entry = await client.query(
    `INSERT INTO public.accounting_entries
      (entry_number,journal_id,date,ref,description,status,source,source_id,total_debit,total_credit,
       created_by_id,company_id,source_module,source_schema,source_table,entry_status,source_event_id)
     VALUES($1,$2,$3::date,$4,$5,'draft','fleet_cash_payment',$6,$7,$7,$8,$9,
            'fleet_intelligence','public','fleet_cash_payments','DRAFT',$10)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      entryNumber,
      settings.journalId,
      args.paymentDate,
      ref,
      description,
      args.paymentId,
      args.amount,
      source.row.recorded_by ?? args.actor ?? null,
      args.companyId,
      source.event,
    ],
  );

  let entryId = Number(entry.rows[0]?.id);
  if (!entryId) {
    throw new FleetFinanceError("Identitas jurnal Fleet sudah digunakan; periksa bukti sumber.");
  }

  await client.query(
    `INSERT INTO public.accounting_entry_lines
      (entry_id,account_id,description,debit,credit,company_id,source_module,source_table,source_id)
     VALUES
      ($1,$2,$3,$4,0,$5,'fleet_intelligence','fleet_cash_payments',$6),
      ($1,$7,$8,0,$4,$5,'fleet_intelligence','fleet_cash_payments',$6)`,
    [
      entryId,
      settings.cashId,
      `Kas masuk pembayaran driver - ${args.driverName}`,
      args.amount,
      args.companyId,
      args.paymentId,
      settings.receivableId,
      `Pelunasan piutang driver - ${args.driverName}`,
    ],
  );

  await client.query(
    `UPDATE public.accounting_entries
        SET status='posted',entry_status='POSTED',posted_at=NOW()
      WHERE id=$1 AND status='draft'`,
    [entryId],
  );

  await verifyDerivedLedger(client, entryId, args.companyId);
  return { entryId, idempotent: false };
}

async function reverseCashPayment(client: any, args: {
  paymentId: number;
  originalEntryId: number;
  companyId: number;
  sourceCompanyId: number;
  idempotencyKey: string;
  amount: number;
  driverName: string;
  actor?: string | null;
}) {
  await requireActiveCompany(client, args.companyId);
  const source = await lockSourcePayment(client, args);
  const event = `fleet-cash-payment-reversal:${args.sourceCompanyId}:${args.paymentId}:${args.originalEntryId}`;
  if (args.idempotencyKey !== event) throw new FleetFinanceError("Idempotency-Key reversal tidak cocok dengan sumber Fleet.");
  const originalResult = await client.query(
    `SELECT id,company_id,status::text,entry_status,source_event_id,date::text,ref,description,
            total_debit::text,total_credit::text,journal_id
       FROM public.accounting_entries
      WHERE id=$1 AND source='fleet_cash_payment' AND source_id=$2 FOR UPDATE`,
    [args.originalEntryId, args.paymentId],
  );
  const original = originalResult.rows[0];
  if (!original) throw new FleetFinanceError("Jurnal asal Fleet tidak ditemukan.");
  const lines = await verifyPostedPayment(client, original, {
    ...args, paymentDate: source.row.payment_date, referenceNo: source.row.reference_no,
  });
  const existing = await client.query(
    `SELECT id,company_id,status::text,entry_status,source_event_id,previous_entry_id,total_debit::text,total_credit::text
       FROM public.accounting_entries WHERE source='reversal' AND source_id=$1 LIMIT 1`,
    [args.originalEntryId],
  );
  if (existing.rows[0]?.id) {
    const reversal = existing.rows[0];
    const reversalLines = await client.query(
      `SELECT account_id,company_id,debit::text,credit::text,source_id,source_module,source_table
         FROM public.accounting_entry_lines WHERE entry_id=$1 ORDER BY id`, [reversal.id],
    );
    if (Number(reversal.company_id) !== args.companyId || reversal.source_event_id !== event ||
        Number(reversal.previous_entry_id) !== args.originalEntryId || reversal.status !== "posted" || reversal.entry_status !== "POSTED" ||
        minorUnits(reversal.total_debit) !== minorUnits(args.amount) || minorUnits(reversal.total_credit) !== minorUnits(args.amount) ||
        reversalLines.rows.length !== 2 || new Set(reversalLines.rows.map((line: any) => Number(line.account_id))).size !== 2 ||
        reversalLines.rows.some((line: any) => {
          const originalLine = lines.find((candidate: any) => Number(candidate.account_id) === Number(line.account_id));
          return !originalLine || Number(line.company_id) !== args.companyId || Number(line.source_id) !== args.paymentId ||
            line.source_module !== "fleet_intelligence" || line.source_table !== "fleet_cash_payments" ||
            Number(line.debit) !== Number(originalLine.credit) || Number(line.credit) !== Number(originalLine.debit);
        })) {
      throw new FleetFinanceError("Reversal Fleet yang sudah ada berbeda dari jurnal asal.");
    }
    await verifyDerivedLedger(client, Number(reversal.id), args.companyId);
    return { entryId: Number(reversal.id), idempotent: true };
  }
  if (source.row.status !== "posted") throw new FleetFinanceError("Pembayaran Fleet belum posted untuk reversal baru.");
  if (lines.some((line: any) => line.is_active === false || line.is_postable === false || line.is_header === true ||
    String(line.account_status ?? "ACTIVE") !== "ACTIVE" || line.account_type !== "asset")) {
    throw new FleetFinanceError("COA jurnal asal Fleet tidak valid untuk reversal.");
  }
  const journal = await client.query(
    `SELECT id FROM public.accounting_journals WHERE id=$1 AND company_id=$2 AND COALESCE(is_active,true)=true`,
    [original.journal_id, args.companyId],
  );
  if (journal.rowCount !== 1) throw new FleetFinanceError("Jurnal asal Fleet tidak valid untuk perusahaan tujuan.");
  const entryNumber = `FLEET-R-${args.companyId}-${new Date().getFullYear()}-${String(args.paymentId).padStart(8, "0")}`;
  const entry = await client.query(
    `INSERT INTO public.accounting_entries
      (entry_number,journal_id,date,ref,description,status,source,source_id,total_debit,total_credit,
       created_by_id,company_id,source_module,source_schema,source_table,previous_entry_id,entry_status,source_event_id)
     VALUES($1,$2,CURRENT_DATE,$3,$4,'draft','reversal',$5,$6,$6,$7,$8,
            'fleet_intelligence','public','fleet_cash_payments',$5,'DRAFT',$9)
     ON CONFLICT DO NOTHING RETURNING id`,
    [entryNumber, original.journal_id, `VOID-FCP-${args.paymentId}`,
      `Pembatalan pembayaran driver fleet - ${args.driverName}`, args.originalEntryId,
      args.amount, args.actor ?? null, args.companyId, event],
  );
  const entryId = Number(entry.rows[0]?.id);
  if (!entryId) throw new FleetFinanceError("Identitas reversal Fleet sudah digunakan; periksa jurnal asal.");
  await client.query(
    `INSERT INTO public.accounting_entry_lines
      (entry_id,account_id,description,debit,credit,company_id,source_module,source_table,source_id)
     SELECT $1,account_id,'Reversal ' || COALESCE(description,''),credit,debit,$2,
            'fleet_intelligence','fleet_cash_payments',$3
       FROM public.accounting_entry_lines WHERE entry_id=$4 AND company_id=$2`,
    [entryId, args.companyId, args.paymentId, args.originalEntryId],
  );
  await client.query(
    "UPDATE public.accounting_entries SET status='posted',entry_status='POSTED',posted_at=NOW() WHERE id=$1 AND status='draft'",
    [entryId],
  );
  await verifyDerivedLedger(client, entryId, args.companyId);
  return { entryId, idempotent: false };
}

router.use(requireFleetFinanceService);

router.use((req, res, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && process.env.FLEET_FINANCE_WRITE_ENABLED !== "true") {
    res.status(503).json({ error: "Pencatatan Fleet Finance belum diaktifkan.", code: "FLEET_FINANCE_WRITES_DISABLED", writeEnabled: false });
    return;
  }
  next();
});

router.get("/companies/:companyId/accounting-settings", async (req, res) => {
  const companyId = parsePositiveInt(req.params.companyId);
  if (!companyId) {
    res.status(400).json({ error: "companyId tidak valid." });
    return;
  }
  const scope = requireFleetScope(req, res, companyId);
  if (!scope) return;

  try {
    const client = await pool.connect();
    try {
      const settings = await resolvePostingSettings(client, companyId);
      res.json({
        ...scope,
        fleetCashAccountId: settings.cashId,
        fleetDriverReceivableAccountId: settings.receivableId,
        journalId: settings.journalId,
      });
    } finally {
      client.release();
    }
  } catch (error) {
    req.log?.error({ error, companyId }, "Fleet Finance settings integration failed");
    const message = error instanceof Error ? error.message : "Fleet Finance settings unavailable";
    res.status(integrationErrorStatus(error)).json({ error: message });
  }
});

router.put("/companies/:companyId/accounting-settings", async (req, res) => {
  const key = requireIdempotencyKey(req, res);
  if (!key) return;

  const companyId = parsePositiveInt(req.params.companyId);
  const cashId = parsePositiveInt(req.body?.fleetCashAccountId);
  const receivableId = parsePositiveInt(req.body?.fleetDriverReceivableAccountId);
  const journalId = parsePositiveInt(req.body?.journalId);
  if (!companyId || !cashId || !receivableId || !journalId) {
    res.status(400).json({ error: "companyId, Fleet cash COA, piutang driver COA, dan journalId wajib valid." });
    return;
  }
  const scope = requireFleetScope(req, res, companyId);
  if (!scope) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await requireActiveCompany(client, companyId);

    const accounts = await client.query(
      `SELECT id,type::text,is_active,is_postable,is_header,status
         FROM public.chart_of_accounts
        WHERE company_id=$1
          AND id=ANY($2::int[])`,
      [companyId, [cashId, receivableId]],
    );
    if (accounts.rowCount !== 2) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "COA Fleet tidak ditemukan pada company ini." });
      return;
    }
    for (const row of accounts.rows as Array<Record<string, unknown>>) {
      if (
        row.is_active === false ||
        row.is_postable === false ||
        row.is_header === true ||
        String(row.status ?? "ACTIVE") !== "ACTIVE" ||
        String(row.type ?? "") !== "asset"
      ) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "COA Fleet harus aktif, postable, dan bertipe asset." });
        return;
      }
    }

    const journal = await client.query(
      `SELECT id
         FROM public.accounting_journals
        WHERE id=$1
          AND company_id=$2
          AND COALESCE(is_active,true)=true
        LIMIT 1`,
      [journalId, companyId],
    );
    if (!journal.rows[0]) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "Jurnal Fleet tidak valid atau tidak aktif untuk company ini." });
      return;
    }

    const existing = await client.query(
      "SELECT id FROM public.accounting_settings WHERE company_id=$1 LIMIT 1",
      [companyId],
    );
    if (existing.rows[0]?.id) {
      await client.query(
        `UPDATE public.accounting_settings
            SET fleet_cash_account_id=$2,
                fleet_driver_receivable_account_id=$3,
                cash_journal_id=$4,
                updated_at=NOW()
          WHERE id=$1`,
        [existing.rows[0].id, cashId, receivableId, journalId],
      );
    } else {
      await client.query(
        `INSERT INTO public.accounting_settings(
           company_id,fleet_cash_account_id,fleet_driver_receivable_account_id,cash_journal_id,updated_at
         ) VALUES($1,$2,$3,$4,NOW())`,
        [companyId, cashId, receivableId, journalId],
      );
    }

    await client.query("COMMIT");
    res.json({
      ok: true,
      ...scope,
      fleetCashAccountId: cashId,
      fleetDriverReceivableAccountId: receivableId,
      journalId,
      idempotencyKey: key,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    req.log?.error({ error, companyId }, "Fleet Finance settings update failed");
    res.status(integrationErrorStatus(error)).json({ error: error instanceof Error ? error.message : "Fleet Finance settings update failed" });
  } finally {
    client.release();
  }
});

router.post("/cash-payments", async (req, res) => {
  const key = requireIdempotencyKey(req, res);
  if (!key) return;

  const companyId = parsePositiveInt(req.body?.companyId);
  const paymentId = parsePositiveInt(req.body?.paymentId);
  const amount = requestAmount(req.body?.amount);
  const driverName = typeof req.body?.driverName === "string" ? req.body.driverName.trim() : "";
  const paymentDate = typeof req.body?.paymentDate === "string" ? req.body.paymentDate.trim() : "";
  if (!companyId || !paymentId || amount === null || !driverName || !/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) {
    res.status(400).json({ error: "Payload Fleet cash payment tidak valid." });
    return;
  }
  const scope = requireFleetScope(req, res, companyId);
  if (!scope) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await postCashPayment(client, {
      ...scope,
      idempotencyKey: key,
      paymentId,
      amount,
      driverName,
      paymentDate,
      referenceNo: typeof req.body?.referenceNo === "string" ? req.body.referenceNo : null,
      actor: typeof req.body?.actor === "string" ? req.body.actor : "fleet-service",
    });
    await client.query("COMMIT");
    res.status(result.idempotent ? 200 : 201).json({ ...result, ...scope, idempotencyKey: key });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    req.log?.error({ error, companyId, paymentId }, "Fleet cash payment finance integration failed");
    const message = error instanceof Error ? error.message : "Fleet cash payment posting failed";
    res.status(integrationErrorStatus(error)).json({ error: message });
  } finally {
    client.release();
  }
});

router.post("/cash-payments/reverse", async (req, res) => {
  const key = requireIdempotencyKey(req, res);
  if (!key) return;

  const companyId = parsePositiveInt(req.body?.companyId);
  const paymentId = parsePositiveInt(req.body?.paymentId);
  const originalEntryId = parsePositiveInt(req.body?.originalEntryId);
  const amount = requestAmount(req.body?.amount);
  const driverName = typeof req.body?.driverName === "string" ? req.body.driverName.trim() : "";
  if (!companyId || !paymentId || !originalEntryId || amount === null || !driverName) {
    res.status(400).json({ error: "Payload Fleet reversal tidak valid." });
    return;
  }
  const scope = requireFleetScope(req, res, companyId);
  if (!scope) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await reverseCashPayment(client, {
      ...scope,
      idempotencyKey: key,
      paymentId,
      originalEntryId,
      amount,
      driverName,
      actor: typeof req.body?.actor === "string" ? req.body.actor : "fleet-service",
    });
    await client.query("COMMIT");
    res.status(result.idempotent ? 200 : 201).json({ ...result, ...scope, idempotencyKey: key });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    req.log?.error({ error, companyId, paymentId, originalEntryId }, "Fleet cash payment reversal integration failed");
    const message = error instanceof Error ? error.message : "Fleet reversal posting failed";
    res.status(integrationErrorStatus(error)).json({ error: message });
  } finally {
    client.release();
  }
});

export default router;
