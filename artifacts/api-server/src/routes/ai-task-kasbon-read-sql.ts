/**
 * CST-DEV finance-side projection only. Starting from the authorized company's
 * own cash advances prevents inferring finance ownership for unlinked tasks.
 * The caller's current profile is rechecked in the SAME statement.
 * No amounts, employee identities, phone numbers, notes or financial writes.
 */
export const AI_TASK_KASBON_READ_SQL = `
WITH eligible AS (
  SELECT u.id
  FROM public.users u
  JOIN public.companies co ON co.id = 1 AND co.code = 'CST' AND co.is_active IS TRUE
  WHERE u.id::text = $1 AND lower(btrim(u.email)) = $2 AND u.role = $3
    AND u.role IN ('owner','super_admin')
    AND u.is_active IS TRUE AND u.status = 'active'
    AND (u.company_id = 1 OR u.company_id IS NULL)
), candidates AS (
  SELECT c.id AS advance_id, c.reference_number, c.lifecycle_status, c.posting_status,
    (c.approved_at IS NOT NULL) AS approval_recorded,
    (c.disbursed_at IS NOT NULL) AS disbursement_recorded,
    (c.entry_id IS NOT NULL OR c.accounting_entry_id IS NOT NULL OR c.journal_id IS NOT NULL) AS journal_reference_recorded
  FROM public.cash_advances c
  WHERE (SELECT count(*) FROM eligible) = 1
    AND c.company_id = 1 AND c.type = 'kasbon' AND c.advance_type = 'EMPLOYEE'
    AND c.source_system = 'ai_task_owner_wa'
  ORDER BY c.id DESC LIMIT 101
), links AS (
  SELECT c.*,
    CASE WHEN c.reference_number ~ '^KASBON-WA-[0-9]{13}$'
      AND t.total = 1 AND t.task_id IS NOT NULL
      AND (SELECT count(*) FROM public.cash_advances d
           WHERE d.company_id = 1 AND d.reference_number = c.reference_number) = 1
      THEN t.task_id ELSE NULL END AS task_id
  FROM (SELECT * FROM candidates ORDER BY advance_id DESC LIMIT 100) c
  LEFT JOIN LATERAL (
    SELECT count(*) AS total,
      min(a.id) FILTER (WHERE a.source = 'employee_kasbon_conversation'
        AND a.company_id IN ('default','1')) AS task_id
    FROM public.ai_tasks a
    WHERE a.task_number = c.reference_number
  ) t ON true
), projected AS (
  SELECT advance_id AS "advanceId", task_id AS "taskId",
    CASE
      WHEN task_id IS NULL THEN 'REFERENCE_REVIEW'
      WHEN lifecycle_status = 'approved' AND approval_recorded
        AND NOT disbursement_recorded AND NOT journal_reference_recorded
        AND posting_status = 'PENDING' THEN 'APPROVED_NO_DISBURSEMENT'
      WHEN lifecycle_status IN ('disbursed','outstanding','partially_settled','settled','repaid','closed')
        AND approval_recorded AND disbursement_recorded THEN 'DISBURSEMENT_RECORDED'
      ELSE 'CHECK_FINANCE_STATE'
    END AS state,
    approval_recorded AS "approvalRecorded",
    disbursement_recorded AS "disbursementRecorded",
    journal_reference_recorded AS "journalReferenceRecorded"
  FROM links
)
SELECT (SELECT count(*) FROM eligible) = 1 AS authorized,
  (SELECT count(*) FROM candidates) > 100 AS truncated,
  COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p."advanceId" DESC)
            FROM projected p), '[]'::jsonb) AS records
`;
