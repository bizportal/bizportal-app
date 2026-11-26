#!/usr/bin/env bash
# BizPortal DEV source-cutover provenance preflight, deliberately READ ONLY.
# Verifies the ACTUAL active Payroll-candidate frontend/API pair, not stale
# Travelintrips checkout assumptions. Never approves a cutover by itself.
set -euo pipefail

ACTIVE_NGINX="${ACTIVE_NGINX:-/etc/nginx/sites-available/bizportal-dev.cstlogistic.co.id}"
ACTIVE_FRONTEND_ROOT="${ACTIVE_FRONTEND_ROOT:-/opt/cst-bizportal-payroll-candidate-516fe60/public}"
ACTIVE_API_DIR="${ACTIVE_API_DIR:-/opt/cst-bizportal-payroll-candidate-caaef80}"
ACTIVE_API_PORT="${ACTIVE_API_PORT:-19981}"
ACTIVE_SERVICE="${ACTIVE_SERVICE:-cst-bizportal-payroll-stage.service}"
CANDIDATE="${CANDIDATE:-/tmp/bizportal-pr147-qa-2424bd3b}"
EXPECTED_CANDIDATE_SHA="${EXPECTED_CANDIDATE_SHA:-}"
EXPECTED_NGINX_SHA="${EXPECTED_NGINX_SHA:-baf9866f4a893e9193fda5dab77b6b4890b5a29f72e733a215338ab1ac4c7dfd}"
EXPECTED_FRONTEND_SHA="${EXPECTED_FRONTEND_SHA:-a291f675abd384e06fe9e7f5a1c723f7b3058f6eb8431ec81b082c19d453a265}"
EXPECTED_API_SHA="${EXPECTED_API_SHA:-1dbae20010bae5b767bde42fc248eb1a1e287c1619c8796cdc35ed3514c550ea}"

block(){ printf 'PREFLIGHT_BLOCKED=%s\nCUTOVER_APPROVED=false\n' "$1"; exit 2; }
# An older branch SHA must never silently be accepted as the new release candidate.
test -n "$EXPECTED_CANDIDATE_SHA" || block "expected_candidate_sha_required"
[[ "$EXPECTED_CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]] || block "expected_candidate_sha_invalid"
for executable in git sha256sum curl grep readlink systemctl nginx; do
  command -v "$executable" >/dev/null || block "missing_tool_${executable}"
done
test -f "$ACTIVE_NGINX" || block "nginx_missing"
test -f "$ACTIVE_FRONTEND_ROOT/index.html" || block "active_frontend_missing"
test -f "$ACTIVE_API_DIR/index.mjs" || block "active_api_missing"
test -d "$CANDIDATE/.git" || block "candidate_git_missing"
test -f "$CANDIDATE/artifacts/bizportal/dist/public/index.html" || block "candidate_frontend_missing"
test -f "$CANDIDATE/artifacts/api-server/dist/index.mjs" || block "candidate_api_missing"
hash_file(){ sha256sum "$1" | cut -d' ' -f1; }
test "$(hash_file "$ACTIVE_NGINX")" = "$EXPECTED_NGINX_SHA" || block "nginx_hash_drift"
test "$(hash_file "$ACTIVE_FRONTEND_ROOT/index.html")" = "$EXPECTED_FRONTEND_SHA" || block "active_frontend_hash_drift"
test "$(hash_file "$ACTIVE_API_DIR/index.mjs")" = "$EXPECTED_API_SHA" || block "active_api_hash_drift"
test "$(git -C "$CANDIDATE" rev-parse HEAD)" = "$EXPECTED_CANDIDATE_SHA" || block "candidate_sha_mismatch"
test -z "$(git -C "$CANDIDATE" status --porcelain)" || block "candidate_worktree_dirty"
test "$(git -C "$CANDIDATE" remote get-url origin)" = "https://github.com/bizportal/bizportal-app.git" || block "not_official_origin"
grep -Fq "root $ACTIVE_FRONTEND_ROOT;" "$ACTIVE_NGINX" || block "frontend_route_mismatch"
grep -Fq "proxy_pass http://127.0.0.1:$ACTIVE_API_PORT;" "$ACTIVE_NGINX" || block "api_route_mismatch"
/usr/sbin/nginx -t >/dev/null 2>&1 || block "system_nginx_syntax"
systemctl is-active --quiet "$ACTIVE_SERVICE" || block "active_service_down"
test "$(systemctl show "$ACTIVE_SERVICE" --property=WorkingDirectory --value)" = "$ACTIVE_API_DIR" || block "service_workdir_mismatch"
status="$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$ACTIVE_API_PORT/api/health/live")" || block "active_api_unreachable"
test "$status" = "200" || block "active_api_unhealthy"
printf 'TOPOLOGY_ATTESTED=true\nCANDIDATE_REPO= bizportal/bizportal-app\nCANDIDATE_SHA=%s\n' "$EXPECTED_CANDIDATE_SHA"
printf 'ACTIVE_API_PORT=%s\nACTIVE_SERVICE=%s\n' "$ACTIVE_API_PORT" "$ACTIVE_SERVICE"
printf 'CUTOVER_APPROVED=false\nREMAINING_GATES=signed_admin_dev_database,finance_payroll_qris_e2e,historical_orphan_isolation,rollback_database_and_full_runtime\n'
