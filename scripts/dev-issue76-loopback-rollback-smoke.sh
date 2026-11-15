#!/usr/bin/env bash
# Non-mutating source+API process rollback smoke. No credentials, Nginx,
# service changes, database operations, real OTP or feature activation.
set -euo pipefail

BASELINE="${ISSUE76_BASELINE_PATH:-/opt/bizportal-pr50-otp-finance-e2e-20261115}"
CANDIDATE="${ISSUE76_CANDIDATE_PATH:-/opt/bizportal-issue76-finance-scope-20261115}"
PORT="${ISSUE76_LOOPBACK_PORT:-19878}"
ACTIVE="/opt/cst-bizportal-gmail-dev"
SERVICE="cst-bizportal-gmail-dev"
NGINX="/etc/nginx/sites-available/bizportal-dev.cstlogistic.co.id"
case "$PORT" in
  *[!0-9]*|"") echo "INVALID_PORT"; exit 2 ;;
esac
[[ "$PORT" -ge 1025 && "$PORT" -le 65535 ]] || exit 2
for dir in "$BASELINE" "$CANDIDATE"; do
  [[ -r "$dir/artifacts/api-server/dist/index.mjs" ]] || { echo "MISSING_BUILD"; exit 2; }
done
[[ -f "$NGINX" ]] || exit 2
! ss -ltnH "sport = :$PORT" | grep -q LISTEN || { echo "PORT_ALREADY_OCCUPIED"; exit 2; }

active_pid="$(systemctl show "$SERVICE" -p MainPID --value)"
active_sha="$(git -C "$ACTIVE" rev-parse HEAD)"
nginx_hash="$(sha256sum "$NGINX" | cut -d' ' -f1)"
[[ "$(systemctl is-active "$SERVICE")" == "active" ]] || exit 2

tmp="$(mktemp -d -t issue76-loopback.XXXXXX)"
child=""
cleanup() {
  # Bound shutdown even when the API keeps connections open after SIGTERM.
  stop_child >/dev/null 2>&1 || :
  rm -f "$tmp"/server.log
  rmdir "$tmp" 2>/dev/null || :
}
trap cleanup EXIT

stop_child() {
  local stage="${1:-CLEANUP}" forced=false
  if [[ -n "$child" ]] && kill -0 "$child" 2>/dev/null; then
    kill -TERM "$child" 2>/dev/null || :
    for _ in $(seq 1 20); do
      if ! kill -0 "$child" 2>/dev/null; then break; fi
      sleep 0.1
    done
    if kill -0 "$child" 2>/dev/null; then
      echo "${stage}_SIGTERM_TIMEOUT_FORCE_STOP"
      forced=true
      kill -KILL "$child" 2>/dev/null || :
    fi
    wait "$child" 2>/dev/null || :
  fi
  child=""
  for _ in $(seq 1 30); do
    if ! ss -ltnH "sport = :$PORT" | grep -q LISTEN; then break; fi
    sleep 0.2
  done
  ! ss -ltnH "sport = :$PORT" | grep -q LISTEN || { echo "PORT_NOT_RELEASED"; exit 3; }
  if [[ "$stage" == "CANDIDATE" ]]; then
    [[ "$forced" == false ]] || { echo "CANDIDATE_GRACEFUL_SHUTDOWN_FAIL"; return 4; }
    echo "CANDIDATE_GRACEFUL_SIGTERM_PASS=true"
  fi
}

test_stage() {
  local name="$1" dir="$2"
  cd "$dir"
  # Never inherit the current shell's database, SMTP, GCP or production keys.
  env -i HOME=/root PATH="$PATH" APP_ENV=development NODE_ENV=development \
    HOST=127.0.0.1 PORT="$PORT" \
    FLEET_EMBEDDED_REMINDER_ENABLED=false \
    DEV_RECONCILIATION_SCHEDULERS_ENABLED=false \
    BIZPORTAL_SIGNED_OTP_ENABLED_DEV=false \
    BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV=false \
    BIZPORTAL_FINANCE_GLOBAL_SCOPE_ENABLED_DEV=false \
    node artifacts/api-server/dist/index.mjs >"$tmp/server.log" 2>&1 &
  child=$!
  local ready=false
  for _ in $(seq 1 60); do
    if ! kill -0 "$child" 2>/dev/null; then echo "${name}_SERVER_EXITED"; return 1; fi
    if [[ "$(curl -sS --max-time 1 -o /dev/null -w '%{http_code}' \
      "http://127.0.0.1:$PORT/api/health/live" 2>/dev/null || :)" == "200" ]]; then
      ready=true
      break
    fi
    sleep 0.2
  done
  [[ "$ready" == true ]] || { echo "${name}_NOT_READY"; return 1; }
  local auth_status company_status finance_status
  auth_status="$(curl -sS --max-time 3 -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:$PORT/api/auth/user")"
  company_status="$(curl -sS --max-time 3 -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:$PORT/api/companies")"
  finance_status="$(curl -sS --max-time 3 -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:$PORT/api/mkt/admin/vendor-invoices/77")"
  [[ "$auth_status" == "401" && "$company_status" == "401" && "$finance_status" == "404" ]] || {
    echo "${name}_UNEXPECTED_HTTP auth=$auth_status companies=$company_status finance=$finance_status"
    return 1
  }
  echo "${name}_SHA=$(git -C "$dir" rev-parse --short HEAD)"
  echo "${name}_LIVE=200 AUTH=401 COMPANIES=401 FINANCE_DISABLED=404 PASS"
  stop_child "$name"
}

test_stage "BASELINE" "$BASELINE"
test_stage "CANDIDATE" "$CANDIDATE"
test_stage "ROLLED_BACK" "$BASELINE"

[[ "$(systemctl show "$SERVICE" -p MainPID --value)" == "$active_pid" ]] || {
  echo "ACTIVE_SERVICE_PID_CHANGED"; exit 3;
}
[[ "$(git -C "$ACTIVE" rev-parse HEAD)" == "$active_sha" ]] || {
  echo "ACTIVE_SERVICE_SHA_CHANGED"; exit 3;
}
[[ "$(sha256sum "$NGINX" | cut -d' ' -f1)" == "$nginx_hash" ]] || {
  echo "NGINX_CHANGED"; exit 3;
}
[[ "$(systemctl is-active "$SERVICE")" == "active" ]] || exit 3
echo "ACTIVE_SERVICE_UNCHANGED=true"
echo "NGINX_UNCHANGED=true"
echo "ROLLBACK_SOURCE_API_LOOPBACK_SMOKE_PASS=true"
echo "LIVE_AUTH_DB_OTP_ROLLBACK_NOT_TESTED=true"
