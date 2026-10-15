# BizPortal repository migration

This repository is a **clean source snapshot** from Travelintrips/CST-BIZPORTAL
at source commit `cd9a94dc39be3322248ddc53ca2bd0b5e53134db` (main, 16 October 2026).
It intentionally starts a **new Git history**; no source repository commits,
secrets, payment data, production config, database dumps or attachments are
copied.

Included: BizPortal frontend, canonical API, workspace libraries, required
build/runtime scripts and release test workflows.

Excluded deliberately: .agents, .migration-backup, .upstream-cst-super-app,
audit, screenshots, attached_assets, mockup-sandbox, Replit state files and
local credentials. No change to existing production deployment or database.

Release gates: verify build, API and UI tests, business E2E in DEV, credentials
rotation where required, final production smoke, and explicit cutover decision.
DEV/PROD secrets must be supplied by an approved secrets manager, not Git.

Until release gates pass, production remains served by its existing deployment.
