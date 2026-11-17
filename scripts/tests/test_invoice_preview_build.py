"""Local tests for build isolation and artifact publication; no actual build."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "invoice_preview_build", Path(__file__).parents[1] / "build-invoice-finance-preview-dev.py")
BUILD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILD)


class ArtifactBuildTests(unittest.TestCase):
    def test_build_environment_does_not_inherit_runtime_or_public_secrets(self):
        with patch.dict(os.environ, {
            "SESSION_SECRET": "unit-test-sensitive", "SUPABASE_SERVICE_ROLE_KEY_DEV": "unit-test-key",
            "NODE_OPTIONS": "--import=unexpected.mjs", "VITE_UNREVIEWED_VALUE": "unit-test-value",
            "VITE_SUPABASE_ANON_KEY": "unexpected-public-key", "HOME": "/original-home",
        }):
            env = BUILD.build_env(offline=True)
        self.assertEqual(env["HOME"], "/original-home")
        self.assertEqual(env["VITE_SUPABASE_ANON_KEY"], "")
        self.assertEqual(env["npm_config_offline"], "true")
        self.assertEqual(env["VITE_BIZPORTAL_FINANCE_READONLY_PREVIEW_DEV"], "false")
        self.assertFalse({"SESSION_SECRET", "SUPABASE_SERVICE_ROLE_KEY_DEV", "NODE_OPTIONS",
                          "VITE_UNREVIEWED_VALUE"} & env.keys())

    def test_artifact_rejects_dependency_symlink_outside_release(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "artifact"
            root.mkdir()
            outside = Path(temporary) / "outside"
            outside.write_text("not portable")
            (root / "dependency").symlink_to("../outside")
            with self.assertRaisesRegex(RuntimeError, "ARTIFACT_SYMLINK_ESCAPE"):
                BUILD.inventory(root)

    def test_manifest_records_dependencies_and_internal_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "dist").mkdir()
            (root / "dist/index.mjs").write_text("export{};")
            (root / "dependency.mjs").symlink_to("dist/index.mjs")
            BUILD.manifest(root, {"source_commit": "a" * 40})
            self.assertEqual(json.loads((root / "RELEASE_SYMLINKS.json").read_text()),
                             {"dependency.mjs": "dist/index.mjs"})
            checksums = (root / "RELEASE_SHA256SUMS.txt").read_text()
            self.assertIn("  dist/index.mjs\n", checksums)
            self.assertIn("  RELEASE_SYMLINKS.json\n", checksums)
            self.assertIn("  source-commit.txt\n", checksums)

    def test_known_pnpm_self_link_is_rebased_to_deployed_package(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifact, checkout = root / "artifact", root / "source"
            source_package = checkout / "artifacts/api-server"
            source_package.mkdir(parents=True)
            link = artifact / "node_modules/.pnpm/node_modules/@workspace/api-server"
            link.parent.mkdir(parents=True)
            for package in (artifact / "package.json", source_package / "package.json"):
                package.write_text(json.dumps({"name": "@workspace/api-server"}))
            link.symlink_to(os.path.relpath(source_package, link.parent))
            self.assertTrue(BUILD.rebase_deploy_self_link(artifact, checkout))
            self.assertEqual(link.resolve(), artifact.resolve())
            self.assertFalse(Path(os.readlink(link)).is_absolute())
            BUILD.inventory(artifact)

    def test_unknown_pnpm_self_link_target_is_never_rebased(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifact, checkout = root / "artifact", root / "source"
            unrelated = root / "unrelated"
            unrelated.mkdir()
            link = artifact / "node_modules/.pnpm/node_modules/@workspace/api-server"
            link.parent.mkdir(parents=True)
            original = os.path.relpath(unrelated, link.parent)
            link.symlink_to(original)
            with self.assertRaisesRegex(RuntimeError, "UNEXPECTED_DEPLOY_SELF_LINK_TARGET"):
                BUILD.rebase_deploy_self_link(artifact, checkout)
            self.assertEqual(os.readlink(link), original)

    def test_publication_never_replaces_existing_empty_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate, target = root / "candidate", root / "target"
            candidate.mkdir()
            (candidate / "data").write_text("candidate")
            target.mkdir()
            with self.assertRaises(OSError):
                BUILD.publish(candidate, target)
            self.assertTrue(candidate.is_dir())
            self.assertEqual(list(target.iterdir()), [])

    def test_publication_renames_valid_candidate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate, target = root / "candidate", root / "target"
            candidate.mkdir()
            (candidate / "data").write_text("candidate")
            BUILD.publish(candidate, target)
            self.assertFalse(candidate.exists())
            self.assertEqual((target / "data").read_text(), "candidate")


if __name__ == "__main__":
    unittest.main()
