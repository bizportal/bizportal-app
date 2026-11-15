/** A UI hint only. The canonical Gmail import transaction separately enforces this boundary. */
export function isPaymentEvidenceSubject(subject: string | null | undefined): boolean {
  const normalized = (subject ?? "")
    .toLowerCase()
    .replace(/[._/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /(?:^| )(?:payment slip|payment advice|remittance advice|bukti transfer|bukti pembayaran|konfirmasi pembayaran)(?: |$)/.test(normalized);
}
