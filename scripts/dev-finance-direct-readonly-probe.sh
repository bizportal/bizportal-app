#!/usr/bin/env bash
# Standalone CST-DEV Finance DB direct TLS login / RLS smoke test.
# No service restart, no DB writes, no secret logging or persistent artifacts.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${APP_ENV:-}" != "development" ||
      "${BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV:-}" != "true" ||
      "${PR50_FINANCE_READONLY_PROBE:-}" != "true" ]]; then
  echo "FINANCE_DIRECT_READONLY_RESULT=PROBE_NOT_EXPLICITLY_AUTHORIZED" >&2
  exit 2
fi
OUT="$(mktemp "$ROOT/lib/db/.pr50-readonly-probe-XXXXXX.mjs")"
trap 'rm -f "$OUT"' EXIT
(
  cd "$ROOT"
  pnpm --filter @workspace/api-server exec esbuild     "$ROOT/scripts/dev-finance-direct-readonly-probe.ts"     --bundle --platform=node --format=esm --packages=external     --outfile="$OUT" >/dev/null
)
node "$OUT"
