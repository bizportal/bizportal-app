-- CST-DEV only. Review before use; reverses the narrowly scoped PR #166 approval writer.
begin;
drop policy if exists pr166_marketplace_payment_approval_update_dev on public.payment_requests;
revoke update(status,approved_by,approved_at,mkt_approved_by,mkt_approved_at,
 mkt_treasury_ready_by,mkt_treasury_ready_at,mkt_lifecycle_status)
 on public.payment_requests from
 bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
drop policy if exists mkt_approval_audit_company_insert_dev on public.mkt_payment_approval_audit_dev;
drop policy if exists mkt_approval_audit_company_read_dev on public.mkt_payment_approval_audit_dev;
revoke all on public.mkt_payment_approval_audit_dev from
 bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
drop table if exists public.mkt_payment_approval_audit_dev;
commit;
