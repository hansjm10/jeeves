"""Tests for scripts directory structure."""
from pathlib import Path


def get_repo_root() -> Path:
    return Path(__file__).parent.parent


class TestScriptsDirectory:
    def test_scripts_directory_exists(self):
        repo_root = get_repo_root()
        scripts_dir = repo_root / "scripts"
        assert scripts_dir.exists(), f"scripts/ directory should exist at {scripts_dir}"
        assert scripts_dir.is_dir(), "scripts/ should be a directory"

    def test_legacy_scripts_removed(self):
        repo_root = get_repo_root()
        legacy_dir = repo_root / "scripts" / "legacy"
        assert not legacy_dir.exists(), f"legacy scripts directory should be removed: {legacy_dir}"

    def test_expected_scripts_present(self):
        repo_root = get_repo_root()
        scripts_dir = repo_root / "scripts"
        expected_scripts = [
            "create-issue-from-design-doc.sh",
            "sonarcloud-issues.sh",
        ]
        for script in expected_scripts:
            script_path = scripts_dir / script
            assert script_path.exists(), f"Script should exist at {script_path}"
            assert script_path.is_file(), f"{script} should be a file"
