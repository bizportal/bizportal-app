#!/usr/bin/env python3
"""Exact c2 -> reviewed customer-invoice UI upgrade of the private DEV preview.

The API bundle must remain byte-identical. Only the two release paths in the
existing writer drop-in may change. Nginx, credentials, auth/account settings,
Finance flags, GCP bootstrap and public DEV are never written. Pin the separately
reviewed UI source commit below; do not pin the commit containing that pin itself.
"""
from __future__ import annotations

import argparse
import datetime as dt
from email.utils import parsedate_to_datetime
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

UNIT = "cst-bizportal-pr81-preview.service"
LEGACY_UNIT = "cst-bizportal-gmail-dev.service"
BASE_SHA = "c2d092e18a272a8c2606daaf76a01ec56c77b8c8"
BASE = Path("/opt/bizportal-invoice-completion-20261117-c2d092e18a27")
API_SHA = "d5653af4d78576389b694160d1ea5b8779d3e06d7560f73839c5aacf27cd4086"
LOCKFILE_SHA = "99e53f194a7e6bf7bf7a107d139e26cccfceebe96e648f989729e6861ee7cce0"
# UI-only PR133: 28 focused tests, TypeScript and both build modes passed.
PINNED_UI_COMMIT = "480256350783dfbdc44ee784c6365124f674a63c"
TARGET_PREFIX = "/opt/bizportal-customer-invoice-ui-20261117-"
FRONTEND_INPUT = Path("/opt/bizportal-invoice-completion-20261117-480256350783")
BASE_MANIFEST_SHA = "712127b2cbacdf93cb1dd7d19244d6d2df598b70497c1c1bb5a7efdc4ffb4730"
FRONTEND_MANIFEST_SHA = "b6291bc04a45e2728fc06d8f5bcf9d85eb87fdbbea16ac365644c2adc5e01b67"
FRONTEND_INDEX_SHA = "b1343a07b177ff999cdf39be2ae110fc81b5fb44eccc20ef107669cc0d089634"
FRONTEND_BUILT_API_SHA = "65c43c039f1cbe48a69ad6a58600cf7e79fc760749d189bd8b1bd6e3e58a86ae"
BUILDER = Path(__file__).with_name("build-invoice-finance-preview-dev.py")
BUILDER_SHA = "628ea1aa3d4ca79bd049e03e14f3f4d1a4cdc2d5cfcd0fdfd4964214fc2b68e5"
PACKAGING_MODE = "frontend-only-preserve-c2-runtime"
RELEASE_FILES = {"source-commit.txt", "release-metadata.json", "RELEASE_SHA256SUMS.txt", "RELEASE_SYMLINKS.json"}
NODE = "/opt/actions-runner/_work/_tool/node/22.23.3/x64/bin/node"
ORIGIN = "https://finance-pr81.72.61.210.205.sslip.io"
UNIT_FILE = Path("/etc/systemd/system") / UNIT
DROP = Path(str(UNIT_FILE) + ".d/zz-invoice-completion-dev.conf")
PAYROLL_DROP = DROP.parent / "65-payroll-smtp-dev.conf"
ORIGINAL_DROP = DROP.parent / "99-finance-ui-e177.conf"
NGINX = Path("/etc/nginx/sites-available/finance-pr81.72.61.210.205.sslip.io")
NGINX_ENABLED = Path("/etc/nginx/sites-enabled/finance-pr81.72.61.210.205.sslip.io")
LEGACY_NGINX = Path("/etc/nginx/sites-available/bizportal-dev.cstlogistic.co.id")
LEGACY_BUNDLE = Path("/opt/cst-bizportal-gmail-dev-otp-identity-release-20261116/dist/index.mjs")
LEGACY_DIRECTORY = "/opt/cst-bizportal-gmail-dev"
LEGACY_UNIT_FILE = Path("/etc/systemd/system") / LEGACY_UNIT
LEGACY_DROP = Path(str(LEGACY_UNIT_FILE) + ".d/90-otp-identity-release-20261116.conf")
LEGACY_PID = "219384"
LEGACY_API_SHA = "5a44548265dfaa04954d884820158c5be698e1fc51f7413617efb75e2ba8ed1d"
BASE_DROP_SHA = "00a451ab46e08a712e95825ef18da34c00cd8cfcf7904e30c7946c20eb8b4568"
NGINX_SHA = "228d3fb6b12fdd48c637dff22a79787a1e655872ed0934ce656011f488491764"
LEGACY_NGINX_SHA = "c9c8e9c72d02987ace325a072504b9087be7219e3b9c0a6df6a6af403d25553c"
BASE_RECEIPT = Path("/var/lib/bizportal-invoice-preview-rollbacks/20261117T154226156505Z-writer-c2d092e18a27/state.json")
BASE_RECEIPT_SHA = "1d1dc5042f940e079ec9242c3e25be4ad0f161588ad4533e77ce7cf0d476f5af"
STATE_ROOT = Path("/var/lib/bizportal-invoice-preview-rollbacks")
LOCK = Path("/run/lock/cst-pr81-preview-only-rollout.lock")
ENVFILES = (
    Path("/etc/cst-bizportal-pr81-preview/auth-preview.env"),
    Path("/etc/bizportal-pr81-preview/payroll-smtp-dev.env"),
    Path("/etc/bizportal-finance-dev/vendor-storage-dev.env"),
)
BOOTSTRAP = Path("/etc/bizportal-finance-dev/secret-reader.json")
CREDENTIAL_DIRECTORY = Path("/run/credentials") / UNIT
LOADED_BOOTSTRAP = CREDENTIAL_DIRECTORY / "gcp-secret-manager-bootstrap.json"
STATIC_FILES = {
    UNIT_FILE: "0b08c4dff3bd1b07df97cfddd7d56dad043598fc22cbb8dbd7b7084ce9396bf3",
    ORIGINAL_DROP: "a8e1a9658990c8d9065f8f902336802a59bb4de044cce0d08e6c676b54d1665e",
    PAYROLL_DROP: "6f5cf1ec9c0db10343c366f2e789605efcaece71077cad97b568324940325cbe",
    NGINX: NGINX_SHA, LEGACY_NGINX: LEGACY_NGINX_SHA,
}
FRONTEND_FLAGS = {"dev_password_only": True, "otp_only_preview": False,
                  "finance_global_scope": True, "finance_readonly_preview": False}
RUNTIME_FLAGS = {
    "APP_ENV": "development", "NODE_ENV": "production", "HOST": "127.0.0.1", "PORT": "19881",
    "BIZPORTAL_SIGNED_PASSWORD_ENABLED_DEV": "true", "BIZPORTAL_SIGNED_OTP_ENABLED_DEV": "false",
    "BIZPORTAL_FINANCE_GLOBAL_SCOPE_ENABLED_DEV": "true",
    "BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV": "true",
    "BIZPORTAL_MARKETPLACE_FINANCE_READONLY_ENABLED_DEV": "true",
    "BIZPORTAL_MARKETPLACE_VENDOR_INVOICE_ENABLED_DEV": "true",
    "BIZPORTAL_MARKETPLACE_VENDOR_PARENT_LOCK_ENABLED_DEV": "true",
    "BIZPORTAL_MARKETPLACE_ACCOUNTING_HANDOFF_ENABLED_DEV": "true",
    "BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV": "true",
    "BIZPORTAL_MARKETPLACE_FINANCE_SINGLE_GCP_SECRET_DEV": "true",
    "BIZPORTAL_MARKETPLACE_FINANCE_PINNED_IPV4_SESSION_POOLER_DEV": "true",
    "BIZPORTAL_DEV_SYSTEMD_GCP_BOOTSTRAP_ENABLED": "true",
    "BIZPORTAL_CUSTOMER_AR_PREVIEW_ENABLED_DEV": "true",
    "BIZPORTAL_FINANCE_NOTIFICATIONS_SUPPRESSED_DEV": "true",
    "BIZPORTAL_MARKETPLACE_FINANCE_GCP_SECRET_NAME_DEV": "",
    "BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV": "",
    "FLEET_EMBEDDED_REMINDER_ENABLED": "false", "DEV_RECONCILIATION_SCHEDULERS_ENABLED": "false",
    "GMAIL_INVOICE_SCHEDULER_ENABLED": "false", "WA_ENABLED": "false", "ALLOW_DEV_STORAGE_WRITES": "true",
    "CREDENTIALS_DIRECTORY": str(CREDENTIAL_DIRECTORY),
}


def require(ok: bool, code: str) -> None:
    if not ok:
        raise RuntimeError(code)


def sha_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def digest(path: Path) -> str:
    return sha_bytes(path.read_bytes())


def regular_file(path: Path) -> None:
    require(path.is_file() and not path.is_symlink(), "REGULAR_FILE_REQUIRED")
    info = path.stat()
    require(info.st_uid == 0 and not (info.st_mode & 0o022), "ROOT_OWNED_NONWRITABLE_FILE_REQUIRED")


def root_directory(path: Path, *, private: bool = False) -> None:
    require(path.is_dir() and not path.is_symlink(), "REGULAR_DIRECTORY_REQUIRED")
    info = path.stat()
    require(info.st_uid == 0 and not (info.st_mode & (0o077 if private else 0o022)),
            "ROOT_OWNED_DIRECTORY_REQUIRED")


def command(*argv: str) -> str:
    result = subprocess.run(argv, capture_output=True, text=True, timeout=60)
    require(result.returncode == 0, "COMMAND_FAILED_" + Path(argv[0]).name)
    return result.stdout.strip()


def property_of(unit: str, name: str) -> str:
    return command("systemctl", "show", unit, "--property=" + name, "--value")


def release_target(target: Path, commit: str) -> Path:
    require(re.fullmatch(r"[0-9a-f]{40}", PINNED_UI_COMMIT) is not None, "UI_SOURCE_NOT_PINNED")
    require(commit == PINNED_UI_COMMIT and commit != BASE_SHA, "EXACT_REVIEWED_UI_COMMIT_REQUIRED")
    require(target == Path(TARGET_PREFIX + commit[:12]), "TARGET_SOURCE_SUFFIX_MISMATCH")
    require(not target.is_symlink() and target.parent.resolve() == target.parent, "TARGET_SYMLINK_NOT_ALLOWED")
    return target


def candidate_drop(original: bytes, target: Path) -> bytes:
    require(sha_bytes(original) == BASE_DROP_SHA, "C2_WRITER_DROP_CHANGED")
    previous = [f"WorkingDirectory={BASE}\n",
                f"ExecStart={NODE} --max-http-header-size=65536 {BASE}/dist/index.mjs\n"]
    result = original
    for line in previous:
        require(result.count(line.encode()) == 1, "C2_RELEASE_PATH_NOT_EXACT")
        result = result.replace(line.encode(), line.replace(str(BASE), str(target)).encode(), 1)
    require(result.count(str(BASE).encode()) == 0, "UNEXPECTED_BASE_PATH_IN_DROP")
    return result


def common_metadata(target: Path, commit: str) -> dict[str, object]:
    return {
        "source_origin": "https://github.com/bizportal/bizportal-app.git",
        "source_commit": commit, "artifact_target": str(target), "lockfile_sha256": LOCKFILE_SHA,
        "node": "v22.23.3", "pnpm": "10.33.0", "platform": "linux-x64",
        "frontend_flags": FRONTEND_FLAGS, "runtime_envfiles_loaded": False, "activation_performed": False,
    }


def composition_identity() -> dict[str, object]:
    return {
        "packaging_mode": PACKAGING_MODE, "api_source": BASE_SHA, "frontend_source": PINNED_UI_COMMIT,
        "api_bundle_sha256": API_SHA, "api_input_artifact": str(BASE), "frontend_input_artifact": str(FRONTEND_INPUT),
        "api_input_manifest_sha256": BASE_MANIFEST_SHA, "frontend_input_manifest_sha256": FRONTEND_MANIFEST_SHA,
        "frontend_input_index_sha256": FRONTEND_INDEX_SHA,
    }


def verify_artifact(target: Path, commit: str, *, declared_target: Path | None = None,
                    pinned_manifest: str | None = None, composed: bool = False) -> dict[str, tuple]:
    root_directory(target)
    for name in ("source-commit.txt", "release-metadata.json", "RELEASE_SHA256SUMS.txt"):
        regular_file(target / name)
    require((target / "source-commit.txt").read_text().strip() == commit, "ARTIFACT_SOURCE_MISMATCH")
    metadata = json.loads((target / "release-metadata.json").read_text())
    expected = common_metadata(declared_target or target, commit)
    if composed:
        expected.update(composition_identity())
    require(all(metadata.get(key) == value for key, value in expected.items()), "ARTIFACT_METADATA_CHANGED")
    if pinned_manifest is not None:
        require(digest(target / "RELEASE_SHA256SUMS.txt") == pinned_manifest, "INPUT_MANIFEST_PIN_CHANGED")
    checked: set[str] = set()
    inventory = {}
    for line in (target / "RELEASE_SHA256SUMS.txt").read_text().splitlines():
        match = re.fullmatch(r"([0-9a-f]{64}) [ *](.+)", line)
        require(match is not None, "ARTIFACT_MANIFEST_INVALID")
        expected_digest, name = match.groups()
        relative = Path(name)
        require(not relative.is_absolute() and ".." not in relative.parts and name not in checked
                and relative.as_posix() == name,
                "ARTIFACT_MANIFEST_PATH_INVALID")
        path = target / relative
        require(path.resolve().is_relative_to(target.resolve()), "ARTIFACT_SYMLINK_ESCAPE")
        regular_file(path)
        require(digest(path) == expected_digest, "ARTIFACT_CHECKSUM_MISMATCH")
        checked.add(name)
        inventory[name] = ("file", expected_digest, stat.S_IMODE(path.stat().st_mode))
    files, links = set(), {}
    for directory, directories, names in os.walk(target, followlinks=False):
        for name in directories + names:
            path = Path(directory) / name
            relative = path.relative_to(target).as_posix()
            if path.is_symlink():
                link = os.readlink(path)
                require(not Path(link).is_absolute() and path.exists()
                        and path.resolve().is_relative_to(target.resolve()), "ARTIFACT_SYMLINK_ESCAPE")
                links[relative] = link
                inventory[relative] = ("link", link)
            elif path.is_file():
                files.add(relative)
            else:
                root_directory(path)
                inventory[relative] = ("directory", stat.S_IMODE(path.stat().st_mode))
    require(files == checked | {"RELEASE_SHA256SUMS.txt"}, "ARTIFACT_UNCHECKSUMMED_FILE")
    require({"dist/index.mjs", "dist/public/index.html", "release-metadata.json", "source-commit.txt",
             "RELEASE_SYMLINKS.json"} <= checked, "ARTIFACT_REQUIRED_FILE_MISSING")
    require(json.loads((target / "RELEASE_SYMLINKS.json").read_text()) == links, "ARTIFACT_LINKS_CHANGED")
    public = target / "dist/public"
    require(public.is_dir() and not public.is_symlink(), "FRONTEND_DIRECTORY_INVALID")
    for name in links:
        if name.startswith("dist/public/"):
            require((target / name).resolve().is_relative_to(public.resolve()), "FRONTEND_SYMLINK_ESCAPE")
    return inventory


def verified_inputs() -> tuple[dict[str, tuple], dict[str, tuple]]:
    backend = verify_artifact(BASE, BASE_SHA, pinned_manifest=BASE_MANIFEST_SHA)
    frontend = verify_artifact(FRONTEND_INPUT, PINNED_UI_COMMIT, pinned_manifest=FRONTEND_MANIFEST_SHA)
    require(digest(BASE / "dist/index.mjs") == API_SHA, "C2_API_CHANGED")
    require(digest(FRONTEND_INPUT / "dist/index.mjs") == FRONTEND_BUILT_API_SHA, "FRONTEND_INPUT_BUILD_CHANGED")
    require(digest(FRONTEND_INPUT / "dist/public/index.html") == FRONTEND_INDEX_SHA, "FRONTEND_INPUT_INDEX_CHANGED")
    return backend, frontend


def selected_inventory(inventory: dict[str, tuple], *, public: bool) -> dict[str, tuple]:
    return {name: value for name, value in inventory.items() if name not in RELEASE_FILES
            and (name == "dist/public" or name.startswith("dist/public/")) == public}


def verify_composition(artifact: Path, target: Path, commit: str,
                       inputs: tuple[dict[str, tuple], dict[str, tuple]]) -> None:
    output = verify_artifact(artifact, commit, declared_target=target, composed=True)
    require(digest(artifact / "dist/index.mjs") == API_SHA, "UI_ONLY_API_BYTE_IDENTITY_REQUIRED")
    require(selected_inventory(output, public=False) == selected_inventory(inputs[0], public=False),
            "PRESERVED_RUNTIME_FILES_CHANGED")
    require(selected_inventory(output, public=True) == selected_inventory(inputs[1], public=True),
            "FRONTEND_FILES_DO_NOT_MATCH_REVIEWED_BUILD")


def check_artifact(target: Path, commit: str) -> None:
    release_target(target, commit)
    verify_composition(target, target, commit, verified_inputs())


def builder_helpers():
    # Absolute, hash-pinned, standard-library-only helper; importing does not run
    # its CLI/build, read envfiles or activate any service.
    regular_file(BUILDER)
    require(digest(BUILDER) == BUILDER_SHA, "REVIEWED_BUILD_HELPER_CHANGED")
    spec = importlib.util.spec_from_file_location("reviewed_invoice_artifact_helpers", BUILDER)
    require(spec is not None and spec.loader is not None, "BUILD_HELPER_IMPORT_FAILED")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def compose(target: Path, commit: str) -> None:
    release_target(target, commit)
    require(not target.exists(), "TARGET_ALREADY_EXISTS")
    inputs = verified_inputs()
    helpers = builder_helpers()
    with tempfile.TemporaryDirectory(prefix=".bizportal-customer-ui-compose-", dir=target.parent) as temporary:
        artifact = Path(temporary) / "artifact"
        # Copy, never hardlink, so packaging and chmod cannot change either input.
        shutil.copytree(BASE, artifact, symlinks=True)
        shutil.rmtree(artifact / "dist/public")
        shutil.copytree(FRONTEND_INPUT / "dist/public", artifact / "dist/public", symlinks=True)
        metadata = {**common_metadata(target, commit), **composition_identity(),
                    "composition_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
                    "api_build_utc": json.loads((BASE / "release-metadata.json").read_text()).get("build_utc"),
                    "frontend_build_utc": json.loads((FRONTEND_INPUT / "release-metadata.json").read_text()).get("build_utc")}
        helpers.manifest(artifact, metadata)
        verify_composition(artifact, target, commit, inputs)
        require(verified_inputs() == inputs, "INPUT_ARTIFACT_CHANGED_DURING_COMPOSE")
        # Existing RENAME_NOREPLACE publication refuses races/collisions.
        helpers.publish(artifact, target)
    print("CUSTOMER_INVOICE_UI_COMPOSED_NOT_ACTIVE source=" + commit + " api_byte_identity=true")
    print("COMPOSED_ARTIFACT=" + str(target))


def static_guard() -> None:
    require((BASE / "source-commit.txt").read_text().strip() == BASE_SHA, "C2_SOURCE_CHANGED")
    require(digest(BASE / "dist/index.mjs") == API_SHA, "C2_API_CHANGED")
    regular_file(BASE_RECEIPT)
    require(digest(BASE_RECEIPT) == BASE_RECEIPT_SHA, "C2_DEPLOYMENT_RECEIPT_CHANGED")
    receipt = json.loads(BASE_RECEIPT.read_text())
    require(receipt.get("source") == BASE_SHA and receipt.get("target") == str(BASE)
            and receipt.get("mode") == "writer" and receipt.get("new_drop_sha") == BASE_DROP_SHA
            and receipt.get("new_nginx_sha") == NGINX_SHA, "C2_RECEIPT_IDENTITY_CHANGED")
    for path, expected in STATIC_FILES.items():
        regular_file(path)
        require(digest(path) == expected, "PINNED_CONFIGURATION_CHANGED")
    require(NGINX_ENABLED.is_symlink() and NGINX_ENABLED.resolve() == NGINX, "PRIVATE_NGINX_LINK_CHANGED")
    require(property_of(LEGACY_UNIT, "ActiveState") == "active"
            and property_of(LEGACY_UNIT, "MainPID") == LEGACY_PID
            and property_of(LEGACY_UNIT, "WorkingDirectory") == LEGACY_DIRECTORY
            and digest(LEGACY_BUNDLE) == LEGACY_API_SHA, "PUBLIC_LEGACY_FINGERPRINT_CHANGED")


def stable_environment(environment: dict[str, str], directory: Path) -> dict[str, str]:
    # No values, hashes of credentials, or auth-file content leave process memory.
    stable = {key: value for key, value in environment.items()
              if key not in {"INVOCATION_ID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID"}}
    if stable.get("PWD") == str(directory):
        stable["PWD"] = "<REVIEWED_RELEASE_DIRECTORY>"
    return stable


def runtime_environment(directory: Path) -> dict[str, str]:
    require(property_of(UNIT, "ActiveState") == "active", "PRIVATE_PREVIEW_NOT_ACTIVE")
    require(property_of(UNIT, "WorkingDirectory") == str(directory), "PRIVATE_RELEASE_CHANGED")
    require(property_of(UNIT, "User") == property_of(UNIT, "Group") == "bizpr81preview", "PRIVATE_USER_CHANGED")
    require(property_of(UNIT, "DropInPaths").split() == [str(PAYROLL_DROP), str(ORIGINAL_DROP), str(DROP)],
            "PRIVATE_DROPIN_SET_CHANGED")
    require(property_of(UNIT, "EnvironmentFiles").splitlines()
            == [str(path) + " (ignore_errors=no)" for path in ENVFILES], "ENVFILE_REFERENCES_CHANGED")
    pid = int(property_of(UNIT, "MainPID"))
    require(pid > 0, "PRIVATE_PID_MISSING")
    argv = Path(f"/proc/{pid}/cmdline").read_bytes().rstrip(b"\0").split(b"\0")
    require(argv == [NODE.encode(), b"--max-http-header-size=65536", str(directory / "dist/index.mjs").encode()],
            "PRIVATE_EXECUTABLE_CHANGED")
    raw = Path(f"/proc/{pid}/environ").read_bytes().decode()
    environment = dict(item.split("=", 1) for item in raw.split("\0") if "=" in item)
    require(all(environment.get(key) == value for key, value in RUNTIME_FLAGS.items()), "PRIVATE_RUNTIME_FLAGS_CHANGED")
    require(all(environment.get(key, "").strip() for key in
                ("BIZPORTAL_SIGNED_PASSWORD_ACCOUNT_ID_DEV", "BIZPORTAL_SIGNED_PASSWORD_ACCOUNT_EMAIL_DEV")),
            "EXISTING_PINNED_ACCOUNT_REQUIRED")
    require(any(len(environment.get(key, "").strip()) >= 32
                for key in ("BIZPORTAL_SESSION_SECRET", "SESSION_SECRET")), "EXPLICIT_SIGNING_SECRET_REQUIRED")
    require(property_of(UNIT, "MainPID") == str(pid), "PRIVATE_PROCESS_CHANGED_DURING_CHECK")
    return stable_environment(environment, directory)


def protected_files(*, require_active_mount: bool = True) -> dict[Path, tuple[int, int, int, bytes]]:
    paths = [*STATIC_FILES, *ENVFILES, BOOTSTRAP, LEGACY_UNIT_FILE, LEGACY_DROP]
    result = {}
    for path in paths:
        regular_file(path)
        info = path.stat()
        result[path] = (stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid, path.read_bytes())
    if require_active_mount:
        require(LOADED_BOOTSTRAP.is_file() and LOADED_BOOTSTRAP.read_bytes() == result[BOOTSTRAP][3],
                "ACTIVE_GCP_BOOTSTRAP_SOURCE_CHANGED")
    require(not (ENVFILES[-1].stat().st_mode & 0o077), "STORAGE_ENV_MUST_BE_PRIVATE")
    return result


def current_baseline() -> dict[str, object]:
    require(property_of(UNIT, "WorkingDirectory") == str(BASE), "PREVIEW_SOURCE_CHANGED")
    static_guard()
    regular_file(DROP)
    require(digest(DROP) == BASE_DROP_SHA, "C2_WRITER_DROP_CHANGED")
    return {"environment": runtime_environment(BASE), "files": protected_files()}


def verify_snapshot(snapshot: dict[str, object], directory: Path) -> None:
    static_guard()
    require(protected_files() == snapshot["files"], "PROTECTED_CONFIGURATION_CHANGED")
    require(runtime_environment(directory) == snapshot["environment"], "AUTH_OR_EFFECTIVE_ENVIRONMENT_CHANGED")


def atomic_write(path: Path, data: bytes, mode: int) -> None:
    temporary = path.with_name(path.name + ".invoice-ui-tmp-" + str(os.getpid()))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def throttle_delay(retry_after: str) -> float:
    delay = 6.2
    try:
        if re.fullmatch(r"[0-9]+", retry_after.strip()):
            delay = float(retry_after)
        elif retry_after:
            delay = parsedate_to_datetime(retry_after).timestamp() - time.time()
    except (ValueError, OverflowError, TypeError):
        pass
    return min(30.0, max(6.2, delay))


def status(url: str, method: str = "GET") -> int:
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
            time.sleep(throttle_delay(retry_after))
        except (OSError, TimeoutError):
            return 0
    return 429


def check_frontend(target: Path) -> None:
    expected = (target / "dist/public/index.html").read_bytes()
    require(0 < len(expected) <= 2 * 1024 * 1024, "FRONTEND_INDEX_SIZE_INVALID")
    url = ORIGIN + "/sales/invoices"
    for attempt in range(3):
        request = urllib.request.Request(url, headers={"Accept-Encoding": "identity", "Cache-Control": "no-cache"})
        try:
            with urllib.request.urlopen(request, timeout=8) as response:
                require(response.status == 200 and response.geturl() == url, "FRONTEND_HTTP_IDENTITY_FAILED")
                actual = response.read(len(expected) + 1)
            require(sha_bytes(actual) == sha_bytes(expected), "FRONTEND_SERVED_BYTES_MISMATCH")
            return
        except urllib.error.HTTPError as error:
            code = error.code
            retry_after = error.headers.get("Retry-After", "") if error.headers else ""
            error.close()
            if code != 429 or attempt == 2:
                raise RuntimeError("FRONTEND_HTTP_EXPECTED_200_OBSERVED_" + str(code)) from None
            time.sleep(throttle_delay(retry_after))
        except (OSError, TimeoutError):
            raise RuntimeError("FRONTEND_TRANSPORT_FAILED") from None


def ready() -> None:
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        if status("http://127.0.0.1:19881/api/health/ready") == 200:
            return
        time.sleep(0.5)
    raise RuntimeError("PRIVATE_PREVIEW_NOT_READY")


def check_http_gates() -> None:
    # No cookies, credentials, login attempts or business data. Nginx is unchanged,
    # so 404 is never treated as a reload transition and never accepted for 401.
    for path, method, expected, code in (
        ("/api/health/ready", "GET", 200, "HTTPS_READY"),
        ("/api/auth/user", "GET", 401, "ANONYMOUS_AUTH"),
        ("/api/mkt/admin/finance-company-selection", "POST", 401, "ANONYMOUS_SCOPE"),
        ("/api/sales/customer-invoices/auto-match-preview?company_id=1", "GET", 401, "ANONYMOUS_CUSTOMER_AR"),
        ("/api/mkt/admin/vendor-invoices/1/match", "POST", 401, "ANONYMOUS_VENDOR_WRITER"),
        ("/api/mkt/admin/ap-preparations/1/accounting-handoff", "POST", 401, "ANONYMOUS_HANDOFF"),
        ("/api/mkt/admin/vendor-invoices/1/settle", "POST", 404, "UNRELATED_API"),
        ("/api/sales/documents/1/action", "POST", 404, "CUSTOMER_ISSUANCE"),
    ):
        actual = status(ORIGIN + path, method)
        require(actual == expected, code + f"_EXPECTED_{expected}_OBSERVED_{actual}")


def restore(directory: Path, *, snapshot: dict[str, object] | None = None) -> None:
    require(not directory.is_symlink() and directory.resolve().parent == STATE_ROOT.resolve(), "ROLLBACK_PATH_INVALID")
    root_directory(STATE_ROOT, private=True)
    root_directory(directory, private=True)
    regular_file(directory / "state.json")
    regular_file(directory / "previous-dropin.conf")
    metadata = json.loads((directory / "state.json").read_text())
    target = release_target(Path(metadata["target"]), metadata["source"])
    require(metadata.get("kind") == "customer-invoice-ui-only" and metadata.get("old_source") == BASE_SHA
            and metadata.get("old_directory") == str(BASE) and metadata.get("api_sha") == API_SHA
            and metadata.get("unchanged_nginx_sha") == NGINX_SHA, "ROLLBACK_RECEIPT_MISMATCH")
    previous = (directory / "previous-dropin.conf").read_bytes()
    new_drop = candidate_drop(previous, target)
    require(metadata.get("new_drop_sha") == sha_bytes(new_drop), "ROLLBACK_CANDIDATE_MISMATCH")
    require(DROP.exists() and digest(DROP) == sha_bytes(new_drop), "ROLLBACK_DROPIN_CHANGED")
    static_guard()
    require(property_of(UNIT, "WorkingDirectory") in (str(BASE), str(target)), "ROLLBACK_RUNTIME_CHANGED")
    check_artifact(target, metadata["source"])
    # A failed candidate may have no systemd credential mount. Preserve and
    # compare its source files before rollback; the recovered active service
    # must again load the byte-identical credential in verify_snapshot below.
    files = protected_files(require_active_mount=property_of(UNIT, "ActiveState") == "active")
    if snapshot is not None:
        require(files == snapshot["files"], "ROLLBACK_PROTECTED_CONFIGURATION_CHANGED")
    else:
        # A manual rollback also preserves the current account/signing values.
        directory_now = Path(property_of(UNIT, "WorkingDirectory"))
        snapshot = {"files": files, "environment": runtime_environment(directory_now)}
    atomic_write(DROP, previous, 0o644)
    command("systemctl", "daemon-reload")
    command("systemctl", "restart", UNIT)
    ready()
    require(digest(DROP) == BASE_DROP_SHA, "ROLLBACK_C2_DROP_MISMATCH")
    verify_snapshot(snapshot, BASE)
    print("CUSTOMER_INVOICE_UI_ROLLBACK_TO_C2_PASS")


def apply(target: Path, commit: str) -> None:
    check_artifact(target, commit)
    snapshot = current_baseline()
    previous = DROP.read_bytes()
    new_drop = candidate_drop(previous, target)
    STATE_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    root_directory(STATE_ROOT, private=True)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    directory = STATE_ROOT / (stamp + "-customer-invoice-ui-" + commit[:12])
    directory.mkdir(mode=0o700)
    metadata = {"kind": "customer-invoice-ui-only", "source": commit, "target": str(target),
                "old_source": BASE_SHA, "old_directory": str(BASE), "api_sha": API_SHA,
                "new_drop_sha": sha_bytes(new_drop), "unchanged_nginx_sha": NGINX_SHA}
    # Only the public drop-in and nonsecret release identifiers are persisted.
    atomic_write(directory / "previous-dropin.conf", previous, 0o600)
    atomic_write(directory / "state.json", (json.dumps(metadata) + "\n").encode(), 0o600)
    verify_snapshot(snapshot, BASE)
    require(digest(DROP) == BASE_DROP_SHA, "C2_DROP_CHANGED_BEFORE_APPLY")
    atomic_write(DROP, new_drop, 0o644)
    try:
        command("systemctl", "daemon-reload")
        command("systemctl", "restart", UNIT)
        ready()
        require(digest(DROP) == sha_bytes(new_drop), "CANDIDATE_DROP_CHANGED")
        verify_snapshot(snapshot, target)
        check_http_gates()
        check_frontend(target)
        verify_snapshot(snapshot, target)
    except BaseException:
        print("UI_DEPLOYMENT_FAILED_GUARDED_ROLLBACK_TO_C2", file=sys.stderr)
        restore(directory, snapshot=snapshot)
        raise
    print("CUSTOMER_INVOICE_UI_DEPLOY_PASS source=" + commit + " api_byte_identity=true")
    print("ROLLBACK_STATE=" + str(directory))
    print("AUTH_CONFIGURATION_PRESERVED_NGINX_AND_PUBLIC_LEGACY_UNCHANGED")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["compose", "check", "apply", "rollback"])
    parser.add_argument("--expected-commit", default="")
    parser.add_argument("--target", type=Path)
    parser.add_argument("--state-dir", type=Path)
    args = parser.parse_args()
    require(os.geteuid() == 0, "ROOT_EXECUTOR_REQUIRED")
    with LOCK.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == "rollback":
            require(args.state_dir is not None and args.target is None and not args.expected_commit,
                    "ROLLBACK_USES_RECORDED_TARGET")
            restore(args.state_dir)
        else:
            require(args.target is not None and args.state_dir is None, "EXPLICIT_TARGET_REQUIRED")
            target = release_target(args.target, args.expected_commit)
            if args.action == "compose":
                compose(target, args.expected_commit)
            elif args.action == "check":
                check_artifact(target, args.expected_commit)
                current_baseline()
                print("CUSTOMER_INVOICE_UI_PREFLIGHT_PASS_NO_ACTIVATION")
            else:
                apply(target, args.expected_commit)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        code = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print("CUSTOMER_INVOICE_UI_DEPLOY_FAILED=" + code, file=sys.stderr)
        sys.exit(1)
