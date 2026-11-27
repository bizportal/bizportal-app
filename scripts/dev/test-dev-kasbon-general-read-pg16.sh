#!/usr/bin/env bash
# Synthetic source shape only; no live DB, no network or published ports.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
tmp="$(mktemp -d)"
name="dev-kasbon-general-fixture-$$"
cleanup(){ docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT
docker run --rm -d --network none --name "$name" -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine >/dev/null
ready=false
for i in $(seq 1 45); do
 if docker exec "$name" env PGCONNECT_TIMEOUT=2 psql -X -h 127.0.0.1 -U postgres -d postgres -Atqc 'SELECT 1' 2>/dev/null | grep -qx 1; then ready=true;break;fi
 sleep 1
done
test "$ready" = true
python3 - "$root" "$tmp/test.sql" <<'PY'
from pathlib import Path
import sys
root,out=map(Path,sys.argv[1:])
s=(root/'artifacts/api-server/src/routes/dev-kasbon-general-read-sql.ts').read_text()
query=s.split('export const DEV_KASBON_GENERAL_READ_SQL = '+chr(96),1)[1].split(chr(96)+';',1)[0]
assert 'LIMIT 50 OFFSET $4::integer' in query
sql=r"""
\set ON_ERROR_STOP on
CREATE TABLE public.companies(id integer PRIMARY KEY,code text,is_active boolean);
CREATE TABLE public.users(id text PRIMARY KEY,email text,role text,company_id integer,status text,is_active boolean);
CREATE TABLE public.employees(id integer PRIMARY KEY,company_id integer,first_name text,last_name text);
CREATE TABLE public.cash_advances(id integer PRIMARY KEY,company_id integer,type text,employee_id integer,advance_number text,date date,
 amount numeric,paid_amount numeric,remaining_amount numeric,status text,lifecycle_status text,posting_status text,
 approved_at timestamptz,disbursed_at timestamptz,entry_id integer,accounting_entry_id integer,journal_id integer);
INSERT INTO public.companies VALUES(1,'CST',true),(2,'OTHER',true);
INSERT INTO public.users VALUES('fixture','fixture@example.invalid','super_admin',1,'active',true);
INSERT INTO public.employees VALUES(11,1,'Synthetic','CST'),(22,2,'Synthetic','Other');
INSERT INTO public.cash_advances VALUES
 (23,1,'kasbon',11,'FIXTURE-23','2026-11-28',100.25,0,100.25,'active','approved','PENDING',now(),NULL,NULL,NULL,NULL),
 (24,1,'kasbon',22,'FIXTURE-24','2026-11-27',NULL,NULL,NULL,'DRAFT','draft','PENDING',NULL,NULL,NULL,NULL,NULL),
 (25,2,'kasbon',22,'OTHER-COMPANY','2026-11-28',200,0,200,'active','approved','PENDING',now(),NULL,NULL,NULL,NULL),
 (26,1,'talangan',11,'OTHER-TYPE','2026-11-28',300,0,300,'active','approved','PENDING',now(),NULL,NULL,NULL,NULL),
 (27,NULL,'kasbon',11,'UNBOUND','2026-11-28',400,0,400,'active','approved','PENDING',now(),NULL,NULL,NULL,NULL);
"""
bs=chr(92)
def check(label,expr,mutation=None,role='super_admin',offset=0):
 global sql
 q=query.replace('$1',"'fixture'").replace('$2',"'fixture@example.invalid'").replace('$3',"'"+role+"'").replace('$4',str(offset))
 sql+="BEGIN;\n"
 if mutation:sql+=mutation+";\n"
 sql+="WITH actual AS ("+q+") SELECT ("+expr+") AS pass FROM actual "+bs+"gset\n"
 sql+=bs+"if :pass\n"+bs+"echo PASS "+label+"\n"+bs+"else\n"+bs+"echo FAIL "+label+"\n"+bs+"endif\nROLLBACK;\n"
check('authorized_scope_count_and_order',"""authorized AND total='2' AND jsonb_array_length(records)=2 AND records->0->>'advanceNumber'='FIXTURE-23' AND records->1->>'advanceNumber'='FIXTURE-24'""")
check('cross_company_employee_never_joined',"""records->0->>'employeeName'='Synthetic CST' AND records->1->'employeeName'='null'::jsonb""")
check('recorded_approval_not_disbursement_or_posting',"""records->0->>'approvalRecorded'='true' AND records->0->>'disbursementRecorded'='false' AND records->0->>'journalReferenceRecorded'='false' AND records->0->>'postingStatus'='PENDING'""")
check('null_money_not_zero',"""records->1->'amountRecorded'='null'::jsonb AND records->1->'paidRecorded'='null'::jsonb AND records->1->'remainingRecorded'='null'::jsonb""")
check('exact_decimal_source',"""records->0->>'amountRecorded'='100.25' AND records->0->>'remainingRecorded'='100.25'""")
check('foreign_profile_denied',"NOT authorized AND total='0' AND records='[]'::jsonb","UPDATE public.users SET company_id=2")
check('disabled_profile_denied',"NOT authorized AND total='0' AND records='[]'::jsonb","UPDATE public.users SET is_active=false")
check('resigned_profile_denied',"NOT authorized AND total='0' AND records='[]'::jsonb","UPDATE public.users SET status='resigned'")
check('wrong_role_denied',"NOT authorized AND total='0' AND records='[]'::jsonb","UPDATE public.users SET role='finance'",role='finance')
check('role_changed_denied',"NOT authorized AND total='0' AND records='[]'::jsonb","UPDATE public.users SET role='owner'")
check('inactive_company_denied',"NOT authorized AND total='0' AND records='[]'::jsonb","UPDATE public.companies SET is_active=false WHERE id=1")
check('wrong_company_identity_denied',"NOT authorized AND total='0' AND records='[]'::jsonb","UPDATE public.companies SET code='OTHER' WHERE id=1")
check('unbound_owner_explicit_cst_allowed',"authorized AND total='2'","UPDATE public.users SET role='owner',company_id=NULL",role='owner')
check('real_empty_only_authorized',"authorized AND total='0' AND records='[]'::jsonb","DELETE FROM public.cash_advances WHERE company_id=1 AND type='kasbon'")
many="INSERT INTO public.cash_advances(id,company_id,type,employee_id,advance_number,date) SELECT 100+i,1,'kasbon',11,'FIXTURE-'||i,'2026-11-26' FROM generate_series(1,55) i"
check('bounded_first_page_full_count',"authorized AND total='57' AND jsonb_array_length(records)=50",many)
check('bounded_second_page',"authorized AND total='57' AND jsonb_array_length(records)=7",many,offset=50)
check('out_of_range_preserves_total',"authorized AND total='57' AND records='[]'::jsonb",many,offset=100)
check('no_private_source_payload',"""NOT (records->0 ? 'company_id') AND NOT (records->0 ? 'employee_id') AND NOT (records->0 ? 'email') AND NOT (records->0 ? 'notes')""")
out.write_text(sql)
PY
docker exec -i "$name" env PGCONNECT_TIMEOUT=2 psql -X -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 < "$tmp/test.sql" | tee "$tmp/result"
test "$(grep -c '^PASS ' "$tmp/result")" -eq 18
! grep -q '^FAIL ' "$tmp/result"
echo DEV_GENERAL_KASBON_SQL=18/18_PASS
