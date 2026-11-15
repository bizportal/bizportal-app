#!/usr/bin/env bash
# Safe negative-only HTTP test: actual compiled PR #77 API on isolated loopback.
# No real Admin login, SMTP delivery, database credentials, GCP or payment writes.
set -euo pipefail
ROOT="${ISSUE76_CANDIDATE_PATH:-/opt/bizportal-issue76-finance-scope-20261115}"
PORT="${ISSUE76_NEGATIVE_HTTP_PORT:-19879}"
ACTIVE="/opt/cst-bizportal-gmail-dev"
SERVICE="cst-bizportal-gmail-dev"
NGINX="/etc/nginx/sites-available/bizportal-dev.cstlogistic.co.id"
[[ "$PORT" =~ ^[0-9]+$ ]] && ((PORT>1024 && PORT<65536)) || exit 2
[[ -f "$ROOT/artifacts/api-server/dist/index.mjs" ]] || exit 2
! ss -ltnH "sport = :$PORT" | grep -q LISTEN || exit 2

live_pid="$(systemctl show "$SERVICE" -p MainPID --value)"
live_sha="$(git -C "$ACTIVE" rev-parse HEAD)"
nginx_sha="$(sha256sum "$NGINX" | cut -d' ' -f1)"
testdir="$(mktemp -d -t issue76-negative-http.XXXXXX)"
child=""
cleanup() {
  if [[ -n "$child" ]] && kill -0 "$child" 2>/dev/null; then
    kill -TERM "$child" 2>/dev/null || :
    for _ in $(seq 1 30); do
      kill -0 "$child" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$child" 2>/dev/null; then
      echo NEGATIVE_HTTP_GRACEFUL_SHUTDOWN_FAIL
      kill -KILL "$child" 2>/dev/null || :
    fi
    wait "$child" 2>/dev/null || :
  fi
  rm -f "$testdir/server.log"
  rmdir "$testdir" 2>/dev/null || :
}
trap cleanup EXIT
cd "$ROOT"

# A fresh ephemeral signing key is scoped to this short-lived loopback test.
# Never print or reuse the value; no production or DEV session secret is loaded.
command -v openssl >/dev/null || exit 2
test_signing_key="$(openssl rand -hex 32)"

# Only test-owned ephemeral key and .invalid allowlist, not real identities.
env -i HOME=/root PATH="$PATH" APP_ENV=development NODE_ENV=development \
 HOST=127.0.0.1 PORT="$PORT" \
 SESSION_SECRET="$test_signing_key" \
 BIZPORTAL_SIGNED_OTP_ENABLED_DEV=true \
 BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV=true \
 BIZPORTAL_FINANCE_GLOBAL_SCOPE_ENABLED_DEV=true \
 BIZPORTAL_FINANCE_GLOBAL_SUPERADMIN_EMAILS_DEV=synthetic@example.invalid \
 BIZPORTAL_FINANCE_GLOBAL_COMPANY_IDS_DEV=1,3 \
 FLEET_EMBEDDED_REMINDER_ENABLED=false \
 DEV_RECONCILIATION_SCHEDULERS_ENABLED=false \
 node artifacts/api-server/dist/index.mjs >"$testdir/server.log" 2>&1 &
child=$!
unset test_signing_key
ready=false
for _ in $(seq 1 80); do
  kill -0 "$child" 2>/dev/null || { echo NEGATIVE_HTTP_PROCESS_EXITED; exit 3; }
  if [[ "$(curl -q --noproxy '*' --proxy '' -sS --max-time 1 -o /dev/null -w '%{http_code}' \
     "http://127.0.0.1:$PORT/api/health/live" 2>/dev/null || :)" == 200 ]]; then ready=true; break; fi
  sleep 0.2
done
[[ "$ready" == true ]] || { echo NEGATIVE_HTTP_NOT_READY; exit 3; }

check() {
  local expected="$1" label="$2"
  shift 2
  local status
  status="$(curl -q --noproxy '*' --proxy '' --silent --show-error --max-time 5 -o /dev/null -w '%{http_code}' "$@")"
  [[ "$status" == "$expected" ]] || { echo "${label}_HTTP_$status_EXPECTED_$expected"; exit 5; }
  echo "${label}_HTTP_$expected=PASS"
}
base="http://127.0.0.1:$PORT/api"
check 200 LIVENESS "$base/health/live"
check 401 ANON_COMPANIES "$base/companies"
check 401 ANON_FINANCE_INVOICE "$base/mkt/admin/vendor-invoices/77"
check 401 ANON_FINANCE_AP "$base/mkt/admin/ap-preparations/88"
check 401 FORGED_HEADER_INVOICE -H "x-company-id: 3" "$base/mkt/admin/vendor-invoices/77"
check 401 FAKE_COOKIE_FINANCE -H "Cookie: bizportal_supabase_session=forged" "$base/mkt/admin/vendor-invoices/77"
check 401 ANON_COMPANY_SELECTION -X POST -H "Content-Type: application/json" \
 --data '{"companyId":1}' "$base/mkt/admin/finance-company-selection"
check 401 FORGED_COMPANY_SELECTION -X POST \
 -H "Content-Type: application/json" -H "x-company-id: 1" \
 -H "Cookie: bizportal_supabase_session=forged" --data '{"companyId":3}' \
 "$base/mkt/admin/finance-company-selection"
check 401 ANON_ACCOUNTING_HANDOFF -X POST -H "Content-Type: application/json" \
 --data '{}' "$base/mkt/admin/ap-preparations/88/accounting-handoff"

[[ "$(systemctl show "$SERVICE" -p MainPID --value)" == "$live_pid" ]]
[[ "$(git -C "$ACTIVE" rev-parse HEAD)" == "$live_sha" ]]
[[ "$(sha256sum "$NGINX" | cut -d' ' -f1)" == "$nginx_sha" ]]
echo ACTIVE_SERVICE_NGINX_UNCHANGED=true
echo ISSUE76_NEGATIVE_HTTP_REAL_COMPILED_API_PASS=true
