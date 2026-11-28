/** Existing signed BizPortal management scope, fixed CST-DEV, one read-only
 * snapshot. General employee kasbon history is not restricted to AI Task source.
 * No arbitrary company, notes, bank account details, or financial mutations. */
export const DEV_CST_KASBON_HISTORY_SQL = `
WITH eligible AS (
  SELECT u.id FROM public.users u
  JOIN public.companies co ON co.id = 1 AND co.code = 'CST' AND co.is_active IS TRUE
  WHERE u.id::text = $1 AND lower(btrim(u.email)) = $2 AND u.role = $3
    AND u.role IN ('owner','super_admin')
    AND u.is_active IS TRUE AND u.status = 'active'
    AND (u.company_id = 1 OR u.company_id IS NULL)
), scoped AS (
  SELECT c.id, c.advance_number AS "advanceNumber", c.date::text AS date,
    nullif(btrim(concat_ws(' ', e.first_name, e.last_name)), '') AS "employeeName",
    c.category, c.amount::text AS "recordedAmount",
    c.paid_amount::text AS "recordedPaidAmount", c.remaining_amount::text AS "recordedRemainingAmount",
    c.status AS "legacyStatus", c.lifecycle_status AS "lifecycleStatus",
    c.posting_status AS "postingStatus",
    (c.approved_at IS NOT NULL) AS "approvalRecorded",
    (c.disbursed_at IS NOT NULL) AS "disbursementRecorded",
    (c.entry_id IS NOT NULL OR c.accounting_entry_id IS NOT NULL OR c.journal_id IS NOT NULL) AS "journalReferenceRecorded",
    CASE
      WHEN c.status = 'void' AND c.lifecycle_status = 'voided' AND c.posting_status = 'VOIDED'
        THEN 'VOID_RECORDED'
      WHEN c.voided_at IS NOT NULL OR c.status = 'void' OR c.lifecycle_status = 'voided'
        OR c.posting_status = 'VOIDED' THEN 'CHECK_FINANCE_STATE'
      WHEN c.lifecycle_status = 'approved' AND c.approved_at IS NOT NULL AND c.disbursed_at IS NULL
        AND c.entry_id IS NULL AND c.accounting_entry_id IS NULL AND c.journal_id IS NULL
        AND c.posting_status = 'PENDING' THEN 'APPROVED_NO_DISBURSEMENT'
      WHEN c.lifecycle_status IN ('disbursed','outstanding','partially_settled','settled','repaid','closed')
        AND c.approved_at IS NOT NULL AND c.disbursed_at IS NOT NULL THEN 'DISBURSEMENT_RECORDED'
      WHEN c.lifecycle_status IN ('draft','pending_approval','submitted') AND c.approved_at IS NULL
        AND c.disbursed_at IS NULL AND c.entry_id IS NULL AND c.accounting_entry_id IS NULL
        AND c.journal_id IS NULL THEN 'WAITING_APPROVAL_RECORDED'
      ELSE 'CHECK_FINANCE_STATE'
    END AS state
  FROM public.cash_advances c
  LEFT JOIN public.employees e ON e.id = c.employee_id AND e.company_id = c.company_id
  WHERE (SELECT count(*) FROM eligible) = 1
    AND c.company_id = 1 AND c.type = 'kasbon' AND c.advance_type = 'EMPLOYEE'
), page AS (
  SELECT * FROM scoped ORDER BY date DESC NULLS LAST, id DESC LIMIT 50 OFFSET $4
)
SELECT (SELECT count(*) FROM eligible) = 1 AS authorized,
  (SELECT count(*)::int FROM scoped) AS total,
  COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.date DESC NULLS LAST, p.id DESC) FROM page p), '[]'::jsonb) AS records
`;
