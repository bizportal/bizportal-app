/**
 * Candidate atomic boundary for the existing Bank Disbursement sole executor.
 *
 * Intentionally NOT registered as a runtime route and never imports a bank
 * posting function. The legacy "direct" path already uses a transaction;
 * this coordinates the missing single-invoice "vendor_invoice" boundary.
 * The real writer must supply company-authorized, PostgreSQL row-locked
 * adapters and journal functions. This helper alone proves no DB custody.
 */
export type InvoiceSettlementInput = Readonly<{
  companyId: number;
  invoiceId: number;
  idempotencyKey: string;
  grossMinor: number;
  withholdingMinor: number;
}>;

export type LockedInvoice = Readonly<{
  companyId: number;
  invoiceId: number;
  outstandingMinor: number;
  status: "posted" | "paid";
}>;

export type CommittedSettlement = Readonly<{
  companyId: number;
  invoiceId: number;
  idempotencyKey: string;
  grossMinor: number;
  withholdingMinor: number;
  journalId: number;
  disbursementId: number;
}>;

export type SettlementResult =
  | { outcome: "created" | "replayed"; settlement: CommittedSettlement }
  | { outcome: "rejected"; reason: "invalid" | "unavailable" | "overpayment" | "idempotency_conflict" };

export interface AtomicSettlementAdapter<Tx> {
  /** Opens a real Postgres transaction; rejection must roll back every write. */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Serialize attempts with the same (company,idempotency key) before invoice locks.
   * The PG adapter must acquire a transaction-scoped advisory lock.
   * A durable UNIQUE(company_id,key) constraint is still mandatory.
   */
  lockRequestKey(tx: Tx, companyId: number, key: string): Promise<void>;
  /** Must use SELECT FOR UPDATE for the exact (company,invoice) identity. */
  lockInvoice(tx: Tx, companyId: number, invoiceId: number): Promise<LockedInvoice | null>;
  /** Lookup under unique(company_id,idempotency_key), within the same transaction. */
  findByKey(tx: Tx, companyId: number, key: string): Promise<CommittedSettlement | null>;
  /** Existing posting service, passed the *same* transaction context. */
  postJournal(tx: Tx, input: InvoiceSettlementInput): Promise<number>;
  /** Existing disbursement service, passed the same transaction context. */
  createDisbursement(tx: Tx, input: InvoiceSettlementInput, journalId: number): Promise<number>;
  /** Performs a company-scoped conditional/CAS balance update, returning success. */
  updateInvoiceBalance(tx: Tx, input: InvoiceSettlementInput): Promise<boolean>;
}

function validMinor(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validate(input: InvoiceSettlementInput): boolean {
  return Number.isSafeInteger(input.companyId) && input.companyId > 0
    && Number.isSafeInteger(input.invoiceId) && input.invoiceId > 0
    && /^[a-zA-Z0-9:_-]{8,128}$/.test(input.idempotencyKey)
    && validMinor(input.grossMinor) && input.grossMinor > 0
    && validMinor(input.withholdingMinor)
    && input.withholdingMinor < input.grossMinor;
}

export async function commitVendorInvoicePaymentAtomic<Tx>(
  input: InvoiceSettlementInput,
  adapter: AtomicSettlementAdapter<Tx>,
): Promise<SettlementResult> {
  if (!validate(input)) return { outcome: "rejected", reason: "invalid" };
  return adapter.transaction(async (tx) => {
    // Global lock order: request key first, invoice second. The key lock
    // prevents two different invoice IDs using the same key from racing.
    await adapter.lockRequestKey(tx, input.companyId, input.idempotencyKey);
    const invoice = await adapter.lockInvoice(tx, input.companyId, input.invoiceId);
    if (!invoice || invoice.companyId !== input.companyId
      || invoice.invoiceId !== input.invoiceId) {
      return { outcome: "rejected", reason: "unavailable" };
    }
    // A completed payment may have moved the invoice to "paid".
    // Exact replay must still return its original committed result.
    const prior = await adapter.findByKey(tx, input.companyId, input.idempotencyKey);
    if (prior) {
      // A replay receipt is only valid when both linked writes have durable IDs.
      // Fail closed rather than acknowledging a partially committed payment.
      if (!Number.isSafeInteger(prior.journalId) || prior.journalId <= 0
        || !Number.isSafeInteger(prior.disbursementId) || prior.disbursementId <= 0) {
        throw new Error("ATOMIC_SETTLEMENT_INCOMPLETE_RECEIPT");
      }
      if (prior.companyId === input.companyId
        && prior.invoiceId === input.invoiceId
        && prior.grossMinor === input.grossMinor
        && prior.withholdingMinor === input.withholdingMinor) {
        return { outcome: "replayed", settlement: prior };
      }
      return { outcome: "rejected", reason: "idempotency_conflict" };
    }
    if (invoice.status !== "posted") {
      return { outcome: "rejected", reason: "unavailable" };
    }
    if (!validMinor(invoice.outstandingMinor)) {
      throw new Error("ATOMIC_SETTLEMENT_INVALID_AUTHORITY_BALANCE");
    }
    if (input.grossMinor > invoice.outstandingMinor) {
      return { outcome: "rejected", reason: "overpayment" };
    }
    const journalId = await adapter.postJournal(tx, input);
    if (!Number.isSafeInteger(journalId) || journalId <= 0) {
      throw new Error("ATOMIC_SETTLEMENT_INVALID_JOURNAL_ID");
    }
    const disbursementId = await adapter.createDisbursement(tx, input, journalId);
    if (!Number.isSafeInteger(disbursementId) || disbursementId <= 0) {
      throw new Error("ATOMIC_SETTLEMENT_INVALID_DISBURSEMENT_ID");
    }
    if (!(await adapter.updateInvoiceBalance(tx, input))) {
      // Thrown error forces a rollback; never return a rejected status after writes.
      throw new Error("ATOMIC_SETTLEMENT_BALANCE_CONFLICT");
    }
    return {
      outcome: "created",
      settlement: {
        ...input, journalId, disbursementId,
      },
    };
  });
}
