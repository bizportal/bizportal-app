#!/usr/bin/env python3
"""Review-only source contract for exact private Writer->Writer upgrade.

No GCP, Supabase, nginx, systemd, network calls or mutation in this test.
Use the deployed-host read-only preflight separately before any apply.
"""
from pathlib import Path
import importlib.util
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "scripts" / "deploy-invoice-finance-pinned-ipv4-upgrade-dev.py"
spec = importlib.util.spec_from_file_location("pr132_pinned", SRC)
assert spec and spec.loader
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class PinnedUpgradeTests(unittest.TestCase):
    def test_exact_old_and_new_sources_are_pinned(self):
        self.assertEqual(m.BASE_SHA, "7aaf715e8910618ff181b13774a778402f38e417")
        self.assertEqual(m.PINNED_CANDIDATE_SHA, "c2d092e18a272a8c2606daaf76a01ec56c77b8c8")
        self.assertEqual(m.BASE.name, "bizportal-invoice-completion-20261117-7aaf715e8910")
        self.assertEqual(m.ACTIVE_WRITER_DROP,
            "51f44b18072b3ff615e5376d8f99cb63269c64a44734fe40676ec539cd8d2d85")
        self.assertEqual(m.ACTIVE_WRITER_NGINX,
            "228d3fb6b12fdd48c637dff22a79787a1e655872ed0934ce656011f488491764")
        self.assertEqual(m.release_target(
            Path("/opt/bizportal-invoice-completion-20261117-c2d092e18a27"),
            m.PINNED_CANDIDATE_SHA).name,
            "bizportal-invoice-completion-20261117-c2d092e18a27")

    def test_wrong_source_and_unapproved_target_fail_closed(self):
        with self.assertRaisesRegex(RuntimeError, "UPGRADE_EXACT_CANDIDATE_SHA_REQUIRED"):
            m.release_target(Path("/opt/bizportal-invoice-completion-20261117-c2d092e18a27"),
                             "f56451e8e322866a237d1d489723e5bdcbcebd1b")
        with self.assertRaisesRegex(RuntimeError, "TARGET_SOURCE_SUFFIX_MISMATCH"):
            m.release_target(Path("/opt/bizportal-invoice-completion-20261117"),
                             m.PINNED_CANDIDATE_SHA)

    def test_only_pinned_company_writer_has_bridge_and_outbound_messages_off(self):
        writer = m.drop_content("writer")
        self.assertIn(
            "Environment=BIZPORTAL_MARKETPLACE_FINANCE_PINNED_IPV4_SESSION_POOLER_DEV=true", writer)
        for flag in (
            "BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV",
            "BIZPORTAL_MARKETPLACE_ACCOUNTING_HANDOFF_ENABLED_DEV",
            "BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV",
            "BIZPORTAL_MARKETPLACE_FINANCE_SINGLE_GCP_SECRET_DEV",
            "BIZPORTAL_FINANCE_NOTIFICATIONS_SUPPRESSED_DEV",
        ):
            self.assertIn(f"Environment={flag}=true", writer)
        for flag in (
            "FLEET_EMBEDDED_REMINDER_ENABLED", "DEV_RECONCILIATION_SCHEDULERS_ENABLED",
            "GMAIL_INVOICE_SCHEDULER_ENABLED", "WA_ENABLED",
        ):
            self.assertIn(f"Environment={flag}=false", writer)
        self.assertIn("EnvironmentFile=/etc/bizportal-finance-dev/vendor-storage-dev.env", writer)
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY_DEV=", writer)
        self.assertNotIn("password", writer.lower())

    def test_token_capability_routes_keep_protection(self):
        block = m.nginx_block()
        self.assertIn("(?:[0-9A-Fa-f]{48}|[0-9A-Fa-f]{64})", block)
        self.assertEqual(block.count("access_log off;"), 3)
        self.assertIn('proxy_set_header Authorization "";', block)
        self.assertIn('X-Forwarded-Proto https;', block)
        self.assertNotIn("location = /api/sales/documents/1/action", block)

    def test_deployer_is_only_scoped_private_dev_and_does_not_rotate_secret(self):
        src = SRC.read_text()
        self.assertIn('require(args.mode == "writer", "PR132_ONLY_WRITER_TO_WRITER_UPGRADE")', src)
        self.assertIn("PREVIOUS_ACTIVE_WRITER_DROP_CHANGED", src)
        self.assertIn("PREVIOUS_ACTIVE_WRITER_NGINX_CHANGED", src)
        self.assertIn("ROLLBACK_DROPIN_CHANGED", src)
        self.assertIn("ROLLBACK_NGINX_CHANGED", src)
        self.assertIn("PRIVATE_FINANCE_PREVIEW_ROLLBACK_PASS", src)
        self.assertIn("fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)", src)
        self.assertNotIn("gcloud ", src)
        self.assertNotIn("secretmanager.googleapis.com", src)
        self.assertNotIn("supabase.co:5432", src)


if __name__ == "__main__":
    unittest.main()
