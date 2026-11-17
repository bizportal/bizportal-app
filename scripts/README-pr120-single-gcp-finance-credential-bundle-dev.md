# BizPortal Finance DEV — one GCP secret, two restricted database logins

**DEV proposal only.** There is ONE existing Supabase CST-DEV PostgreSQL database
(project `xssrfshdrtdfupgqwfdw`) and ONE existing Google Cloud project
for its GCP Secret Manager. This proposal does **not** create additional
databases, Google Cloud projects, or privileged Finance accounts.

## One Secret Manager resource, two distinct PostgreSQL identities

GCP secret ID: `bizportal-marketplace-finance-dev-companies`.

The secret payload is a JSON object with **exact** fields. Shown here with
placeholders only; never put live connection strings in Git, chat, CI,
logs or application environment variables:

```json
{
  "version": 1,
  "companies": {
    "1": {
      "role": "bizportal_finance_cst_login_dev",
      "databaseUrl": "postgresql://<CST_DB_LOGIN>:<CST_PASSWORD>@<CST_DEV_SUPABASE_ENDPOINT>:6543/postgres?sslmode=verify-full&sslrootcert=/trusted/ca.crt"
    },
    "3": {
      "role": "bizportal_finance_diva_login_dev",
      "databaseUrl": "postgresql://<DIVA_DB_LOGIN>:<DIVA_PASSWORD>@<CST_DEV_SUPABASE_ENDPOINT>:6543/postgres?sslmode=verify-full&sslrootcert=/trusted/ca.crt"
    }
  }
}
```

Both URLs point to the SAME CST-DEV Supabase project/database. Their
usernames/passwords must be **different dedicated LOGIN identities**:
CST (company 1) and Diva (company 3), not the shared `postgres`, generic
Finance login, Supabase service role, or a user-controlled tenant GUC.
The established `validateFinanceDatabaseUrl` checks exact login identity,
Supabase project, database target and verified TLS. The canonical company
RLS policies and `session_user`-bound parent row-lock function remain
mandatory, independently guarded release prerequisites.

The single-GCP-secret opt-in flag is:
`BIZPORTAL_MARKETPLACE_FINANCE_SINGLE_GCP_SECRET_DEV=true`.
Existing company role mode must also be explicitly enabled:
`BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV=true`.
Without the new flag, the existing two-secret source is unchanged.
No direct shared DB URL, generic Finance secret or PROD fallback is permitted.
Changing modes or rotating a credential in a running pool requires restart.

## Safe release sequence (no change to active DEV in this Draft)

1. Independently review PR106–108 company-specific roles, restrictive RLS,
   narrow grants, lock-order across Portal/Finance, and deterministic rollback.
   Their original SQL files deliberately abort and **must never be executed
   by removing that guard on shared CST-DEV** as a shortcut.
2. Provision TWO dedicated, password-authenticated, non-elevated PostgreSQL
   LOGIN roles on the SAME CST-DEV database **only after approval**, with
   company-bound RLS. Confirm strict TLS, `session_user` matches role,
   all 11 restricted Finance tables enforce RLS, no parent UPDATE grants,
   and generic Finance login cannot execute the private lock.
3. With approved secret custody, create **one** versioned Secret Manager
   resource with the JSON shape above. Grant the existing authorized
   BizPortal DEV service account `roles/secretmanager.secretAccessor`
   **at the secret resource only**, never project-wide. Keep the payload
   out of source/config/CLI logs. Validate encrypted backup/rotation
   and rollback. One resource means a caller authorized to read it can
   read BOTH identities, so both roles MUST remain separately constrained
   by PostgreSQL; this is an explicit trade-off versus two independently
   permissioned secrets.
4. In a SEPARATE isolated canonical DEV process only, enable the opt-in
   single-secret mode with signed Super Admin/company selection, private
   Vendor Invoice Storage, Finance Writer and draft-only Accounting handoff.
   Preserve existing PROD and active private PR81 preview flags unchanged
   until independent release criteria pass.
5. Test real authenticated company-1/vendor-24 synthetic invoice,
   3-way match, AP `waiting_payment`, draft-only handoff and idempotent
   replays. Prove company-3 cannot access company-1 rows; no real payment,
   posted journal, unapproved WhatsApp/email or real physical delivery.
6. If any gate fails, keep Writer/Handoff OFF and restore original role/ACL,
   private process and secret version. Do not widen grants or use the
   database administrator to simulate successful tenant Finance login.

## Fail-closed controls in this change

- One pinned GCP Secret Manager resource name; requests cannot choose it.
- Exact schema: `version=1`, companies `1` and `3` only; two
  explicit expected roles and mandatory database URLs; no extra properties.
- BOTH URLs validated before any connection; malformed JSON, missing,
  swapped, privileged, wrong-project or TLS-downgraded DSNs are rejected.
- At most one GCP read per 60-second cache window including concurrent
  company requests, with a common version snapshot; no plaintext logging.
- Pool identity check still requires both `current_user` and
  `session_user` equal the expected company login, non-elevated
  role, 11 active RLS relations, and 11 restrictive FOR ALL policies.
- Existing Finance Writer OFF blocks all mutations even if read-only
  company credentials exist; APP_ENV=production cannot use this mode.
- Live Finance credential version rotation requires controlled restart,
  not silent reuse of a pool with stale authentication.

**Status:** source/CI and synthetic isolated integration can pass without
creating any real secret, database role or transaction. Shared CST-DEV
authenticated Writer E2E is a distinct release gate.
