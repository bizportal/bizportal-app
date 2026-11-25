/**
 * Recognize the existing bank import sources without manufacturing import IDs.
 * Google Sheet acceptance is limited to the opt-in DEV Marketplace adapter.
 * The caller holds the bank row lock; config/account locks bind its provenance
 * to the same active company-owned source throughout allocation/finalization.
 */
import { createHash } from "node:crypto";
export type MarketplaceBankQueryClient = {
  query: (text: string, values?: any[]) => Promise<{ rows: any[] }>;
};

function positiveId(value: unknown): number | null {
  if (value == null || !/^\d+$/.test(String(value))) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

function minorUnits(value: unknown): number | null {
  const raw = String(value);
  if (!/^(0|[1-9]\d{0,13})(?:\.\d{1,2})?$/.test(raw)) return null;
  const result = Math.round(Number(raw) * 100);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

export async function hasMarketplaceBankImportProvenance(
  client: MarketplaceBankQueryClient,
  bank: Record<string, unknown>,
  companyId: number,
): Promise<boolean> {
  if (bank.company_id !== companyId || positiveId(bank.id) === null) return false;
  // Preserve existing statement-import behavior. A Google Sheet row must
  // satisfy its own source proof even if a stray import ID was attached.
  if (bank.source !== "google_sheet") {
    return positiveId(bank.import_row_id) !== null || positiveId(bank.import_batch_id) !== null;
  }
  if (process.env.APP_ENV !== "development" ||
      process.env.BIZPORTAL_MARKETPLACE_AP_BANK_STATUS_ADAPTER_DEV !== "true" ||
      positiveId(bank.sheet_config_id) === null || positiveId(bank.bank_account_id) === null) {
    return false;
  }

  const result = await client.query(
    `select bm.canonical_key, bm.transaction_date::text transaction_date,
            bm.description, bm.debit_amount::text, bm.credit_amount::text,
            bm.amount::text, ba.account_type
       from public.bank_mutations bm
       join public.bank_sheet_configs cfg
         on cfg.id = bm.sheet_config_id and cfg.company_id = bm.company_id
        and cfg.is_active = true
       join public.company_bank_accounts ba
         on ba.id = cfg.bank_account_id and ba.company_id = cfg.company_id
        and ba.id::text = bm.bank_account_id::text and ba.is_active = true
      where bm.id = $1 and bm.company_id = $2
        and bm.source = 'google_sheet'
        and bm.source_classification = 'actual_bank_mutation'
        and nullif(trim(cfg.sheet_id), '') is not null
        and nullif(trim(cfg.tab_name), '') is not null
      for share of cfg, ba`,
    [bank.id, companyId],
  );
  if (result.rows.length !== 1) return false;
  const row = result.rows[0]!;
  const debit = minorUnits(row.debit_amount);
  const credit = minorUnits(row.credit_amount);
  const amount = minorUnits(row.amount);
  if (debit === null || credit === null || amount === null || amount <= 0 ||
      (debit > 0) === (credit > 0) || amount !== (credit || debit) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.transaction_date) ||
      !/^[a-f0-9]{64}$/.test(row.canonical_key)) return false;
  const expectedDirection = String(row.account_type ?? "").toLowerCase() === "cash"
    ? (debit > 0 ? "IN" : "OUT") : (debit > 0 ? "OUT" : "IN");
  if (bank.direction !== expectedDirection) return false;

  // This is the canonical identity written by bank-sheet-sync, not a sheet's
  // caller-editable mutation_key or a forged import_row_id.
  const normalized = String(row.description ?? "")
    .toUpperCase().replace(/\s+/g, " ").replace(/[^A-Z0-9 ]/g, "").trim();
  const canonical = createHash("sha256").update([
    companyId, Number(bank.bank_account_id), row.transaction_date,
    debit, credit, normalized,
  ].join("|"), "utf8").digest("hex");
  return canonical === row.canonical_key;
}
