"""Test that shell scripts are moved to the scripts/ directory."""
import os
from pathlib import Path


def get_repo_root() -> Path:
    """Get the repository root directory."""
    return Path(__file__).parent.parent


class TestScriptsDirectory:
    """Tests for verifying the scripts/ directory structure."""

    def test_scripts_directory_exists(self):
        """Verify scripts/ directory exists."""
        repo_root = get_repo_root()
        scripts_dir = repo_root / "scripts"
        assert scripts_dir.exists(), f"scripts/ directory should exist at {scripts_dir}"
        assert scripts_dir.is_dir(), "scripts/ should be a directory"

    def test_scripts_legacy_directory_exists(self):
        """Verify scripts/legacy/ directory exists."""
        repo_root = get_repo_root()
        legacy_dir = repo_root / "scripts" / "legacy"
        assert legacy_dir.exists(), f"scripts/legacy/ directory should exist at {legacy_dir}"
        assert legacy_dir.is_dir(), "scripts/legacy/ should be a directory"

    def test_helper_scripts_moved_to_scripts(self):
        """Verify helper scripts are moved to scripts/ directory."""
        repo_root = get_repo_root()
        scripts_dir = repo_root / "scripts"

        expected_scripts = [
            "init-issue.sh",
            "create-issue-from-design-doc.sh",
            "sonarcloud-issues.sh",
        ]

        for script in expected_scripts:
            script_path = scripts_dir / script
            assert script_path.exists(), f"Script should exist at {script_path}"
            assert script_path.is_file(), f"{script} should be a file"

    def test_legacy_scripts_moved_to_scripts_legacy(self):
        """Verify legacy scripts are moved to scripts/legacy/ directory."""
        repo_root = get_repo_root()
        legacy_dir = repo_root / "scripts" / "legacy"

        expected_legacy_scripts = [
            "jeeves.sh",
            "jeeves.test.sh",
        ]

        for script in expected_legacy_scripts:
            script_path = legacy_dir / script
            assert script_path.exists(), f"Legacy script should exist at {script_path}"
            assert script_path.is_file(), f"{script} should be a file"

    def test_old_scripts_removed_from_root(self):
        """Verify old scripts no longer exist at root."""
        repo_root = get_repo_root()

        old_scripts = [
            "init-issue.sh",
            "create-issue-from-design-doc.sh",
            "sonarcloud-issues.sh",
            "jeeves.sh",
            "jeeves.test.sh",
        ]

        for old_script in old_scripts:
            script_path = repo_root / old_script
            assert not script_path.exists(), f"Old script should not exist at {script_path}"

    def test_scripts_are_executable(self):
        """Verify scripts remain executable after move."""
        repo_root = get_repo_root()
        scripts_dir = repo_root / "scripts"
        legacy_dir = scripts_dir / "legacy"

        executable_scripts = [
            scripts_dir / "init-issue.sh",
            scripts_dir / "create-issue-from-design-doc.sh",
            scripts_dir / "sonarcloud-issues.sh",
            legacy_dir / "jeeves.sh",
        ]

        for script_path in executable_scripts:
            if script_path.exists():
                # Check if file has execute permission
                is_executable = os.access(script_path, os.X_OK)
                assert is_executable, f"Script {script_path} should be executable"
