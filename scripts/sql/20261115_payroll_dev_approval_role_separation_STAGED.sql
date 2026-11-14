-- STAGED ONLY. DO NOT EXECUTE during PR review, CI, or deployment.
-- CST-DEV ONLY (project ref xssrfshdrtdfupgqwfdw).
-- Objective: leave historical unsigned HR draft->reviewed available while
-- preventing the legacy Payroll DEV role from manufacturing an approval date.
-- PRECONDITIONS:
-- 1. Confirm all active HR review paths DO NOT write approved_at.
-- 2. Verify rollback and saved grants/policies on CST-DEV.
-- 3. Verify separate approval login is independently provisioned with credentials
--    managed outside GitHub; do NOT share bizportal_payroll_dev password.
-- 4. Approver role needs scoped SELECT on payroll_runs/items, employees,
--    cash_advances and reservation tables, subject to separately audited RLS.
-- 5. Never run against PROD, never alter existing rows/status/notes, never
--    enable PAYROLL_DEV_SUPER_ADMIN_APPROVAL_ENABLED as part of this migration.
--
-- Phase 1 (only after approval of real DEV compatibility tests):
--   REVOKE UPDATE (approved_at) ON TABLE public.payroll_runs
--      FROM bizportal_payroll_dev;
-- Leave UPDATE(status,notes) and existing HR transition policy unchanged.
--
-- Phase 2 (separate privileged change, not included as executable SQL here):
--   Provision independent bizportal_payroll_approver_dev LOGIN NOINHERIT
--   NOBYPASSRLS with rotated secret kept out of repository, and narrow
--   GRANT SELECT, UPDATE(status,approved_at,notes) on payroll_runs.
--   Install role-specific RLS requiring correct company scope, clean draft,
--   pending posting, null accounting/payment, and receipt/timestamp pair.
--   Grant scoped read on supporting tables needed for preview and Kasbon guard.
--   Ensure legacy role does not inherit approver role or possess SET ROLE.
--
-- Required real DEV denial checks before turning on the route:
-- * legacy review draft->reviewed with approved_at NULL: succeeds;
-- * legacy attempt to stamp approved_at: denied;
-- * approver cross-company SELECT/UPDATE: denied;
-- * non-Super-Admin signed session: denied;
-- * invalid/missing receipt or digest: denied;
-- * duplicate approval: denied;
-- * saved 5 historical Payroll runs remain unchanged;
-- * salary/GL/payment writes absent.
--
-- Rollback plan (ONLY for planned Phase 1 grant change):
--   GRANT UPDATE (approved_at) ON TABLE public.payroll_runs
--     TO bizportal_payroll_dev;
-- This rollback restores the prior broad capability and MUST NOT be
-- performed automatically; repeat security audit after any rollback.
SELECT
  r.rolname, r.rolcanlogin, r.rolbypassrls,
  has_column_privilege(r.oid,'public.payroll_runs','status','UPDATE') AS can_update_status,
  has_column_privilege(r.oid,'public.payroll_runs','approved_at','UPDATE') AS can_update_approved_at,
  has_column_privilege(r.oid,'public.payroll_runs','notes','UPDATE') AS can_update_notes
FROM pg_roles r
WHERE r.rolname IN ('bizportal_payroll_dev','bizportal_payroll_approver_dev')
ORDER BY r.rolname;
