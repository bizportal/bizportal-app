/**
 * The AP "Bayar" shortcut is not a payment-settlement authority.
 * Hide it while an active posted supplier disbursement exists awaiting
 * bank reconciliation, including partial disbursements.
 * Server-side enforcement remains necessary at the actual writer.
 */
export function canOfferVendorInvoicePayShortcut(
  status: unknown,
  outstanding: unknown,
  postedDisbursementAmount: unknown,
): boolean {
  const open = status === "posted" || status === "matched";
  const balance = Number(outstanding);
  const recorded = Number(postedDisbursementAmount);
  return open
    && Number.isFinite(balance) && balance > 0.01
    && Number.isFinite(recorded) && recorded <= 0;
}
