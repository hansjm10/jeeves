"""Tests for verifying test files are consolidated in tests/ directory."""

from pathlib import Path


def get_repo_root() -> Path:
    """Get the repository root directory."""
    return Path(__file__).parent.parent


class TestTestsDirectoryStructure:
    """Tests for verifying tests directory contains all test files."""

    def test_tests_directory_exists(self):
        """Verify tests/ directory exists."""
        repo_root = get_repo_root()
        tests_dir = repo_root / "tests"
        assert tests_dir.exists(), f"tests/ directory should exist at {tests_dir}"
        assert tests_dir.is_dir(), "tests/ should be a directory"

    def test_tests_init_exists(self):
        """Verify tests/__init__.py exists."""
        repo_root = get_repo_root()
        init_file = repo_root / "tests" / "__init__.py"
        assert init_file.exists(), f"tests/__init__.py should exist at {init_file}"

    def test_browse_tests_moved(self):
        """Verify test_browse.py moved from jeeves/ to tests/."""
        repo_root = get_repo_root()
        # Test file should be in tests/
        new_location = repo_root / "tests" / "test_browse.py"
        assert new_location.exists(), f"test_browse.py should be at {new_location}"
        # Old location should not exist
        old_location = repo_root / "jeeves" / "test_browse.py"
        assert not old_location.exists(), f"test_browse.py should not exist at old location {old_location}"

    def test_browse_integration_tests_moved(self):
        """Verify test_browse_integration.py moved from jeeves/ to tests/."""
        repo_root = get_repo_root()
        new_location = repo_root / "tests" / "test_browse_integration.py"
        assert new_location.exists(), f"test_browse_integration.py should be at {new_location}"
        old_location = repo_root / "jeeves" / "test_browse_integration.py"
        assert not old_location.exists(), f"test_browse_integration.py should not exist at {old_location}"

    def test_cli_browse_tests_moved(self):
        """Verify test_cli_browse.py moved from jeeves/ to tests/."""
        repo_root = get_repo_root()
        new_location = repo_root / "tests" / "test_cli_browse.py"
        assert new_location.exists(), f"test_cli_browse.py should be at {new_location}"
        old_location = repo_root / "jeeves" / "test_cli_browse.py"
        assert not old_location.exists(), f"test_cli_browse.py should not exist at {old_location}"

    def test_issue_tests_moved(self):
        """Verify test_issue.py moved from jeeves/ to tests/."""
        repo_root = get_repo_root()
        new_location = repo_root / "tests" / "test_issue.py"
        assert new_location.exists(), f"test_issue.py should be at {new_location}"
        old_location = repo_root / "jeeves" / "test_issue.py"
        assert not old_location.exists(), f"test_issue.py should not exist at {old_location}"

    def test_recent_tests_moved(self):
        """Verify test_recent.py moved from jeeves/ to tests/."""
        repo_root = get_repo_root()
        new_location = repo_root / "tests" / "test_recent.py"
        assert new_location.exists(), f"test_recent.py should be at {new_location}"
        old_location = repo_root / "jeeves" / "test_recent.py"
        assert not old_location.exists(), f"test_recent.py should not exist at {old_location}"

    def test_repo_tests_moved(self):
        """Verify test_repo.py moved from jeeves/ to tests/."""
        repo_root = get_repo_root()
        new_location = repo_root / "tests" / "test_repo.py"
        assert new_location.exists(), f"test_repo.py should be at {new_location}"
        old_location = repo_root / "jeeves" / "test_repo.py"
        assert not old_location.exists(), f"test_repo.py should not exist at {old_location}"

    def test_server_tests_moved(self):
        """Verify test_server.py moved from viewer/ to tests/."""
        repo_root = get_repo_root()
        new_location = repo_root / "tests" / "test_server.py"
        assert new_location.exists(), f"test_server.py should be at {new_location}"
        old_location = repo_root / "viewer" / "test_server.py"
        assert not old_location.exists(), f"test_server.py should not exist at {old_location}"

    def test_old_jeeves_test_files_removed(self):
        """Verify no test_*.py files remain in jeeves/ directory."""
        repo_root = get_repo_root()
        jeeves_dir = repo_root / "jeeves"
        if jeeves_dir.exists():
            test_files = list(jeeves_dir.glob("test_*.py"))
            assert len(test_files) == 0, f"No test files should remain in jeeves/: {test_files}"

    def test_old_viewer_test_files_removed(self):
        """Verify no test_*.py files remain in viewer/ directory."""
        repo_root = get_repo_root()
        viewer_dir = repo_root / "viewer"
        if viewer_dir.exists():
            test_files = list(viewer_dir.glob("test_*.py"))
            assert len(test_files) == 0, f"No test files should remain in viewer/: {test_files}"

    def test_all_tests_in_tests_directory(self):
        """Verify tests/ directory contains expected test files."""
        repo_root = get_repo_root()
        tests_dir = repo_root / "tests"

        # Test files that should exist after move
        expected_test_files = [
            # Moved from jeeves/
            "test_browse.py",
            "test_browse_integration.py",
            "test_cli_browse.py",
            "test_issue.py",
            "test_recent.py",
            "test_repo.py",
            # Moved from viewer/
            "test_server.py",
            # Already in tests/
            "test_cli_modules.py",
            "test_core_modules.py",
            "test_prompts_directory.py",
            "test_runner_modules.py",
            "test_scripts_directory.py",
            "test_structure.py",
            "test_viewer_modules.py",
            "test_tests_directory.py",  # This test file itself
        ]

        for test_file in expected_test_files:
            file_path = tests_dir / test_file
            assert file_path.exists(), f"{test_file} should exist in tests/"
