/** Bounded read-only CST DEV general kasbon projection. Scope follows the
 * existing Finance-owned signed OTP reconciliation and canonical historical
 * type='kasbon' list. Amounts/statuses are recorded facts, not verified debt. */
export const DEV_KASBON_GENERAL_READ_SQL = `
WITH eligible AS (
  SELECT u.id
  FROM public.users u
  JOIN public.companies co ON co.id = 1 AND co.code = 'CST' AND co.is_active IS TRUE
  WHERE u.id::text = $1 AND lower(btrim(u.email)) = $2 AND u.role = $3
    AND u.role IN ('owner','super_admin')
    AND u.is_active IS TRUE AND u.status = 'active'
    AND (u.company_id = 1 OR u.company_id IS NULL)
), scoped AS (
  SELECT c.id, c.advance_number, c.date, c.employee_id,
    c.amount, c.paid_amount, c.remaining_amount, c.status, c.lifecycle_status,
    c.posting_status, c.approved_at, c.disbursed_at,
    (c.entry_id IS NOT NULL OR c.accounting_entry_id IS NOT NULL OR c.journal_id IS NOT NULL) AS journal_reference_recorded
  FROM public.cash_advances c
  WHERE (SELECT count(*) FROM eligible) = 1 AND c.company_id = 1 AND c.type = 'kasbon'
), page_rows AS (
  SELECT c.id AS "id", c.advance_number AS "advanceNumber", c.date::text AS "date",
    NULLIF(btrim(concat_ws(' ',e.first_name,e.last_name)),'') AS "employeeName",
    c.amount::text AS "amountRecorded", c.paid_amount::text AS "paidRecorded",
    c.remaining_amount::text AS "remainingRecorded", c.status AS "status",
    c.lifecycle_status AS "lifecycleStatus", c.posting_status AS "postingStatus",
    (c.approved_at IS NOT NULL) AS "approvalRecorded",
    (c.disbursed_at IS NOT NULL) AS "disbursementRecorded",
    c.journal_reference_recorded AS "journalReferenceRecorded"
  FROM (SELECT * FROM scoped ORDER BY date DESC NULLS LAST,id DESC LIMIT 50 OFFSET $4::integer) c
  LEFT JOIN public.employees e ON e.id = c.employee_id AND e.company_id = 1
)
SELECT (SELECT count(*) FROM eligible) = 1 AS authorized,
  (SELECT count(*)::text FROM scoped) AS total,
  COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p."date" DESC NULLS LAST,p.id DESC)
            FROM page_rows p), '[]'::jsonb) AS records
`;
