import { createHash } from "node:crypto";
import {
  prepareCashJournal,
  type CashLedgerAdapter,
  type CashJournal,
  type CashScope,
  type StoredCashJournal,
} from "./cash-ledger-posting";

/**
 * Future Account18 cash *source identity*, not a registered financial writer.
 *
 * This contract intentionally uses a voucher UUID instead of historical Sheet
 * config/physical row coordinates. Neither documentSha256 nor approvalSha256 is
 * proof of authorization by itself. Only a separately authenticated server
 * document reader and signed Owner OTP receipt may supply these values in a
 * future real endpoint. No endpoint or business DB adapter is connected here.
 */
export type FutureCashVoucherScope = Pick<
  CashScope, "companyId" | "accountId" | "cashCoaId" | "counterpartyCoaId"
>;

export type FutureCashVoucher = Readonly<{
  voucherId: string; // persistent server-issued UUID v4; not Sheet row number
  date: string;
  direction: "IN" | "OUT";
  amount: string; // strict cents in canonical decimal form
  documentSha256: string; // to be verified against an authenticated primary document
  approvalSha256: string; // to be verified against an authenticated signed Owner receipt
}>;

function sha256(value: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function prepareFutureCashVoucherJournal(
  scope: FutureCashVoucherScope,
  voucher: FutureCashVoucher,
): CashJournal {
  if (scope.companyId !== 1 || scope.accountId !== 18 || scope.cashCoaId !== 75839) {
    throw new Error("FUTURE_CASH_CST_ACCOUNT18_ONLY");
  }
  // UUIDv4 is the durable source reference. A date, amount, or receipt is NOT
  // a unique business transaction ID and must not be used to dedupe vouchers.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(voucher.voucherId)) {
    throw new Error("FUTURE_CASH_VOUCHER_ID_REQUIRED");
  }
  if (!/^[0-9a-f]{64}$/.test(voucher.documentSha256) ||
      !/^[0-9a-f]{64}$/.test(voucher.approvalSha256)) {
    throw new Error("FUTURE_CASH_AUTHENTICATED_EVIDENCE_REQUIRED");
  }
  const fingerprint = sha256([
    "cst-future-cash-voucher-content-v1",
    scope.companyId, scope.accountId, scope.cashCoaId,
    scope.counterpartyCoaId, voucher.voucherId, voucher.date,
    voucher.direction, voucher.amount, voucher.documentSha256,
    voucher.approvalSha256,
  ]);
  // Reuse the established exact-cent, direction, date, and balanced-GL logic.
  // The internal synthetic config/row values are NOT persisted or included in
  // future source identity; only the voucher-based key below is returned.
  const balanced = prepareCashJournal(
    { ...scope, accountType: "cash", configId: 9001 },
    { rowNumber: 1, date: voucher.date, direction: voucher.direction,
      amount: voucher.amount, sourceFingerprint: fingerprint },
  );
  return {
    ...balanced,
    fingerprint,
    sourceKey: sha256([
      "cst-future-cash-voucher-v1", scope.companyId, scope.accountId, voucher.voucherId,
    ]),
  };
}

/**
 * QA adapter transaction contract only. Do not invoke from an HTTP route
 * until document issuer, COA company/postability and fresh signed Owner OTP
 * have all been checked independently and durably.
 */
export async function postFutureCashVoucherQa(
  adapter: CashLedgerAdapter,
  scope: FutureCashVoucherScope,
  voucher: FutureCashVoucher,
): Promise<{ id: string; replay: boolean }> {
  const plan = prepareFutureCashVoucherJournal(scope, voucher);
  return adapter.transaction(async tx => {
    const existing: StoredCashJournal | null = await tx.findForUpdate(plan.sourceKey);
    if (existing) {
      if (existing.fingerprint !== plan.fingerprint) {
        throw new Error("CASH_SOURCE_CHANGED_REVIEW_REQUIRED");
      }
      return { id: existing.id, replay: true };
    }
    const id = await tx.insertWithLines(plan);
    if (!id) throw new Error("CASH_JOURNAL_INSERT_FAILED");
    return { id, replay: false };
  });
}
