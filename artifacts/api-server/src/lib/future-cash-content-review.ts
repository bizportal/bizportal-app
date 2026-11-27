/** CST-DEV cash evidence classification, independent of byte/hash integrity.
 * This is a signed human attestation, NOT AI/OCR content verification.
 */
export type CashEvidenceKind = "BANK_TRANSFER_RECEIPT" | "CASH_DEPOSIT_SLIP" | "SIGNED_CASH_RECEIPT";
export type CashEvidenceReview = Readonly<{
  evidenceKind: CashEvidenceKind;
  evidenceDate: string;
  evidenceAmountCents: string;
  reference: string;
  counterCoaId: number;
}>;

const KINDS = new Set<CashEvidenceKind>(["BANK_TRANSFER_RECEIPT","CASH_DEPOSIT_SLIP","SIGNED_CASH_RECEIPT"]);

export function cashAmountToCents(value: unknown): string | null {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
  return amount > 0n && amount <= 99999999999999n ? amount.toString() : null;
}

export function parseCashEvidenceReview(
  body: Record<string, unknown>,
  document: { date:string; amountCents:string },
): CashEvidenceReview | null {
  const kind = body.evidenceKind;
  const date = body.evidenceDate;
  const counterCoaId = body.counterCoaId;
  const rawReference = body.reference;
  if (body.attested !== true || typeof kind !== "string" || !KINDS.has(kind as CashEvidenceKind) ||
      typeof date !== "string" || date !== document.date ||
      typeof counterCoaId !== "number" || !Number.isSafeInteger(counterCoaId) || counterCoaId <= 0 ||
      typeof rawReference !== "string" || rawReference !== rawReference.trim() ||
      rawReference.length < 6 || rawReference.length > 120 ||
      !/[0-9]/.test(rawReference) || /\b(?:NPWP|KTP|NIK|IDENTITY CARD)\b/i.test(rawReference)) return null;
  const amountCents = cashAmountToCents(body.evidenceAmount);
  if (!amountCents || amountCents !== document.amountCents) return null;
  return { evidenceKind:kind as CashEvidenceKind,evidenceDate:date,evidenceAmountCents:amountCents,
    reference:rawReference,counterCoaId };
}

export function matchingCashEvidenceReview(
  metadata: unknown,
  document: { transactionId:string; sourceFingerprint:string; documentSha256:string;
    date:string; amountCents:string },
  counterCoaId: number,
): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const m=metadata as Record<string,unknown>;
  return m.transactionId===document.transactionId && m.sourceFingerprint===document.sourceFingerprint &&
    m.documentSha256===document.documentSha256 && m.counterCoaId===counterCoaId &&
    m.evidenceDate===document.date && m.evidenceAmountCents===document.amountCents &&
    typeof m.evidenceKind==="string" && KINDS.has(m.evidenceKind as CashEvidenceKind) &&
    typeof m.reference==="string" && m.reference.length>=6 && /[0-9]/.test(m.reference);
}
