#!/usr/bin/env python3
"""Exercise release selection against real Git changes, without building an APK."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("android_release", Path(__file__).with_name("android-release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseSelection(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.previous = Path.cwd()
        os.chdir(self.directory.name)
        self.git("init", "-q", "-b", "main")
        self.base = self.commit("README.md", "initial")

    def tearDown(self):
        os.chdir(self.previous)
        self.directory.cleanup()

    def git(self, *args):
        return subprocess.check_output(
            ["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", *args],
            text=True, stderr=subprocess.PIPE,
        ).strip()

    def commit(self, name, contents):
        path = Path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents)
        self.git("add", "-A")
        self.git("commit", "-qm", "test change")
        return self.git("rev-parse", "HEAD")

    def test_docs_server_tests_and_acceptance_do_not_build_an_apk(self):
        for name in ("docs/PRODUCT.md", "cloud/src/jobs.ts", "tests/cloud/client.test.ts",
                     ".maestro/import-review.yaml", "scripts/ci/android-acceptance.sh"):
            self.commit(name, "change")
        self.assertFalse(release.android_changes(self.base))

    def test_app_change_in_an_earlier_pushed_commit_is_included(self):
        self.commit("src/cloud/results.ts", "app result handling")
        self.commit("README.md", "later documentation")
        self.assertTrue(release.android_changes(self.base))

    def test_deleted_and_renamed_product_files_require_a_build(self):
        base = self.commit("assets/model/weight.bin", "model")
        self.git("rm", "assets/model/weight.bin")
        self.git("commit", "-qm", "delete model")
        self.assertTrue(release.android_changes(base))
        base = self.commit("src/example.ts", "source")
        self.git("mv", "src/example.ts", "example.txt")
        self.git("commit", "-qm", "move out of product")
        self.assertTrue(release.android_changes(base))

    def test_build_configuration_and_nested_native_inputs_require_a_build(self):
        for name in ("app.json", "package-lock.json", "metro.config.js",
                     "modules/sekirei/ios/Module.swift", "scripts/engine/build-android.sh",
                     ".github/workflows/android-release.yml"):
            with self.subTest(path=name):
                base = self.git("rev-parse", "HEAD")
                self.commit(name, "build input")
                self.assertTrue(release.android_changes(base))

    def test_initial_push_checks_the_whole_tree(self):
        self.assertFalse(release.android_changes("0" * 40))
        self.commit("app/index.tsx", "screen")
        self.assertTrue(release.android_changes("0" * 40))

    def test_missing_base_fails_instead_of_silently_skipping_a_build(self):
        with self.assertRaises(subprocess.CalledProcessError):
            release.android_changes("f" * 40)


if __name__ == "__main__":
    unittest.main()
