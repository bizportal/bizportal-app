"""Offline rollback/concurrency/endpoint boundary checks; no service commands."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import re
import tempfile
import unittest
from email.message import Message
from urllib.error import HTTPError
from unittest.mock import patch

MODULE_PATH = Path(__file__).resolve().parents[1] / "deploy-invoice-finance-preview-dev.py"
spec = importlib.util.spec_from_file_location("invoice_preview_deploy", MODULE_PATH)
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeployBoundaries(unittest.TestCase):
    def test_only_throttle_responses_are_retried_with_bounded_delay(self):
        headers = Message()
        headers["Retry-After"] = "90"
        errors = [HTTPError("https://example.invalid", 429, "throttled", headers, None),
                  HTTPError("https://example.invalid", 401, "denied", None, None)]
        with patch.object(deploy.urllib.request, "urlopen", side_effect=errors) as request, \
             patch.object(deploy.time, "sleep") as sleep:
            self.assertEqual(deploy.status("https://example.invalid", "POST"), 401)
            self.assertEqual(request.call_count, 2)
            sleep.assert_called_once_with(30.0)
            for call in request.call_args_list:
                self.assertEqual(call.args[0].get_method(), "POST")
                self.assertEqual(call.args[0].data, b"{}")

        with patch.object(deploy.urllib.request, "urlopen", side_effect=OSError("offline")) as request, \
             patch.object(deploy.time, "sleep") as sleep:
            self.assertEqual(deploy.status("https://example.invalid"), 0)
            request.assert_called_once()
            sleep.assert_not_called()

    def test_throttling_stops_after_three_attempts(self):
        errors = [HTTPError("https://example.invalid", 429, "throttled", None, None) for _ in range(3)]
        with patch.object(deploy.urllib.request, "urlopen", side_effect=errors) as request, \
             patch.object(deploy.time, "sleep") as sleep:
            self.assertEqual(deploy.status("https://example.invalid"), 429)
            self.assertEqual(request.call_count, 3)
            self.assertEqual([call.args for call in sleep.call_args_list], [(6.2,), (6.2,)])

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
        self.assertIn("BIZPORTAL_CUSTOMER_AR_PREVIEW_ENABLED_DEV=false", value)
        self.assertIn("BIZPORTAL_FINANCE_NOTIFICATIONS_SUPPRESSED_DEV=true", value)
        self.assertNotIn("SESSION_SECRET", value)
        self.assertNotIn("SIGNED_PASSWORD", value)
        self.assertNotIn("SIGNED_OTP", value)
        self.assertNotIn("EnvironmentFile", value)

    def test_writer_requires_existing_parent_lock_and_notification_suppression(self):
        value = deploy.drop_content("writer")
        self.assertIn("BIZPORTAL_MARKETPLACE_VENDOR_PARENT_LOCK_ENABLED_DEV=true", value)
        self.assertIn("BIZPORTAL_CUSTOMER_AR_PREVIEW_ENABLED_DEV=true", value)
        self.assertIn("BIZPORTAL_FINANCE_NOTIFICATIONS_SUPPRESSED_DEV=true", value)
        self.assertIn("BIZPORTAL_MARKETPLACE_FINANCE_GCP_SECRET_NAME_DEV=\n", value)

    def test_customer_preview_has_only_an_exact_read_route(self):
        block = deploy.nginx_block()
        customer_block = re.search(
            r"location = /api/sales/customer-invoices/auto-match-preview \{(.*?)\n    \}", block, re.S)
        self.assertIsNotNone(customer_block)
        self.assertIn("limit_except GET { deny all; }", customer_block.group(1))
        self.assertNotIn("/api/sales/documents", block)
        self.assertNotIn("mark_invoiced", block)

    def test_customer_anonymous_gate_requires_401_and_stage_404(self):
        for mode, expected in (("writer", 401), ("stage", 404)):
            def response(url, method="GET"):
                if url.endswith("/health/ready"):
                    return 200
                if url.endswith("/auth/user"):
                    return 401
                if url.endswith(("/settle", "/action")):
                    return 404
                return expected
            with patch.object(deploy, "status", side_effect=response) as status:
                deploy.check_http_gates(mode)
                status.assert_any_call(deploy.ORIGIN + "/api/sales/customer-invoices/auto-match-preview?company_id=1")

        def unsafe_response(url, method="GET"):
            if "auto-match-preview" in url or url.endswith("/health/ready"):
                return 200
            return 401
        with patch.object(deploy, "status", side_effect=unsafe_response):
            with self.assertRaisesRegex(RuntimeError, "ANONYMOUS_CUSTOMER_AR_GATE_FAILED"):
                deploy.check_http_gates("writer")

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
