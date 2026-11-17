# Fleet → PT Diva Servis: dedicated DEV runtime

This runtime hosts the existing canonical `/api/integrations/fleet` router from `bizportal/bizportal-app`. It imports the dedicated Fleet database selector and starts no shared BizPortal routes, schedulers, WhatsApp workers, or second accounting implementation.

## Scope and identities

| Component | Identity and scope |
| --- | --- |
| Fleet operational source | `fleet_cash_source_login_dev`; source company 1 |
| Finance receiver | `bizportal_fleet_finance_login_dev`; Finance company 3, PT Diva Servis |
| Receiver source evidence | Company 1 payment SELECT and row lock only; source mutation prohibited |
| Target accounts | Cash 49187, driver receivable 49191, cash journal 20 |
| Runtime origin | `http://fleet-finance-dev:19888` on the existing private Fleet DEV Docker network |

The receiver's transaction wrapper requires APP_ENV development, explicit enablement, source 1 and destination 3, the exact login/current role, NOINHERIT/non-superuser/non-BYPASS attributes, database `postgres`, and active RLS on companies, source payments, settings, COAs, journals, entries, lines, ledger and periods. It binds additional transaction-local company GUCs. Database policies also hardcode the role/session and companies, so caller-controlled GUCs cannot authorize another company.

The pool is bounded at two connections, with an 8-second connection timeout, 20-second client query timeout and 5-second idle timeout. Transactions apply a 15-second statement timeout and 8-second lock timeout. Failed work rolls back; an unusable rollback connection is discarded.

## Credential configuration

Root-owned server configuration is at `/etc/fleet-finance-dev/runtime.env`, mode 0600 under a protected directory. Never print, commit, or copy its values into logs.

Exactly one dedicated credential source is selected:

- `FLEET_FINANCE_DATABASE_URL_DEV`: explicitly injected protected server DSN.
- `FLEET_FINANCE_GCP_SECRET_NAME_DEV=bizportal-fleet-finance-dev`: raw DSN read by the existing GCP helper and bootstrap identity.

Selecting both fails closed. There is no fallback to the general application pool, general GCP secret, Marketplace Finance role, or existing Diva reader. A changed credential requires controlled receiver recreation; a GCP read is cached for at most 60 seconds.

Both paths require the exact Fleet role and CST-DEV project `xssrfshdrtdfupgqwfdw`, database `postgres`, supported Supabase endpoints/ports, and TLS. Both direct and pooler endpoints use the existing pinned public Supabase Root 2021 CA. Actual strict TLS probes for both dedicated roles confirmed this CA on the verified pooler; system roots alone returned SELF_SIGNED_CERT_IN_CHAIN. The bundled fingerprint was compared with the already trusted server CA file. Explicit pg SSL options always verify both chain and hostname, ignoring URL options that could replace those checks.

The direct CST-DEV endpoint was IPv6-only during preparation. The protected Docker runtime uses the existing verified project pooler host `aws-1-ap-southeast-2.pooler.supabase.com:6543`, with username `bizportal_fleet_finance_login_dev.xssrfshdrtdfupgqwfdw`. The DSN password is provisioned separately.

Other receiver settings are:

| Variable | Required value/purpose |
| --- | --- |
| `APP_ENV` | `development` |
| `FLEET_FINANCE_DATABASE_ENABLED_DEV` | `true` |
| `FLEET_FINANCE_COMPANY_MAP` | `{"1":3}` |
| `FLEET_FINANCE_SERVICE_TOKEN` | Protected token shared only with the Fleet caller |
| `FLEET_FINANCE_WRITE_ENABLED` | Initially `false`; enabled after actual role/TLS/read preflight |
| `FLEET_FINANCE_DEV_HOST` | `0.0.0.0` inside the private container |
| `FLEET_FINANCE_DEV_PORT` | `19888` |

The Fleet caller uses `CENTRAL_FINANCE_BASE_URL=http://fleet-finance-dev:19888`, the matching protected service token, the same company map, and its separate source/database/write gates.

## Build and private deployment

From the canonical worktree:

```sh
pnpm --filter @workspace/api-server run build:fleet-finance-dev
docker compose -f artifacts/api-server/fleet-finance-dev.compose.yml config --quiet
docker compose -f artifacts/api-server/fleet-finance-dev.compose.yml up -d
```

Run the final build after committing the reviewed source. The bundle embeds its source commit and whether the worktree was dirty. The private `/healthz` response reports those values; it is liveness evidence, not proof of database write capability.

The Compose service uses the cached, digest-pinned Node 22 Alpine image, the existing `fleet-integration-stage_fleet-dev` network, alias `fleet-finance-dev`, no published ports, a nonroot user, read-only filesystem/bundle, no Linux capabilities and no-new-privileges. It is separate from the shared legacy `cst-bizportal-gmail-dev.service`, whose checkout remains untouched.

The authenticated settings GET returns both company IDs, accounts/journal, `writeEnabled`, `writeReady` and `settingsReadOnly: true`. Write readiness combines the selected role/RLS/settings proof with actual source-lock, target INSERT/UPDATE, ledger, period and sequence privileges. It describes the cash posting/reversal capability preflight; a committed operational test remains separate evidence.

Dedicated DEV settings PUT returns HTTP 403 with `FLEET_FINANCE_SETTINGS_READ_ONLY` before database access. Existing target configuration is managed by Finance. Enabling cash posting does not grant settings writes.

## Activation and rollback

1. Apply the reviewed DEV-only scoped role migration and provision its protected credentials through the authorized server process.
2. Start the private receiver with its writer OFF. Verify the expected clean build SHA, strict TLS, actual role/session, company isolation, authenticated mapped settings, missing-token rejection and false write readiness while OFF.
3. Confirm the caller's dedicated source identity, matching private receiver/token/map, and source/receiver capability probes.
4. Enable only the DEV source/receiver cash gates and recreate the relevant services. Exercise a distinct authorized source-company-1 QA payment, same-ID retry, then an auditable company-3 reversal. Retain immutable posted evidence.
5. Verify public signed-in Fleet behavior and preserve Vehicles/Transactions reader behavior.

For service rollback, disable the caller's cash write gate and receiver writer, then stop this receiver service. Recreate it only with the approved protected configuration and reviewed artifact. No rollback step deletes posted journals, weakens database protections, changes existing readers, or touches PROD.

## Verification

The source candidate passed 71 scoped unit/HTTP/contract checks, full db/API TypeScript, thin bundle build and Compose validation. Isolated Node 22 runtime checks covered liveness, authenticated route enforcement, missing dedicated credentials, read-only settings, unrelated route exclusion and refusal to start in APP_ENV production.

The actual new transaction wrapper and exact reviewed role migration passed 27 PostgreSQL HTTP checks; the actual Fleet source selector/recovery flow passed 10 checks. A separate real-LOGIN PostgreSQL proof passed 8 checks for UPDATE(id) lock-only access, including denial of actual mutation despite a broad permissive PUBLIC update policy.

Reproduction and actual DEV acceptance evidence are recorded in `scripts/FLEET_FINANCE_DSV_QA.md`. Prepared source and isolated tests alone do not assert that the private service has already been activated.
