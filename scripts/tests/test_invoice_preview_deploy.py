"""Offline rollback/concurrency/endpoint boundary checks; no service commands."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

MODULE_PATH = Path(__file__).resolve().parents[1] / "deploy-invoice-finance-preview-dev.py"
spec = importlib.util.spec_from_file_location("invoice_preview_deploy", MODULE_PATH)
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeployBoundaries(unittest.TestCase):
    def test_additional_routes_refuse_payments_and_invalid_resource_paths(self):
        patterns = [re.compile(p) for p in re.findall(r'location ~ "([^"]+)"', deploy.nginx_block())]
        admitted = lambda path: any(p.fullmatch(path) for p in patterns)
        self.assertTrue(admitted("/api/mkt/admin/vendor-invoices/12/match"))
        self.assertTrue(admitted("/api/mkt/admin/ap-preparations/12/accounting-handoff"))
        self.assertTrue(admitted("/api/mkt/vendor-invoice/" + "a" * 64))
        for path in [
            "/api/mkt/admin/vendor-invoices/12/settle",
            "/api/mkt/admin/ap-preparations/12/payment",
            "/api/mkt/admin/vendor-invoices/12/match/extra",
            "/api/mkt/admin/vendor-invoices/00/match",
            "/api/mkt/vendor-invoice/" + "a" * 63,
            "/api/mkt/vendor-invoice/" + "g" * 64,
            "/api/accounting/entries/12/post",
        ]:
            self.assertFalse(admitted(path), path)

    def test_source_stage_preserves_auth_and_disables_writers(self):
        value = deploy.drop_content("stage")
        self.assertIn("CANONICAL_FINANCE_ENABLED_DEV=false", value)
        self.assertIn("VENDOR_INVOICE_ENABLED_DEV=false", value)
        self.assertIn("VENDOR_PARENT_LOCK_ENABLED_DEV=false", value)
        self.assertIn("BIZPORTAL_FINANCE_NOTIFICATIONS_SUPPRESSED_DEV=true", value)
        self.assertNotIn("SESSION_SECRET", value)
        self.assertNotIn("SIGNED_PASSWORD", value)
        self.assertNotIn("SIGNED_OTP", value)
        self.assertNotIn("EnvironmentFile", value)

    def test_writer_requires_existing_parent_lock_and_notification_suppression(self):
        value = deploy.drop_content("writer")
        self.assertIn("BIZPORTAL_MARKETPLACE_VENDOR_PARENT_LOCK_ENABLED_DEV=true", value)
        self.assertIn("BIZPORTAL_FINANCE_NOTIFICATIONS_SUPPRESSED_DEV=true", value)
        self.assertIn("BIZPORTAL_MARKETPLACE_FINANCE_GCP_SECRET_NAME_DEV=\n", value)

    def test_nginx_change_after_snapshot_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, "NGINX_BASELINE_CHANGED"):
            deploy.nginx_content("unreviewed unrelated runtime change\n", "writer")

    def test_artifact_manifest_cannot_read_outside_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary)
            commit = "a" * 40
            (target / "source-commit.txt").write_text(commit)
            (target / "RELEASE_SHA256SUMS.txt").write_text("0" * 64 + "  ../outside\n")
            with patch.object(deploy, "TARGET", target):
                with self.assertRaisesRegex(RuntimeError, "ARTIFACT_PATH_INVALID"):
                    deploy.check_artifact(commit)

    def test_manual_rollback_does_not_overwrite_other_deployment(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_root = root / "states"
            state = state_root / "rollout"
            state.mkdir(parents=True)
            drop = root / "drop.conf"
            drop.write_text("newer concurrent deployment")
            (state / "state.json").write_text(json.dumps({"new_drop_sha": "wrong"}))
            with patch.multiple(deploy, STATE_ROOT=state_root, DROP=drop), patch.object(deploy, "command") as command:
                with self.assertRaisesRegex(RuntimeError, "ROLLBACK_DROPIN_CHANGED"):
                    deploy.restore(state, verify_current=True)
                command.assert_not_called()
                self.assertEqual(drop.read_text(), "newer concurrent deployment")

    def test_failed_nginx_validation_restores_previous_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            drop, nginx, legacy = [root / name for name in ["drop.conf", "nginx.conf", "legacy.conf"]]
            drop.write_text("previous-stage")
            nginx.write_text("previous-nginx")
            legacy.write_text("legacy-unchanged")
            original_directory = "/opt/original-preview"
            fail_once = True

            def command(*argv):
                nonlocal fail_once
                if argv == ("nginx", "-t") and fail_once:
                    fail_once = False
                    raise RuntimeError("COMMAND_FAILED_nginx")
                return ""

            def property_of(unit, name):
                return {"MainPID": "123", "ActiveState": "active", "WorkingDirectory": original_directory}[name]

            with patch.multiple(deploy, DROP=drop, NGINX=nginx, LEGACY_NGINX=legacy, STATE_ROOT=root / "states"), \
                 patch.object(deploy, "check_artifact"), patch.object(deploy, "current_baseline"), \
                 patch.object(deploy, "validate_storage"), patch.object(deploy, "nginx_content", return_value="new-nginx"), \
                 patch.object(deploy, "property_of", side_effect=property_of), patch.object(deploy, "command", side_effect=command), \
                 patch.object(deploy, "ready"), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError, "COMMAND_FAILED_nginx"):
                    deploy.apply("writer", "a" * 40)
            self.assertEqual(drop.read_text(), "previous-stage")
            self.assertEqual(nginx.read_text(), "previous-nginx")
            self.assertEqual(legacy.read_text(), "legacy-unchanged")


if __name__ == "__main__":
    unittest.main()
