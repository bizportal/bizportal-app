#!/usr/bin/env bash
set -euo pipefail
# Strictly Docker postgres:16-alpine --network none. No hosted DB usage.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
N="cst-invoice-auditcols-qa-$$"
trap 'docker rm -f "$N" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --network none --name "$N" -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine >/dev/null
for i in $(seq 1 25);do
  if docker exec "$N" pg_isready -q -U postgres -d postgres >/dev/null 2>&1;then sleep 1;break;fi
  sleep 1
done
docker exec -i "$N" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
 < "$ROOT/scripts/tests/customer-invoice-audit-columns-synthetic.sql"

audit_insert(){
 local role="$1" journal="$2" tenant="$3" source="$4"
 docker exec "$N" psql -U "$role" -d postgres -v ON_ERROR_STOP=1 -Atc \
 "INSERT INTO public.audit_accounting_events
 (journal_id,action,company_id,amount,user_id,actor_type,correlation_id,change_reason,after_state)
 VALUES($journal,'SALES_INVOICE_ISSUED',$tenant,111,'qa-owner','SUPER_ADMIN',
 'sales_invoice:$tenant:$source:$journal',
 'ATOMIC_INVOICE_JOURNAL_AR','{\"source\":\"sales_invoice\"}'::jsonb) RETURNING id;"
}
for company in cst diva;do
 role="$(printf 'bizportal_customer_invoice_%s_writer_dev' "$company")"
 if [ "$company" = cst ];then id=101;tenant=1;source=701;else id=303;tenant=3;source=703;fi
 if audit_insert "$role" "$id" "$tenant" "$source" >/dev/null 2>&1;then
   echo "MISSING_AUDIT_COLUMN_PREGRANT_FAIL_NOT_ENFORCED";exit 11
 fi
 echo "CURRENT_HOSTED_AUDIT_COLUMN_PARITY_FAIL_CLOSED_$company"_PASS
done

# Disposable LOGIN roles differ from hosted NOLOGIN roles only for QA.
# Adapt just the source SQL's identity preflight; keep the column GRANT intact.
sed 's/AND NOT rolcanlogin AND NOT rolbypassrls/AND rolcanlogin AND NOT rolbypassrls/g' \
 "$ROOT/scripts/dev-customer-invoice-audit-columns-20261119.sql" |
 docker exec -i "$N" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q

for company in cst diva;do
 role="$(printf 'bizportal_customer_invoice_%s_writer_dev' "$company")"
 if [ "$company" = cst ];then id=101;tenant=1;source=701;foreign=3;else id=303;tenant=3;source=703;foreign=1;fi
 output="$(audit_insert "$role" "$id" "$tenant" "$source")"
 test -n "$output" || { echo "NARROW_AUDIT_GRANT_BROKEN_$company";exit 12;}
 echo "NARROW_AUDIT_COLUMNS_$company"_PASS
 if audit_insert "$role" "$id" "$foreign" "$source" >/dev/null 2>&1;then
  echo "CROSS_COMPANY_AUDIT_ALLOWED_$company";exit 13
 fi
 echo "CROSS_COMPANY_AUDIT_DENIED_$company"_PASS
 if audit_insert "$role" "$id" "$tenant" 999 >/dev/null 2>&1;then
  echo "FORGED_ACCOUNTING_SOURCE_AUDIT_ALLOWED_$company";exit 14
 fi
 echo "FORGED_ACCOUNTING_SOURCE_DENIED_$company"_PASS
done

docker exec -i "$N" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
 < "$ROOT/scripts/dev-customer-invoice-audit-columns-rollback-20261119.sql"
for company in cst diva;do
 role="$(printf 'bizportal_customer_invoice_%s_writer_dev' "$company")"
 result="$(docker exec "$N" psql -U postgres -d postgres -Atc \
 "SELECT has_column_privilege('$role','public.audit_accounting_events','change_reason','INSERT')::text
 || ':' || has_column_privilege('$role','public.audit_accounting_events','after_state','INSERT')::text")"
 test "$result" = "false:false" || { echo "AUDIT_GRANT_ROLLBACK_FAILED_$company:$result";exit 15;}
 echo "NARROW_AUDIT_GRANT_ROLLBACK_$company"_PASS
done
echo DISPOSABLE_PG16_AUDIT_MINIMUM_COLUMN_GRANT_PASS
