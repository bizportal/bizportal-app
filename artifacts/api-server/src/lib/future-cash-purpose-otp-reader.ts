import { prepareFutureCashSource, type FutureCashSource } from "./future-cash-source-identity";
import type { TrustedFutureCashApproval } from "./future-cash-approval-preflight";

/**
 * Read-only adapter over existing CST-DEV approval_requests and
 * bizportal_email_otp_codes. Requires a PURPOSE-SEPARATED OTP verification;
 * a normal admin-email-login OTP cannot authorize financial posting.
 *
 * No issuance, approvals, inserts, session changes or posting are performed.
 * An authorized backend issuer/immutable audit is still required to create
 * matching records; never use client-provided approval metadata.
 */
type EvidenceRow = {
  transaction_id: string;
  source_fingerprint: string;
  account_id: number;
  counter_coa_id: number;
  company_id: number;
  status: string;
  approval_type: string;
  approver_role: string;
  approved_by: string;
  approved_at: string;
  otp_email: string | null;
  otp_verified_at: string | null;
  otp_expires_at: string | null;
  otp_created_at: string | null;
};
export interface CashApprovalSqlReader {
  query(sql: string, parameters: readonly unknown[]): Promise<{ rows: EvidenceRow[] }>;
}

const validUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const validFingerprint = /^[a-f0-9]{64}$/;

export const futureCashOtpPurpose = (transactionId: string, fingerprint: string, counterCoaId: number): string => {
  if (!validUuid.test(transactionId) || !validFingerprint.test(fingerprint) ||
      !Number.isSafeInteger(counterCoaId) || counterCoaId <= 0 || counterCoaId > 2147483647 || counterCoaId === 75839) {
    throw new Error("INVALID_FUTURE_CASH_APPROVAL_SCOPE");
  }
  return `sc-cash-voucher:${transactionId}:${fingerprint}:${counterCoaId}`;
};

/**
 * Exact purpose, UUID and fingerprint match; verified OTP is consumed and
 * approved after the OTP event, within ten minutes. Returns null on any
 * error or mismatch. OTP codes/hashes are not selected or exposed.
 */
export async function readPurposeBoundFutureCashApproval(
  source: FutureCashSource,
  reader: CashApprovalSqlReader,
): Promise<TrustedFutureCashApproval | null> {
  try {
    const { sourceFingerprint } = prepareFutureCashSource(source);
    const purposePrefix = `sc-cash-voucher:${source.transactionId}:${sourceFingerprint}:`;
    const result = await reader.query(
      `select a.company_id,
              a.status, a.approval_type, a.approver_role, a.approved_by,
              a.approved_at::text as approved_at,
              a.metadata->>'transactionId' as transaction_id,
              a.metadata->>'sourceFingerprint' as source_fingerprint,
              (a.metadata->>'accountId')::integer as account_id,
              (a.metadata->>'counterCoaId')::integer as counter_coa_id,
              o.email as otp_email, o.verified_at::text as otp_verified_at,
              o.expires_at::text as otp_expires_at,
              o.created_at::text as otp_created_at
         from public.approval_requests a
         -- Defense in depth: historical OTP approval is NOT permission to use
         -- a document whose current server-owned status is REVOKED/PENDING.
         join public.sc_future_cash_documents d
           on d.transaction_id=$2::uuid
          and d.company_id=$1 and d.account_id=18 and d.cash_coa_id=75839
          and d.document_sha256=$5 and d.source_fingerprint=$3
         join lateral (
           select e.event_type
             from public.sc_future_cash_document_events e
            where e.transaction_id=d.transaction_id
            order by e.event_id desc limit 1
         ) current_document on current_document.event_type='VERIFIED'
         left join lateral (
           select email, verified_at, expires_at, created_at
             from public.bizportal_email_otp_codes
            where purpose = $4 || (a.metadata->>'counterCoaId')
              and id::text = a.metadata->>'otpEvidenceId'
              and verified_at is not null
              and verified_at <= expires_at
              and verified_at >= created_at
              and attempts < 5
              and lower(email) = lower(a.approved_by)
              and verified_at <= a.approved_at
              and verified_at >= a.approved_at - interval '10 minutes'
            order by verified_at desc, id desc
            limit 1
         ) o on true
        where a.company_id=$1 and a.module='cash_bank'
          and a.doc_type='sc_future_cash_voucher'
          and a.metadata->>'transactionId'=$2
          and a.metadata->>'sourceFingerprint'=$3
          and not exists (
            select 1 from public.sc_future_cash_document_events revoked
             where revoked.transaction_id=d.transaction_id
               and revoked.event_type='REVOKED'
          )
        order by a.updated_at desc, a.id desc limit 2`,
      [1, source.transactionId, sourceFingerprint, purposePrefix, source.sourceDocumentSha256],
    );
    // Reject ambiguous/multiple approvals rather than guess which one wins.
    if (result.rows.length !== 1) return null;
    const a = result.rows[0]!;
    if (a.company_id !== 1 || a.account_id !== 18 ||
        a.transaction_id !== source.transactionId ||
        a.source_fingerprint !== sourceFingerprint ||
        !Number.isSafeInteger(a.counter_coa_id) || a.counter_coa_id <= 0 ||
        a.counter_coa_id === source.cashCoaId ||
        a.status.toLowerCase() !== "approved" ||
        a.approval_type !== "signed_email_otp" ||
        !["owner", "super_admin"].includes(a.approver_role) ||
        !a.approved_by || !a.otp_email ||
        a.approved_by.toLowerCase() !== a.otp_email.toLowerCase() ||
        !a.otp_verified_at || !a.otp_expires_at || !a.otp_created_at || !a.approved_at) return null;
    const verifiedAtMs = Date.parse(a.otp_verified_at);
    const expiresAtMs = Date.parse(a.otp_expires_at);
    const createdAtMs = Date.parse(a.otp_created_at);
    const approvedAtMs = Date.parse(a.approved_at);
    if (![verifiedAtMs, expiresAtMs, createdAtMs, approvedAtMs].every(Number.isFinite) ||
        verifiedAtMs < createdAtMs || verifiedAtMs > expiresAtMs ||
        approvedAtMs < verifiedAtMs || approvedAtMs - verifiedAtMs > 10 * 60_000) return null;
    const approvedAt = new Date(approvedAtMs).toISOString();
    return {
      transactionId: source.transactionId, companyId: 1, accountId: 18,
      sourceFingerprint, counterCoaId: a.counter_coa_id,
      status: "APPROVED", authenticationMethod: "SIGNED_EMAIL_OTP",
      authorizedRole: a.approver_role as "owner" | "super_admin",
      approvedAt,
    };
  } catch {
    return null;
  }
}
