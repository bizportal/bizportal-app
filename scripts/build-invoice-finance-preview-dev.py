#!/usr/bin/env python3
"""Build one exact official source commit into an inactive private DEV artifact.

Run on the Linux x64 preview host. This does not load runtime credentials, start
the application, connect to a database, or modify systemd/Nginx. Existing output
is never overwritten. Dependency install is offline unless explicitly requested.
"""
from __future__ import annotations

import argparse
import ctypes
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile

TARGET = Path("/opt/bizportal-invoice-completion-20261117")
ORIGIN = "https://github.com/bizportal/bizportal-app.git"
PNPM_VERSION = "10.33.0"


def require(ok: bool, code: str) -> None:
    if not ok:
        raise RuntimeError(code)


def release_target(target: Path, commit: str) -> Path:
    require(re.fullmatch(r"[0-9a-f]{40}", commit) is not None, "FULL_COMMIT_SHA_REQUIRED")
    allowed = {TARGET, Path(str(TARGET) + "-" + commit[:12])}
    require(target in allowed, "TARGET_SOURCE_SUFFIX_MISMATCH")
    require(not target.is_symlink(), "TARGET_SYMLINK_NOT_ALLOWED")
    return target


def separate_source_target(source: Path, target: Path) -> None:
    source_path, target_path = source.resolve(), target.resolve()
    require(not source_path.is_relative_to(target_path)
            and not target_path.is_relative_to(source_path), "SOURCE_TARGET_OVERLAP")


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def build_env(*, offline: bool) -> dict[str, str]:
    # Never inherit application credentials, NODE_OPTIONS, VITE values or CI
    # signing data into compiler processes or the generated public JavaScript.
    env = {key: os.environ[key] for key in
           ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "PNPM_HOME")
           if key in os.environ}
    env.update({
        "CI": "true", "APP_ENV": "development", "NODE_ENV": "development",
        "BASE_PATH": "/", "PORT": "18442",
        "VITE_SUPABASE_URL": "", "VITE_SUPABASE_ANON_KEY": "",
        "GOOGLE_MAPS_API_KEY": "",
        "VITE_BIZPORTAL_DEV_PASSWORD_ONLY": "true",
        "VITE_BIZPORTAL_OTP_ONLY_PREVIEW": "false",
        "VITE_BIZPORTAL_FINANCE_GLOBAL_SCOPE_UI_DEV": "true",
        "VITE_BIZPORTAL_FINANCE_READONLY_PREVIEW_DEV": "false",
        "npm_config_userconfig": "/dev/null",
        "npm_config_offline": "true" if offline else "false",
    })
    return env


def run(argv: list[str], cwd: Path, env: dict[str, str], *, capture: bool = False) -> str:
    # Commands contain only source paths and public build flags. In particular,
    # this process never imports either runtime EnvironmentFile.
    result = subprocess.run(argv, cwd=cwd, env=env, text=True,
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE if capture else None)
    require(result.returncode == 0, "BUILD_COMMAND_FAILED_" + Path(argv[0]).name)
    return result.stdout.strip() if capture else ""


def inventory(root: Path) -> tuple[list[Path], dict[str, str]]:
    files: list[Path] = []
    links: dict[str, str] = {}
    for directory, directories, names in os.walk(root, followlinks=False):
        for name in sorted(directories + names):
            path = Path(directory) / name
            relative = path.relative_to(root).as_posix()
            require("\n" not in relative and "\r" not in relative, "ARTIFACT_PATH_INVALID")
            if path.is_symlink():
                target = os.readlink(path)
                require(not Path(target).is_absolute(), "ARTIFACT_ABSOLUTE_SYMLINK")
                require(path.resolve().is_relative_to(root.resolve()), "ARTIFACT_SYMLINK_ESCAPE: " + relative)
                require(path.exists(), "ARTIFACT_BROKEN_SYMLINK")
                links[relative] = target
            elif path.is_file():
                files.append(path)
            else:
                require(path.is_dir(), "ARTIFACT_SPECIAL_FILE")
    return sorted(files), dict(sorted(links.items()))


def rebase_deploy_self_link(artifact: Path, checkout: Path) -> bool:
    # pnpm 10.33 legacy deploy leaves one workspace self-reference pointing at
    # the temporary source checkout. The deployed root IS that exact package;
    # rebase only this known link, never copy an arbitrary external dependency.
    link = artifact / "node_modules/.pnpm/node_modules/@workspace/api-server"
    if not link.is_symlink():
        require(not link.exists(), "UNEXPECTED_DEPLOY_SELF_REFERENCE")
        return False
    resolved = link.resolve()
    if resolved == artifact.resolve():
        return False
    require(resolved == (checkout / "artifacts/api-server").resolve(),
            "UNEXPECTED_DEPLOY_SELF_LINK_TARGET")
    for package in (artifact / "package.json", checkout / "artifacts/api-server/package.json"):
        require(json.loads(package.read_text()).get("name") == "@workspace/api-server",
                "DEPLOY_SELF_PACKAGE_MISMATCH")
    link.unlink()
    link.symlink_to(os.path.relpath(artifact, link.parent))
    require(link.resolve() == artifact.resolve(), "DEPLOY_SELF_LINK_REBASE_FAILED")
    return True


def manifest(root: Path, metadata: dict[str, object]) -> None:
    (root / "source-commit.txt").write_text(str(metadata["source_commit"]) + "\n")
    (root / "release-metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    _, links = inventory(root)
    (root / "RELEASE_SYMLINKS.json").write_text(json.dumps(links, indent=2) + "\n")
    files, _ = inventory(root)
    lines = [f"{digest(path)}  {path.relative_to(root).as_posix()}"
             for path in files if path.name != "RELEASE_SHA256SUMS.txt"]
    (root / "RELEASE_SHA256SUMS.txt").write_text("\n".join(lines) + "\n")
    # tempfile parents are intentionally private. The final isolated artifact
    # must be traversable/readable by the existing unprivileged preview user.
    root.chmod(0o755)
    for directory, directories, names in os.walk(root, followlinks=False):
        for name in directories + names:
            path = Path(directory) / name
            if not path.is_symlink():
                mode = path.stat().st_mode
                path.chmod(0o755 if stat.S_ISDIR(mode) or mode & 0o111 else 0o644)


def publish(artifact: Path, target: Path) -> None:
    # Linux renameat2(RENAME_NOREPLACE) atomically refuses even an empty directory
    # created by another process after the initial target check.
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(artifact), -100, os.fsencode(target), 1) != 0:
        raise OSError(ctypes.get_errno(), "ATOMIC_ARTIFACT_PUBLISH_REFUSED")


def build(source: Path, commit: str, *, offline: bool, target: Path = TARGET) -> None:
    target = release_target(target, commit)
    require(platform.system() == "Linux" and platform.machine() == "x86_64", "LINUX_X64_REQUIRED")
    require(not target.exists(), "TARGET_ALREADY_EXISTS")
    source = source.resolve(strict=True)
    separate_source_target(source, target)
    env = build_env(offline=offline)
    require(run(["git", "config", "--get", "remote.origin.url"], source, env, capture=True) == ORIGIN,
            "OFFICIAL_SOURCE_ORIGIN_REQUIRED")
    require(run(["git", "rev-parse", commit + "^{commit}"], source, env, capture=True) == commit,
            "SOURCE_COMMIT_NOT_PRESENT")
    node = run(["node", "--version"], source, env, capture=True)
    require(node.startswith("v22."), "NODE_22_REQUIRED")
    pnpm = run(["pnpm", "--version"], source, env, capture=True)
    require(pnpm == PNPM_VERSION, "PNPM_10_33_0_REQUIRED")
    require(target.parent.is_dir(), "TARGET_PARENT_MISSING")
    with tempfile.TemporaryDirectory(prefix=".bizportal-invoice-build-", dir=target.parent) as temporary:
        workspace = Path(temporary)
        checkout = workspace / "source"
        checkout.mkdir()
        archive = workspace / "source.tar"
        with archive.open("wb") as output:
            result = subprocess.run(["git", "archive", "--format=tar", commit], cwd=source,
                                    env=env, stdout=output, stderr=subprocess.PIPE)
        require(result.returncode == 0, "SOURCE_ARCHIVE_FAILED")
        # git archive includes only committed source, never local runtime envfiles.
        with tarfile.open(archive) as exported:
            exported.extractall(checkout, filter="data")
        require(not list(checkout.rglob(".env")), "COMMITTED_DOTENV_NOT_ALLOWED")
        install = ["pnpm", "install", "--frozen-lockfile"]
        if offline:
            install.append("--offline")
        run(install, checkout, env)
        lock_sha = digest(checkout / "pnpm-lock.yaml")
        env["NODE_ENV"] = "production"
        run(["pnpm", "--filter", "@workspace/api-server", "run", "build"], checkout, env)
        run(["pnpm", "--filter", "@workspace/bizportal", "run", "build"], checkout, env)
        run(["node", "scripts/prepare-hostinger.mjs"], checkout, env)
        require(digest(checkout / "pnpm-lock.yaml") == lock_sha, "LOCKFILE_CHANGED")
        artifact = workspace / "artifact"
        run(["pnpm", "--filter", "@workspace/api-server", "deploy", "--legacy", "--prod",
             str(artifact)], checkout, env)
        self_link_rebased = rebase_deploy_self_link(artifact, checkout)
        shutil.copytree(checkout / "dist", artifact / "dist", dirs_exist_ok=True)
        for name in ("dist/index.mjs", "dist/public/index.html", "package.json"):
            require((artifact / name).is_file(), "REQUIRED_ARTIFACT_FILE_MISSING")
        run(["node", "--check", "dist/index.mjs"], artifact, env)
        # Do not import index.mjs: that would start the service/schedulers. These
        # native/runtime dependency checks are local, with no app credentials.
        run(["node", "--input-type=module", "-e",
             "import{createRequire}from'node:module';const r=createRequire(process.cwd()+'/package.json');"
             "for(const n of ['sharp','bcryptjs','pdfkit'])r(n);"
             "console.log('runtime dependency load: PASS');"], artifact, env)
        manifest(artifact, {
            "source_origin": ORIGIN, "source_commit": commit, "artifact_target": str(target),
            "build_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
            "node": node, "pnpm": pnpm, "platform": "linux-x64",
            "lockfile_sha256": lock_sha, "offline_install": offline,
            "pnpm_self_link_rebased": self_link_rebased,
            "frontend_flags": {
                "dev_password_only": True, "otp_only_preview": False,
                "finance_global_scope": True, "finance_readonly_preview": False,
            },
            "runtime_envfiles_loaded": False,
            "activation_performed": False,
        })
        publish(artifact, target)
    print(json.dumps({"status": "BUILT_AND_STAGED_NOT_ACTIVE", "path": str(target),
                      "source_commit": commit, "bundle_sha256": digest(target / "dist/index.mjs")}))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path, help="Existing official Git checkout")
    parser.add_argument("--expected-commit", required=True, help="Exact integrated source SHA, 40 hex")
    parser.add_argument("--target", type=Path, default=TARGET,
                        help="Existing fixed target or /opt/bizportal-invoice-completion-20261117-<first12SHA>")
    parser.add_argument("--allow-registry", action="store_true",
                        help="Permit frozen-lockfile registry fetch if the existing pnpm store is incomplete")
    args = parser.parse_args()
    try:
        build(args.source, args.expected_commit, offline=not args.allow_registry, target=args.target)
    except (OSError, RuntimeError, ValueError, tarfile.TarError) as error:
        # No environment or credential-bearing subprocess output is included.
        print(json.dumps({"status": "BUILD_FAILED", "error": str(error)}))
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
