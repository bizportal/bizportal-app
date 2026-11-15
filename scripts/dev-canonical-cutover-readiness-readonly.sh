#!/usr/bin/env bash
# Read-only cutover preflight for CST BizPortal DEV.
# It never changes Git refs, Nginx, systemd, databases, secrets, or feature flags.
set -euo pipefail

ACTIVE="${ACTIVE_DEV_PATH:-/opt/cst-bizportal-gmail-dev}"
CANDIDATE="${CANONICAL_CANDIDATE_PATH:-/opt/bizportal-pr38-shadow-check-20261114}"
NGINX="${NGINX_DEV_CONFIG:-/etc/nginx/sites-available/bizportal-dev.cstlogistic.co.id}"
SERVICE="${DEV_SERVICE_NAME:-cst-bizportal-gmail-dev.service}"

fail() { printf 'BLOCKED %s\n' "$1"; exit 2; }
for command in git grep sha256sum readlink curl; do command -v "$command" >/dev/null || fail "missing_tool_${command}"; done
test -d "$ACTIVE/.git" || fail "active_checkout_missing"
test -d "$CANDIDATE/.git" || fail "candidate_checkout_missing"
test -f "$NGINX" || fail "nginx_config_missing"
test -f "$ACTIVE/dist/public/index.html" || fail "active_frontend_build_missing"

active_remote="$(git -C "$ACTIVE" remote get-url origin)"
candidate_remote="$(git -C "$CANDIDATE" remote get-url origin)"
test "$active_remote" = "https://github.com/Travelintrips/CST-BIZPORTAL.git" || fail "unexpected_active_remote"
test "$candidate_remote" = "https://github.com/bizportal/bizportal-app.git" || fail "unexpected_candidate_remote"
test -z "$(git -C "$ACTIVE" status --porcelain)" || fail "active_worktree_dirty"
test -z "$(git -C "$CANDIDATE" status --porcelain)" || fail "candidate_worktree_dirty"

# Never print environment values, URL credentials, cookies, or tokens.
printf 'ACTIVE_SHA=%s\n' "$(git -C "$ACTIVE" rev-parse HEAD)"
printf 'CANDIDATE_SHA=%s\n' "$(git -C "$CANDIDATE" rev-parse HEAD)"
printf 'ACTIVE_DOCROOT=%s\n' "$(readlink -f "$ACTIVE/dist/public")"
printf 'NGINX_CONFIG_SHA256=%s\n' "$(sha256sum "$NGINX" | cut -d' ' -f1)"
grep -Fq "root $ACTIVE/dist/public;" "$NGINX" || fail "nginx_docroot_not_active"
grep -Fq 'proxy_pass http://127.0.0.1:19784;' "$NGINX" || fail "nginx_api_upstream_not_active"

if command -v nginx >/dev/null; then nginx -t >/dev/null 2>&1 || fail "nginx_syntax_invalid"; fi
if command -v systemctl >/dev/null; then
  systemctl is-active --quiet "$SERVICE" || fail "dev_service_not_active"
  working_dir="$(systemctl show -p WorkingDirectory --value "$SERVICE")"
  test "$working_dir" = "$ACTIVE" || fail "dev_service_workdir_unexpected"
fi
for route in /api/auth/user /api/companies; do
  status="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:19784$route")" || fail "localhost_route_unreachable"
  test "$status" = "401" || fail "anonymous_route_status_changed"
  printf 'ANONYMOUS_%s=%s\n' "$route" "$status"
done

printf 'READONLY_PREFLIGHT_PASS=true\n'
printf 'CUTOVER_APPROVED=false\n'
printf 'REMAINING_GATES=authenticated_admin_e2e,company_role_rls,accounting_qris_runtime_parity,rollback_rehearsal\n'
