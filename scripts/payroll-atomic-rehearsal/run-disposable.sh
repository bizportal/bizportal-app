#!/usr/bin/env bash
# Explicit test-only launcher. Never reads /proc, .env or live service secrets.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
legacy_root=${1:?Supply the absolute path to the SHA-pinned legacy source snapshot}
suite=${2:-native}
[[ "$suite" = native || "$suite" = application || "$suite" = triggers || "$suite" = permissions || "$suite" = packaged ]] || { echo UNKNOWN_SUITE >&2; exit 2; }
[[ "$legacy_root" = /* ]] || { echo EXPLICIT_ABSOLUTE_SOURCE_REQUIRED >&2; exit 2; }
command -v docker >/dev/null
command -v node >/dev/null
command -v patch >/dev/null
docker image inspect postgres:16-alpine >/dev/null
if ss -lnt '( sport = :65432 )' | tail -n +2 | grep -q .; then echo DISPOSABLE_TEST_PORT_IN_USE >&2; exit 2; fi
name="cst-payroll-atomic-fixture-$$"
created=false
cleanup(){ if "$created"; then docker rm -f "$name" >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker run --pull=never --rm -d --name "$name" --memory=256m \
 --tmpfs /var/lib/postgresql/data:rw -p 127.0.0.1:65432:5432 \
 -e POSTGRES_USER=postgres.xssrfshdrtdfupgqwfdw \
 -e POSTGRES_PASSWORD=ci-disposable-only -e POSTGRES_DB=payroll_ci \
 postgres:16-alpine >/dev/null
created=true
ready=false
for _ in $(seq 1 30); do
 if docker exec "$name" pg_isready -U postgres.xssrfshdrtdfupgqwfdw -d payroll_ci >/dev/null 2>&1; then ready=true; break; fi
 sleep .5
done
"$ready" || { echo DISPOSABLE_DATABASE_NOT_READY >&2; exit 3; }
env -i PATH="$PATH" HOME="$HOME" \
 PAYROLL_PG_E2E_URL='postgresql://postgres.xssrfshdrtdfupgqwfdw:ci-disposable-only@127.0.0.1:65432/payroll_ci' \
 node "$here/run.mjs" "$legacy_root" "$suite"
