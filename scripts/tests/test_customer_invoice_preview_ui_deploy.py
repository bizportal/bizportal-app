"""Offline exact-release, API identity, auth preservation and rollback tests."""
import contextlib
from email.message import Message
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

MODULE_PATH = Path(__file__).resolve().parents[1] / "deploy-customer-invoice-preview-ui-dev.py"
spec = importlib.util.spec_from_file_location("customer_invoice_ui_deploy", MODULE_PATH)
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class UiDeployGuards(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.commit = "a" * 40
        self.base = self.root / "base"
        self.frontend = self.root / "frontend-build"
        self.target = self.root / ("release-" + self.commit[:12])
        self.drop = self.root / "writer.conf"
        self.states = self.root / "states"
        self.api = b"canonical c2 API bytes\n"
        self.rebuilt_api = b"same API source with a different generated pino build directory\n"
        self.previous = (
            f"[Service]\nWorkingDirectory={self.base}\nExecStart=\n"
            f"ExecStart={deploy.NODE} --max-http-header-size=65536 {self.base}/dist/index.mjs\n"
            "Environment=BIZPORTAL_MARKETPLACE_FINANCE_PINNED_IPV4_SESSION_POOLER_DEV=true\n"
            "Environment=BIZPORTAL_SIGNED_PASSWORD_ENABLED_DEV=true\n"
            "EnvironmentFile=/etc/bizportal-finance-dev/vendor-storage-dev.env\n"
        ).encode()
        patches = patch.multiple(
            deploy, BASE=self.base, FRONTEND_INPUT=self.frontend, DROP=self.drop, STATE_ROOT=self.states,
            TARGET_PREFIX=str(self.root / "release-"), PINNED_UI_COMMIT=self.commit,
            BASE_DROP_SHA=deploy.sha_bytes(self.previous), API_SHA=deploy.sha_bytes(self.api),
            FRONTEND_BUILT_API_SHA=deploy.sha_bytes(self.rebuilt_api))
        patches.start()
        self.addCleanup(patches.stop)
        # Tests run unprivileged; production root/file-mode enforcement stays in
        # the deployer. No system paths, services, credentials or network are used.
        for name in ("regular_file", "root_directory"):
            mocked = patch.object(deploy, name)
            mocked.start()
            self.addCleanup(mocked.stop)
        self.drop.write_bytes(self.previous)
        self.make_artifact(self.base, deploy.BASE_SHA, self.api, b"old UI")
        self.make_artifact(self.frontend, self.commit, self.rebuilt_api, b"reviewed UI")
        pins = patch.multiple(deploy, BASE_MANIFEST_SHA=deploy.digest(self.base / "RELEASE_SHA256SUMS.txt"),
                              FRONTEND_MANIFEST_SHA=deploy.digest(self.frontend / "RELEASE_SHA256SUMS.txt"),
                              FRONTEND_INDEX_SHA=deploy.digest(self.frontend / "dist/public/index.html"))
        pins.start()
        self.addCleanup(pins.stop)
        self.make_artifact(self.target, self.commit, self.api, b"reviewed UI", composed=True)
        self.metadata = json.loads((self.target / "release-metadata.json").read_text())

    def make_artifact(self, target, commit, api, html, *, composed=False):
        (target / "dist/public").mkdir(parents=True)
        (target / "dist/index.mjs").write_bytes(api)
        (target / "dist/public/index.html").write_bytes(html)
        (target / "source-commit.txt").write_text(commit + "\n")
        (target / "runtime-dependency.cjs").write_bytes(b"preserved dependency bytes")
        (target / "runtime-link").symlink_to("runtime-dependency.cjs")
        metadata = deploy.common_metadata(target, commit)
        if composed:
            metadata.update(deploy.composition_identity())
        (target / "release-metadata.json").write_text(json.dumps(metadata))
        (target / "RELEASE_SYMLINKS.json").write_text(json.dumps({"runtime-link": "runtime-dependency.cjs"}))
        self.manifest(target)

    def manifest(self, target=None):
        target = target or self.target
        files = sorted(path for path in target.rglob("*")
                       if path.is_file() and not path.is_symlink() and path.name != "RELEASE_SHA256SUMS.txt")
        (target / "RELEASE_SHA256SUMS.txt").write_text("".join(
            deploy.digest(path) + "  " + path.relative_to(target).as_posix() + "\n" for path in files))

    def test_unpinned_source_fails_closed_and_target_binds_exact_review(self):
        with patch.object(deploy, "PINNED_UI_COMMIT", "UNPINNED_UI_SOURCE_ROOT_REVIEW_REQUIRED"):
            with self.assertRaisesRegex(RuntimeError, "UI_SOURCE_NOT_PINNED"):
                deploy.release_target(self.target, self.commit)
        with self.assertRaisesRegex(RuntimeError, "EXACT_REVIEWED_UI_COMMIT_REQUIRED"):
            deploy.release_target(self.target, "b" * 40)
        with self.assertRaisesRegex(RuntimeError, "TARGET_SOURCE_SUFFIX_MISMATCH"):
            deploy.release_target(self.root / "release-bbbbbbbbbbbb", self.commit)
        self.assertEqual(deploy.release_target(self.target, self.commit), self.target)

    def test_drop_changes_only_two_paths_and_retains_bridge_and_auth_references(self):
        new = deploy.candidate_drop(self.previous, self.target)
        self.assertEqual(new, self.previous.replace(str(self.base).encode(), str(self.target).encode()))
        self.assertEqual(new.count(str(self.target).encode()), 2)
        self.assertIn(b"PINNED_IPV4_SESSION_POOLER_DEV=true", new)
        self.assertIn(b"SIGNED_PASSWORD_ENABLED_DEV=true", new)
        self.assertNotIn(b"SESSION_SECRET", new)
        with self.assertRaisesRegex(RuntimeError, "C2_WRITER_DROP_CHANGED"):
            deploy.candidate_drop(self.previous + b"# concurrent edit\n", self.target)

    def test_exact_api_bytes_pass_but_changed_api_is_rejected_even_with_valid_manifest(self):
        deploy.check_artifact(self.target, self.commit)
        (self.target / "dist/index.mjs").write_bytes(b"changed backend")
        self.manifest()
        with self.assertRaisesRegex(RuntimeError, "UI_ONLY_API_BYTE_IDENTITY_REQUIRED"):
            deploy.check_artifact(self.target, self.commit)

    def test_changed_auth_build_flag_or_dependency_lock_is_rejected(self):
        for key, value in (("frontend_flags", {**deploy.FRONTEND_FLAGS, "dev_password_only": False}),
                           ("lockfile_sha256", "0" * 64), ("runtime_envfiles_loaded", True)):
            with self.subTest(key=key):
                (self.target / "release-metadata.json").write_text(json.dumps({**self.metadata, key: value}))
                self.manifest()
                with self.assertRaisesRegex(RuntimeError, "ARTIFACT_METADATA_CHANGED"):
                    deploy.check_artifact(self.target, self.commit)

    def test_manifest_cannot_escape_or_omit_runtime_file(self):
        (self.target / "RELEASE_SHA256SUMS.txt").write_text("0" * 64 + "  ../outside\n")
        with self.assertRaisesRegex(RuntimeError, "ARTIFACT_MANIFEST_PATH_INVALID"):
            deploy.check_artifact(self.target, self.commit)
        self.manifest()
        (self.target / "unlisted.mjs").write_text("unexpected")
        with self.assertRaisesRegex(RuntimeError, "ARTIFACT_UNCHECKSUMMED_FILE"):
            deploy.check_artifact(self.target, self.commit)

    def test_unlisted_external_symlink_is_rejected(self):
        outside = self.root / "outside"
        outside.write_text("outside")
        (self.target / "dependency").symlink_to(outside)
        with self.assertRaisesRegex(RuntimeError, "ARTIFACT_SYMLINK_ESCAPE"):
            deploy.check_artifact(self.target, self.commit)

    def test_compose_preserves_all_runtime_bytes_and_inputs_with_truthful_metadata(self):
        before = deploy.verified_inputs()
        old_manifest_bytes = [(path / "RELEASE_SHA256SUMS.txt").read_bytes() for path in (self.base, self.frontend)]
        shutil.rmtree(self.target)
        with contextlib.redirect_stdout(io.StringIO()), patch.object(deploy, "command") as command, \
             patch.object(deploy, "status") as status:
            deploy.compose(self.target, self.commit)
            command.assert_not_called()
            status.assert_not_called()
        deploy.check_artifact(self.target, self.commit)
        self.assertEqual(deploy.verified_inputs(), before)
        self.assertEqual([(path / "RELEASE_SHA256SUMS.txt").read_bytes()
                          for path in (self.base, self.frontend)], old_manifest_bytes)
        self.assertEqual((self.target / "dist/index.mjs").read_bytes(), self.api)
        self.assertEqual((self.target / "dist/public/index.html").read_bytes(),
                         (self.frontend / "dist/public/index.html").read_bytes())
        self.assertNotEqual((self.target / "dist/index.mjs").stat().st_ino,
                            (self.base / "dist/index.mjs").stat().st_ino)
        self.assertEqual(os.readlink(self.target / "runtime-link"), os.readlink(self.base / "runtime-link"))
        metadata = json.loads((self.target / "release-metadata.json").read_text())
        self.assertEqual(metadata["api_source"], deploy.BASE_SHA)
        self.assertEqual(metadata["frontend_source"], self.commit)
        self.assertEqual(metadata["packaging_mode"], "frontend-only-preserve-c2-runtime")
        self.assertEqual(metadata["api_bundle_sha256"], deploy.API_SHA)

    def test_compose_never_overwrites_existing_target(self):
        previous = (self.target / "RELEASE_SHA256SUMS.txt").read_bytes()
        with self.assertRaisesRegex(RuntimeError, "TARGET_ALREADY_EXISTS"):
            deploy.compose(self.target, self.commit)
        self.assertEqual((self.target / "RELEASE_SHA256SUMS.txt").read_bytes(), previous)

    def test_compose_refuses_tampered_input_frontend_or_runtime_even_with_new_manifest(self):
        shutil.rmtree(self.target)
        for artifact, name in ((self.frontend, "dist/public/index.html"), (self.base, "runtime-dependency.cjs")):
            with self.subTest(artifact=artifact.name):
                path = artifact / name
                previous = path.read_bytes()
                path.write_bytes(b"tampered input bytes")
                self.manifest(artifact)
                with self.assertRaisesRegex(RuntimeError, "INPUT_MANIFEST_PIN_CHANGED"):
                    deploy.compose(self.target, self.commit)
                self.assertFalse(self.target.exists())
                path.write_bytes(previous)
                self.manifest(artifact)

    def test_output_cannot_change_non_api_runtime_dependency(self):
        (self.target / "runtime-dependency.cjs").write_bytes(b"changed dependency with unchanged API")
        self.manifest()
        with self.assertRaisesRegex(RuntimeError, "PRESERVED_RUNTIME_FILES_CHANGED"):
            deploy.check_artifact(self.target, self.commit)

    def test_output_cannot_substitute_frontend_after_build(self):
        (self.target / "dist/public/index.html").write_bytes(b"unreviewed UI")
        self.manifest()
        with self.assertRaisesRegex(RuntimeError, "FRONTEND_FILES_DO_NOT_MATCH_REVIEWED_BUILD"):
            deploy.check_artifact(self.target, self.commit)

    def test_concurrent_active_release_is_not_a_baseline(self):
        with patch.object(deploy, "property_of", return_value="/opt/another-release"), \
             patch.object(deploy, "static_guard") as static:
            with self.assertRaisesRegex(RuntimeError, "PREVIEW_SOURCE_CHANGED"):
                deploy.current_baseline()
            static.assert_not_called()

    def test_only_systemd_process_values_and_exact_pwd_are_normalized(self):
        original = {"SESSION_SECRET": "sensitive-original", "account": "same-owner",
                    "PWD": str(self.base), "INVOCATION_ID": "old", "JOURNAL_STREAM": "old",
                    "SYSTEMD_EXEC_PID": "1", "DATABASE_URL": "sensitive-dsn"}
        updated = {**original, "PWD": str(self.target), "INVOCATION_ID": "new",
                   "JOURNAL_STREAM": "new", "SYSTEMD_EXEC_PID": "2"}
        self.assertEqual(deploy.stable_environment(original, self.base),
                         deploy.stable_environment(updated, self.target))
        updated["SESSION_SECRET"] = "sensitive-replaced"
        snapshot = {"files": {}, "environment": deploy.stable_environment(original, self.base)}
        with patch.object(deploy, "static_guard"), patch.object(deploy, "protected_files", return_value={}), \
             patch.object(deploy, "runtime_environment", return_value=deploy.stable_environment(updated, self.target)):
            with self.assertRaisesRegex(RuntimeError, "^AUTH_OR_EFFECTIVE_ENVIRONMENT_CHANGED$") as raised:
                deploy.verify_snapshot(snapshot, self.target)
            self.assertNotIn("sensitive", str(raised.exception))

    def runtime_mocks(self, *, gate_failure=None):
        stack = contextlib.ExitStack()
        snapshot = {"files": {}, "environment": {"SESSION_SECRET": "never-persist-this-signing-secret"}}
        stack.enter_context(patch.object(deploy, "current_baseline", return_value=snapshot))
        stack.enter_context(patch.object(deploy, "static_guard"))
        stack.enter_context(patch.object(deploy, "protected_files", return_value={}))
        stack.enter_context(patch.object(deploy, "property_of", return_value=str(self.target)))
        stack.enter_context(patch.object(deploy, "runtime_environment", return_value=snapshot["environment"]))
        stack.enter_context(patch.object(deploy, "verify_snapshot"))
        command = stack.enter_context(patch.object(deploy, "command"))
        stack.enter_context(patch.object(deploy, "ready"))
        stack.enter_context(patch.object(deploy, "check_http_gates", side_effect=gate_failure))
        stack.enter_context(patch.object(deploy, "check_frontend"))
        stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        return stack, command

    def test_apply_writes_only_owned_drop_and_receipt_never_nginx_or_secrets(self):
        stack, command = self.runtime_mocks()
        with stack, patch.object(deploy, "atomic_write", wraps=deploy.atomic_write) as write:
            deploy.apply(self.target, self.commit)
            for call in write.call_args_list:
                path = call.args[0]
                self.assertTrue(path == self.drop or path.is_relative_to(self.states), path)
                self.assertNotIn(b"never-persist-this-signing-secret", call.args[1])
            self.assertEqual([call.args for call in command.call_args_list], [
                ("systemctl", "daemon-reload"), ("systemctl", "restart", deploy.UNIT)])
        self.assertEqual(self.drop.read_bytes(), deploy.candidate_drop(self.previous, self.target))

    def test_failed_gate_restores_only_exact_owned_candidate_to_c2(self):
        stack, command = self.runtime_mocks(gate_failure=RuntimeError("GATE_FAILED"))
        with stack:
            with self.assertRaisesRegex(RuntimeError, "^GATE_FAILED$"):
                deploy.apply(self.target, self.commit)
            self.assertEqual(self.drop.read_bytes(), self.previous)
            self.assertEqual([call.args for call in command.call_args_list], [
                ("systemctl", "daemon-reload"), ("systemctl", "restart", deploy.UNIT),
                ("systemctl", "daemon-reload"), ("systemctl", "restart", deploy.UNIT)])

    def test_failed_gate_does_not_rollback_concurrent_drop_edit(self):
        def concurrent_failure():
            self.drop.write_bytes(b"other rollout owns this configuration")
            raise RuntimeError("GATE_FAILED")
        stack, command = self.runtime_mocks(gate_failure=concurrent_failure)
        with stack:
            with self.assertRaisesRegex(RuntimeError, "ROLLBACK_DROPIN_CHANGED"):
                deploy.apply(self.target, self.commit)
            self.assertEqual(command.call_count, 2)
            self.assertEqual(self.drop.read_bytes(), b"other rollout owns this configuration")

    def test_failed_restart_with_missing_credential_mount_can_restore_c2(self):
        snapshot = {"files": {}, "environment": {"SESSION_SECRET": "unchanged"}}
        state = {"active": True, "mount": True, "directory": self.base, "restarts": 0}
        mount_requirements = []

        def protected_files(*, require_active_mount=True):
            mount_requirements.append(require_active_mount)
            if require_active_mount and not state["mount"]:
                raise RuntimeError("ACTIVE_GCP_BOOTSTRAP_SOURCE_CHANGED")
            return {}

        def command(*argv):
            if argv == ("systemctl", "restart", deploy.UNIT):
                state["restarts"] += 1
                if state["restarts"] == 1:
                    state.update(active=False, mount=False, directory=self.target)
                    raise RuntimeError("COMMAND_FAILED_systemctl")
                state.update(active=True, mount=True, directory=self.base)
            return ""

        def property_of(_unit, name):
            return ("active" if state["active"] else "failed") if name == "ActiveState" else str(state["directory"])

        with patch.object(deploy, "current_baseline", return_value=snapshot), \
             patch.object(deploy, "static_guard"), patch.object(deploy, "protected_files", side_effect=protected_files), \
             patch.object(deploy, "runtime_environment", return_value=snapshot["environment"]), \
             patch.object(deploy, "property_of", side_effect=property_of), \
             patch.object(deploy, "command", side_effect=command), patch.object(deploy, "ready"), \
             contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, "^COMMAND_FAILED_systemctl$"):
                deploy.apply(self.target, self.commit)
        self.assertEqual(self.drop.read_bytes(), self.previous)
        self.assertEqual(state["restarts"], 2)
        self.assertTrue(state["active"] and state["mount"])
        self.assertEqual(mount_requirements, [True, False, True])

    def test_inactive_rollback_still_captures_exact_source_files_without_mount(self):
        envfiles = tuple(self.root / ("env" + str(index)) for index in range(3))
        bootstrap, legacy_unit, legacy_drop, mount = [self.root / name for name in
                                                     ("bootstrap", "legacy-unit", "legacy-drop", "mount")]
        for path in (*envfiles, bootstrap, legacy_unit, legacy_drop):
            path.write_bytes(b"unchanged source bytes")
            path.chmod(0o600)
        with patch.multiple(deploy, STATIC_FILES={}, ENVFILES=envfiles, BOOTSTRAP=bootstrap,
                            LEGACY_UNIT_FILE=legacy_unit, LEGACY_DROP=legacy_drop, LOADED_BOOTSTRAP=mount):
            with self.assertRaisesRegex(RuntimeError, "ACTIVE_GCP_BOOTSTRAP_SOURCE_CHANGED"):
                deploy.protected_files()
            saved = deploy.protected_files(require_active_mount=False)
            self.assertEqual(set(saved), {*envfiles, bootstrap, legacy_unit, legacy_drop})
            mount.write_bytes(bootstrap.read_bytes())
            self.assertEqual(deploy.protected_files(), saved)

    def test_frontend_gate_requires_exact_new_html_and_same_origin_without_auth(self):
        expected = (self.target / "dist/public/index.html").read_bytes()

        class Response:
            status = 200
            def __init__(self, data, url=deploy.ORIGIN + "/sales/invoices"):
                self.data, self.url, self.limit = data, url, None
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                return False
            def geturl(self):
                return self.url
            def read(self, limit):
                self.limit = limit
                return self.data[:limit]

        response = Response(expected)
        with patch.object(deploy.urllib.request, "urlopen", return_value=response) as request:
            deploy.check_frontend(self.target)
            self.assertEqual(response.limit, len(expected) + 1)
            outgoing = request.call_args.args[0]
            self.assertEqual(outgoing.get_header("Accept-encoding"), "identity")
            self.assertFalse(outgoing.has_header("Cookie"))
            self.assertFalse(outgoing.has_header("Authorization"))
        for response, code in ((Response(b"old or unrelated UI"), "FRONTEND_SERVED_BYTES_MISMATCH"),
                               (Response(expected, "https://example.invalid"), "FRONTEND_HTTP_IDENTITY_FAILED")):
            with patch.object(deploy.urllib.request, "urlopen", return_value=response):
                with self.assertRaisesRegex(RuntimeError, code):
                    deploy.check_frontend(self.target)

    def test_rollback_refuses_modified_receipt_before_service_commands(self):
        stack, _ = self.runtime_mocks()
        with stack:
            deploy.apply(self.target, self.commit)
        directory = next(self.states.iterdir())
        receipt = json.loads((directory / "state.json").read_text())
        receipt["old_source"] = "b" * 40
        (directory / "state.json").write_text(json.dumps(receipt))
        with patch.object(deploy, "command") as command:
            with self.assertRaisesRegex(RuntimeError, "ROLLBACK_RECEIPT_MISMATCH"):
                deploy.restore(directory)
            command.assert_not_called()

    def test_anonymous_scope_and_preview_remain_closed_and_404_is_not_retried(self):
        def response(url, method="GET"):
            if url.endswith("/health/ready"):
                return 200
            return 404 if url.endswith(("/settle", "/action")) else 401
        with patch.object(deploy, "status", side_effect=response) as status:
            deploy.check_http_gates()
            status.assert_any_call(deploy.ORIGIN + "/api/mkt/admin/finance-company-selection", "POST")
            status.assert_any_call(deploy.ORIGIN + "/api/sales/customer-invoices/auto-match-preview?company_id=1", "GET")
        with patch.object(deploy, "status", side_effect=[200, 401, 404]) as status, \
             patch.object(deploy.time, "sleep") as sleep:
            with self.assertRaisesRegex(RuntimeError, "ANONYMOUS_SCOPE_EXPECTED_401_OBSERVED_404"):
                deploy.check_http_gates()
            self.assertEqual(status.call_count, 3)
            sleep.assert_not_called()

    def test_429_only_retries_are_bounded_and_never_add_auth(self):
        headers = Message()
        headers["Retry-After"] = "90"
        replies = [HTTPError("https://example.invalid", 429, "throttled", headers, None),
                   HTTPError("https://example.invalid", 401, "denied", None, None)]
        with patch.object(deploy.urllib.request, "urlopen", side_effect=replies) as request, \
             patch.object(deploy.time, "sleep") as sleep:
            self.assertEqual(deploy.status("https://example.invalid", "POST"), 401)
            sleep.assert_called_once_with(30.0)
            for call in request.call_args_list:
                self.assertEqual(call.args[0].data, b"{}")
                self.assertFalse(call.args[0].has_header("Cookie"))
                self.assertFalse(call.args[0].has_header("Authorization"))
        replies = [HTTPError("https://example.invalid", 429, "throttled", None, None) for _ in range(3)]
        with patch.object(deploy.urllib.request, "urlopen", side_effect=replies) as request, \
             patch.object(deploy.time, "sleep") as sleep:
            self.assertEqual(deploy.status("https://example.invalid"), 429)
            self.assertEqual(request.call_count, 3)
            self.assertEqual([call.args for call in sleep.call_args_list], [(6.2,), (6.2,)])

    def test_check_action_has_no_network_or_service_mutation(self):
        with patch.object(deploy, "LOCK", self.root / "lock"), patch.object(deploy.os, "geteuid", return_value=0), \
             patch.object(deploy, "current_baseline"), patch.object(deploy, "command") as command, \
             patch.object(deploy, "status") as status, contextlib.redirect_stdout(io.StringIO()), \
             patch.object(deploy.sys, "argv", [str(MODULE_PATH), "check", "--target", str(self.target),
                                               "--expected-commit", self.commit]):
            deploy.main()
            command.assert_not_called()
            status.assert_not_called()
            self.assertEqual(self.drop.read_bytes(), self.previous)
            self.assertFalse(self.states.exists())


if __name__ == "__main__":
    unittest.main()
