#!/usr/bin/env python3
"""Stage/apply one official DEV artifact to the existing private Finance preview.

No database, credential, IAM, payment, messaging or public DEV changes. The caller
must first certify the company DB sessions, private Storage and signed HTTP gates.
This script retains authentication EnvironmentFiles and the systemd GCP bootstrap.
"""
from __future__ import annotations

import argparse
import datetime as dt
from email.utils import parsedate_to_datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

UNIT = "cst-bizportal-pr81-preview.service"
LEGACY_UNIT = "cst-bizportal-gmail-dev.service"
BASE = Path("/opt/bizportal-invoice-completion-20261117-7aaf715e8910")
DEFAULT_TARGET = Path("/opt/bizportal-invoice-completion-20261117")
TARGET = DEFAULT_TARGET
NODE = "/opt/actions-runner/_work/_tool/node/22.23.3/x64/bin/node"
DROP = Path("/etc/systemd/system/cst-bizportal-pr81-preview.service.d/zz-invoice-completion-dev.conf")
NGINX = Path("/etc/nginx/sites-available/finance-pr81.72.61.210.205.sslip.io")
LEGACY_NGINX = Path("/etc/nginx/sites-available/bizportal-dev.cstlogistic.co.id")
STATE_ROOT = Path("/var/lib/bizportal-invoice-preview-rollbacks")
LOCK = Path("/run/lock/cst-pr81-preview-only-rollout.lock")
STORAGE_ENV = Path("/etc/bizportal-finance-dev/vendor-storage-dev.env")
ORIGIN = "https://finance-pr81.72.61.210.205.sslip.io"
BASE_SHA = "7aaf715e8910618ff181b13774a778402f38e417"
BASE_BUNDLE = "08aa34f67d293ac5dc8ec237314d589d3307f0585ae2b51514cad40f252bf634"
BASE_NGINX = "f5398a4e3ebd27c328a23318eae5fe7128b73f010092d3416e9a9847de57d1dd"
BASE_UNIT = "0b08c4dff3bd1b07df97cfddd7d56dad043598fc22cbb8dbd7b7084ce9396bf3"
BASE_DROP = "a8e1a9658990c8d9065f8f902336802a59bb4de044cce0d08e6c676b54d1665e"
ACTIVE_WRITER_DROP = "51f44b18072b3ff615e5376d8f99cb63269c64a44734fe40676ec539cd8d2d85"
ACTIVE_WRITER_NGINX = "228d3fb6b12fdd48c637dff22a79787a1e655872ed0934ce656011f488491764"
PINNED_CANDIDATE_SHA = "c2d092e18a272a8c2606daaf76a01ec56c77b8c8"
BEGIN = "    # BEGIN INVOICE FINANCE DEV ROUTES\n"
END = "    # END INVOICE FINANCE DEV ROUTES\n"


def require(ok: bool, code: str) -> None:
    if not ok:
        raise RuntimeError(code)


def release_target(target: Path, commit: str) -> Path:
    require(re.fullmatch(r"[0-9a-f]{40}", commit) is not None, "FULL_COMMIT_SHA_REQUIRED")
    require(commit == PINNED_CANDIDATE_SHA, "UPGRADE_EXACT_CANDIDATE_SHA_REQUIRED")
    allowed = {Path(str(DEFAULT_TARGET) + "-" + commit[:12])}
    require(target in allowed, "TARGET_SOURCE_SUFFIX_MISMATCH")
    require(not target.is_symlink(), "TARGET_SYMLINK_NOT_ALLOWED")
    return target


def sha_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def digest(path: Path) -> str:
    return sha_bytes(path.read_bytes())


def command(*argv: str) -> str:
    # Never dump a subprocess environment or arbitrary failure output.
    result = subprocess.run(argv, capture_output=True, text=True)
    require(result.returncode == 0, "COMMAND_FAILED_" + Path(argv[0]).name)
    return result.stdout.strip()


def property_of(unit: str, name: str) -> str:
    return command("systemctl", "show", unit, "--property=" + name, "--value")


def public_flags() -> dict[str, str]:
    pid = int(property_of(UNIT, "MainPID"))
    raw = Path(f"/proc/{pid}/environ").read_bytes().decode()
    # Values remain in memory, never logged, copied to state, or returned to caller.
    return dict(item.split("=", 1) for item in raw.split("\0") if "=" in item)


def locked_file(path: Path) -> None:
    require(path.is_file() and not path.is_symlink(), "EXPECTED_REGULAR_FILE")
    info = path.stat()
    require(info.st_uid == 0 and not (info.st_mode & 0o022), "ROOT_OWNED_FILE_REQUIRED")


def validate_storage() -> None:
    locked_file(STORAGE_ENV)
    require(not (STORAGE_ENV.stat().st_mode & 0o077), "STORAGE_ENV_MUST_BE_0600")
    allowed = {"SUPABASE_URL_DEV", "SUPABASE_SERVICE_ROLE_KEY_DEV"}
    values: dict[str, str] = {}
    for line in STORAGE_ENV.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        require(separator == "=" and key in allowed and key not in values, "STORAGE_ENV_KEYS_INVALID")
        # This deliberately accepts only simple one-line systemd values.
        require(bool(value) and not any(c in value for c in " \t\"'\\$`"), "STORAGE_ENV_VALUE_INVALID")
        values[key] = value
    require(set(values) == allowed, "STORAGE_ENV_INCOMPLETE")
    require(values["SUPABASE_URL_DEV"].rstrip("/") == "https://xssrfshdrtdfupgqwfdw.supabase.co", "STORAGE_PROJECT_MISMATCH")
    require(len(values["SUPABASE_SERVICE_ROLE_KEY_DEV"]) >= 40, "STORAGE_CREDENTIAL_MISSING")


def route(pattern: str, methods: str, body_limit: str, *, token: bool = False, exact: bool = False) -> str:
    # Token URLs are capabilities: keep them out of the Nginx access log.
    log = "        access_log off;\n" if token else ""
    location = "= " + pattern if exact else '~ "' + pattern + '"'
    return (
        f"    location {location} {{\n"
        f"        limit_except {methods} {{ deny all; }}\n"
        "        limit_req zone=bizportal_dev_login burst=10 nodelay;\n"
        "        limit_req_status 429;\n"
        f"        client_max_body_size {body_limit};\n" + log +
        "        proxy_pass http://127.0.0.1:19881;\n"
        "        proxy_http_version 1.1;\n"
        '        proxy_set_header Authorization "";\n'
        "        proxy_set_header Host $host;\n"
        "        proxy_set_header X-Forwarded-Host $host;\n"
        "        proxy_set_header X-Forwarded-Proto https;\n"
        "        proxy_set_header X-Real-IP $remote_addr;\n"
        "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n"
        "        proxy_connect_timeout 4s;\n"
        "        proxy_read_timeout 45s;\n"
        "        proxy_send_timeout 30s;\n"
        "    }\n"
    )


def nginx_block() -> str:
    ident = "[1-9][0-9]{0,9}"
    token = "(?:[0-9A-Fa-f]{48}|[0-9A-Fa-f]{64})"
    return BEGIN + (
        route("/api/sales/customer-invoices/auto-match-preview", "GET", "1024", exact=True) +
        route(f"^/api/mkt/admin/vendor-invoices/{ident}/(match|ap-preparation)$", "POST", "1024") +
        route(f"^/api/mkt/admin/ap-preparations/{ident}/(finance-review|waiting-payment|accounting-handoff)$", "POST", "1024") +
        route(f"^/api/mkt/vendor-invoice/{token}$", "POST", "21m", token=True) +
        route(f"^/api/mkt/vendor-invoice/{token}/invoices(/{ident})?$", "GET", "1024", token=True) +
        route(f"^/api/mkt/vendor-invoice/{token}/invoices/{ident}/submit$", "POST", "1024", token=True)
    ) + END


def nginx_content(original: str, mode: str) -> str:
    if BEGIN in original or END in original:
        require(original.count(BEGIN) == original.count(END) == 1, "NGINX_MARKERS_INVALID")
        before, rest = original.split(BEGIN, 1)
        _, after = rest.split(END, 1)
        original = before + after
    require(sha_bytes(original.encode()) == BASE_NGINX, "NGINX_BASELINE_CHANGED")
    if mode == "stage":
        return original
    anchor = "    # END PR81 FINANCE GET ONLY\n"
    require(original.count(anchor) == 1, "NGINX_ANCHOR_INVALID")
    return original.replace(anchor, anchor + nginx_block(), 1)


def drop_content(mode: str) -> str:
    enabled = "true" if mode == "writer" else "false"
    lines = [
        "[Service]", f"WorkingDirectory={TARGET}", "ExecStart=",
        f"ExecStart={NODE} --max-http-header-size=65536 {TARGET}/dist/index.mjs",
        f"Environment=BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV={enabled}",
        f"Environment=BIZPORTAL_MARKETPLACE_VENDOR_INVOICE_ENABLED_DEV={enabled}",
        f"Environment=BIZPORTAL_MARKETPLACE_ACCOUNTING_HANDOFF_ENABLED_DEV={enabled}",
        f"Environment=BIZPORTAL_MARKETPLACE_VENDOR_PARENT_LOCK_ENABLED_DEV={enabled}",
        f"Environment=BIZPORTAL_CUSTOMER_AR_PREVIEW_ENABLED_DEV={enabled}",
        "Environment=BIZPORTAL_FINANCE_NOTIFICATIONS_SUPPRESSED_DEV=true",
        "Environment=BIZPORTAL_MARKETPLACE_FINANCE_READONLY_ENABLED_DEV=true",
        "Environment=FLEET_EMBEDDED_REMINDER_ENABLED=false",
        "Environment=DEV_RECONCILIATION_SCHEDULERS_ENABLED=false",
        "Environment=GMAIL_INVOICE_SCHEDULER_ENABLED=false", "Environment=WA_ENABLED=false",
    ]
    if mode == "writer":
        lines += [
            "Environment=BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV=true",
            "Environment=BIZPORTAL_MARKETPLACE_FINANCE_SINGLE_GCP_SECRET_DEV=true",
            "Environment=BIZPORTAL_MARKETPLACE_FINANCE_PINNED_IPV4_SESSION_POOLER_DEV=true",
            # The company-bundle resolver rejects either legacy value when set.
            "Environment=BIZPORTAL_MARKETPLACE_FINANCE_GCP_SECRET_NAME_DEV=",
            "Environment=BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV=",
            f"EnvironmentFile={STORAGE_ENV}", "Environment=ALLOW_DEV_STORAGE_WRITES=true",
        ]
    return "\n".join(lines) + "\n"


def atomic_write(path: Path, data: bytes, mode: int) -> None:
    temporary = path.with_name(path.name + ".invoice-tmp-" + str(os.getpid()))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def status(url: str, method: str = "GET") -> int:
    # The existing shared Nginx login zone permits 10 requests/minute. Retry
    # only an explicit throttling response, never a transport or business error.
    for attempt in range(3):
        request = urllib.request.Request(url, method=method)
        if method == "POST":
            request.data = b"{}"
            request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=8) as response:
                return response.status
        except urllib.error.HTTPError as error:
            code = error.code
            retry_after = error.headers.get("Retry-After", "") if error.headers else ""
            error.close()
            if code != 429 or attempt == 2:
                return code
            delay = 6.2
            try:
                if re.fullmatch(r"[0-9]+", retry_after.strip()):
                    delay = float(retry_after)
                elif retry_after:
                    retry_at = parsedate_to_datetime(retry_after)
                    delay = retry_at.timestamp() - time.time()
            except (ValueError, OverflowError, TypeError):
                pass
            time.sleep(min(30.0, max(6.2, delay)))
        except (OSError, TimeoutError):
            return 0
    return 429


def ready() -> None:
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        if status("http://127.0.0.1:19881/api/health/ready") == 200:
            return
        time.sleep(0.5)
    raise RuntimeError("PRIVATE_PREVIEW_NOT_READY")


def http_gate(path: str, expected: int, code: str, method: str = "GET", *,
              ingress_deadline: float | None = None) -> None:
    while True:
        actual = status(ORIGIN + path, method) if method != "GET" else status(ORIGIN + path)
        if actual == expected:
            return
        # nginx -s reload returns after signaling the master, before every
        # worker serves the new allowlist. Only the old 404 may be transient;
        # success still requires the new route's exact anonymous 401.
        remaining = (ingress_deadline - time.monotonic()) if ingress_deadline is not None else 0
        if expected == 401 and actual == 404 and remaining > 0:
            time.sleep(min(0.5, remaining))
            continue
        diagnostic = f"HTTP_GATE {code} expected={expected} ingress={actual}"
        if ingress_deadline is not None:
            local = "http://127.0.0.1:19881" + path
            loopback = status(local, method) if method != "GET" else status(local)
            diagnostic += f" loopback={loopback}"
        # Only numeric statuses and a fixed gate identifier are emitted. Never
        # headers, response bodies, credentials, or capability-bearing URLs.
        print(diagnostic, file=sys.stderr)
        raise RuntimeError(f"{code}_EXPECTED_{expected}_OBSERVED_{actual}")


def check_http_gates(mode: str, *, after_nginx_reload: bool = False) -> None:
    # One shared ten-second transition window for the newly allowed routes.
    # Existing routes, stage mode and direct checks keep their exact guards.
    deadline = time.monotonic() + 10 if mode == "writer" and after_nginx_reload else None
    http_gate("/api/health/ready", 200, "HTTPS_READINESS_FAILED")
    http_gate("/api/auth/user", 401, "ANONYMOUS_AUTH_GATE_FAILED")
    required = 401 if mode == "writer" else 404
    http_gate("/api/mkt/admin/vendor-invoices/1/match", required,
              "ANONYMOUS_WRITER_GATE_FAILED", "POST", ingress_deadline=deadline)
    http_gate("/api/mkt/admin/ap-preparations/1/accounting-handoff", required,
              "ANONYMOUS_HANDOFF_GATE_FAILED", "POST", ingress_deadline=deadline)
    http_gate("/api/sales/customer-invoices/auto-match-preview?company_id=1", required,
              "ANONYMOUS_CUSTOMER_AR_GATE_FAILED", ingress_deadline=deadline)
    http_gate("/api/mkt/admin/vendor-invoices/1/settle", 404, "UNRELATED_API_GATE_FAILED", "POST")
    http_gate("/api/sales/documents/1/action", 404, "CUSTOMER_ISSUANCE_NOT_ALLOWLISTED", "POST")


def check_artifact(expected_sha: str) -> None:
    require(re.fullmatch(r"[0-9a-f]{40}", expected_sha) is not None, "FULL_COMMIT_SHA_REQUIRED")
    require(TARGET.is_dir() and not TARGET.is_symlink(), "TARGET_DIRECTORY_INVALID")
    require((TARGET / "source-commit.txt").read_text().strip() == expected_sha, "SOURCE_SHA_MISMATCH")
    if TARGET != DEFAULT_TARGET:
        metadata = json.loads((TARGET / "release-metadata.json").read_text())
        require(metadata.get("source_commit") == expected_sha
                and metadata.get("artifact_target") == str(TARGET), "RELEASE_TARGET_METADATA_MISMATCH")
    manifest = TARGET / "RELEASE_SHA256SUMS.txt"
    require(manifest.is_file(), "ARTIFACT_CHECKSUMS_MISSING")
    checked: set[str] = set()
    for line in manifest.read_text().splitlines():
        if not line.strip():
            continue
        match = re.fullmatch(r"([0-9a-f]{64}) [ *](.+)", line)
        require(match is not None, "ARTIFACT_MANIFEST_INVALID")
        expected, name = match.groups()
        rel = Path(name)
        require(not rel.is_absolute() and ".." not in rel.parts, "ARTIFACT_PATH_INVALID")
        path = TARGET / rel
        require(path.resolve().is_relative_to(TARGET.resolve()), "ARTIFACT_SYMLINK_ESCAPE")
        require(digest(path) == expected, "ARTIFACT_CHECKSUM_MISMATCH")
        checked.add(str(rel))
    require({"dist/index.mjs", "dist/public/index.html"} <= checked, "ARTIFACT_BUNDLE_NOT_CHECKSUMMED")


def current_baseline(expected_sha: str) -> None:
    require(property_of(UNIT, "ActiveState") == "active", "PREVIEW_NOT_ACTIVE")
    require(property_of(UNIT, "User") == "bizpr81preview", "PREVIEW_USER_CHANGED")
    current = Path(property_of(UNIT, "WorkingDirectory"))
    require(current == BASE or current == TARGET, "PREVIEW_SOURCE_CHANGED")
    require((BASE / "source-commit.txt").read_text().strip() == BASE_SHA, "BASE_SOURCE_CHANGED")
    require(digest(BASE / "dist/index.mjs") == BASE_BUNDLE, "BASE_BUNDLE_CHANGED")
    require(digest(Path("/etc/systemd/system") / UNIT) == BASE_UNIT, "BASE_UNIT_CHANGED")
    require(digest(DROP.parent / "99-finance-ui-e177.conf") == BASE_DROP, "BASE_DROPIN_CHANGED")
    if current == TARGET:
        require((TARGET / "source-commit.txt").read_text().strip() == expected_sha, "ACTIVE_CANDIDATE_CHANGED")
        require(DROP.exists() and DROP.read_text() in [drop_content("stage"), drop_content("writer")], "CANDIDATE_DROPIN_CHANGED")
    else:
        # This is an UPGRADE from already active 7aaf Writer, not from the
        # old e177 read-only preview. No unapproved live-drift overwrite.
        require(DROP.exists() and digest(DROP) == ACTIVE_WRITER_DROP,
                "PREVIOUS_ACTIVE_WRITER_DROP_CHANGED")
        require(digest(NGINX) == ACTIVE_WRITER_NGINX,
                "PREVIOUS_ACTIVE_WRITER_NGINX_CHANGED")
        for key in ("BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV",
                    "BIZPORTAL_MARKETPLACE_ACCOUNTING_HANDOFF_ENABLED_DEV",
                    "BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV",
                    "BIZPORTAL_MARKETPLACE_FINANCE_SINGLE_GCP_SECRET_DEV",
                    "BIZPORTAL_FINANCE_NOTIFICATIONS_SUPPRESSED_DEV"):
            require(flags.get(key) == "true", "PREVIOUS_ACTIVE_WRITER_FLAG_CHANGED_" + key)
    flags = public_flags()
    for key, expected in {
        "APP_ENV": "development", "HOST": "127.0.0.1", "PORT": "19881",
        "BIZPORTAL_SIGNED_PASSWORD_ENABLED_DEV": "true", "BIZPORTAL_SIGNED_OTP_ENABLED_DEV": "false",
        "FLEET_EMBEDDED_REMINDER_ENABLED": "false", "DEV_RECONCILIATION_SCHEDULERS_ENABLED": "false",
        "GMAIL_INVOICE_SCHEDULER_ENABLED": "false", "WA_ENABLED": "false",
    }.items():
        require(flags.get(key) == expected, "EXISTING_RUNTIME_FLAG_CHANGED_" + key)


def restore(directory: Path, *, verify_current: bool) -> None:
    require(directory.resolve().parent == STATE_ROOT.resolve(), "ROLLBACK_PATH_INVALID")
    metadata = json.loads((directory / "state.json").read_text())
    if verify_current:
        require(DROP.exists() and digest(DROP) == metadata["new_drop_sha"], "ROLLBACK_DROPIN_CHANGED")
        require(digest(NGINX) == metadata["new_nginx_sha"], "ROLLBACK_NGINX_CHANGED")
    if metadata["old_drop_exists"]:
        atomic_write(DROP, (directory / "previous-dropin.conf").read_bytes(), 0o644)
    else:
        DROP.unlink(missing_ok=True)
    atomic_write(NGINX, (directory / "previous-nginx.conf").read_bytes(), 0o644)
    command("nginx", "-t")
    command("systemctl", "daemon-reload")
    command("systemctl", "restart", UNIT)
    ready()
    command("systemctl", "reload", "nginx")
    require(property_of(UNIT, "WorkingDirectory") == metadata["old_directory"], "ROLLBACK_SOURCE_MISMATCH")
    print("PRIVATE_FINANCE_PREVIEW_ROLLBACK_PASS")


def apply(mode: str, expected_sha: str) -> None:
    release_target(TARGET, expected_sha)
    check_artifact(expected_sha)
    current_baseline(expected_sha)
    if mode == "writer":
        validate_storage()
    old_nginx = NGINX.read_bytes()
    new_nginx = nginx_content(old_nginx.decode(), mode).encode()
    new_drop = drop_content(mode).encode()
    legacy_pid = property_of(LEGACY_UNIT, "MainPID")
    legacy_hash = digest(LEGACY_NGINX)
    require(property_of(LEGACY_UNIT, "ActiveState") == "active", "LEGACY_DEV_NOT_ACTIVE")
    STATE_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    directory = STATE_ROOT / (stamp + "-" + mode + "-" + expected_sha[:12])
    directory.mkdir(mode=0o700)
    metadata = {
        "source": expected_sha, "mode": mode, "target": str(TARGET),
        "old_directory": property_of(UNIT, "WorkingDirectory"),
        "old_drop_exists": DROP.exists(), "new_drop_sha": sha_bytes(new_drop),
        "new_nginx_sha": sha_bytes(new_nginx), "legacy_nginx_sha": legacy_hash,
    }
    atomic_write(directory / "previous-nginx.conf", old_nginx, 0o600)
    if DROP.exists():
        atomic_write(directory / "previous-dropin.conf", DROP.read_bytes(), 0o600)
    atomic_write(directory / "state.json", (json.dumps(metadata) + "\n").encode(), 0o600)
    try:
        atomic_write(DROP, new_drop, 0o644)
        atomic_write(NGINX, new_nginx, 0o644)
        command("nginx", "-t")
        command("systemctl", "daemon-reload")
        command("systemctl", "restart", UNIT)
        ready()
        command("systemctl", "reload", "nginx")
        check_http_gates(mode, after_nginx_reload=True)
        require(property_of(LEGACY_UNIT, "MainPID") == legacy_pid and digest(LEGACY_NGINX) == legacy_hash, "LEGACY_DEV_CHANGED")
        require(property_of(UNIT, "WorkingDirectory") == str(TARGET), "DEPLOYED_SOURCE_MISMATCH")
    except BaseException:
        print("DEPLOYMENT_FAILED_RESTORING_PRIVATE_PREVIEW", file=sys.stderr)
        restore(directory, verify_current=False)
        raise
    print("PRIVATE_FINANCE_PREVIEW_DEPLOY_PASS mode=" + mode + " commit=" + expected_sha)
    print("ROLLBACK_STATE=" + str(directory))
    print("SIGNED_BUSINESS_E2E_STILL_REQUIRES_SEPARATE_RESULT")


def main() -> None:
    global TARGET
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["render", "apply", "rollback"])
    parser.add_argument("--mode", choices=["stage", "writer"], default="stage")
    parser.add_argument("--expected-commit", default="")
    parser.add_argument("--target", type=Path,
                        help="Fixed target or /opt/bizportal-invoice-completion-20261117-<first12SHA>; requires full --expected-commit")
    parser.add_argument("--state-dir", type=Path)
    args = parser.parse_args()
    require(args.mode == "writer", "PR132_ONLY_WRITER_TO_WRITER_UPGRADE")
    if args.target is not None:
        require(args.action != "rollback", "ROLLBACK_USES_RECORDED_TARGET")
        TARGET = release_target(args.target, args.expected_commit)
    if args.action == "render":
        print(drop_content(args.mode))
        if args.mode == "writer":
            print(nginx_block())
        return
    require(os.geteuid() == 0, "ROOT_EXECUTOR_REQUIRED")
    with LOCK.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == "rollback":
            require(args.state_dir is not None, "ROLLBACK_STATE_REQUIRED")
            restore(args.state_dir, verify_current=True)
        else:
            apply(args.mode, args.expected_commit)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        # Exception strings are intentionally restricted to stable internal codes.
        print("INVOICE_PREVIEW_DEPLOY_FAILED=" + (str(error) if isinstance(error, RuntimeError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
