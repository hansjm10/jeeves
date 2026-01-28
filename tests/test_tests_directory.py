"""Tests for verifying test files are consolidated in tests/ directory."""

from pathlib import Path


def get_repo_root() -> Path:
    return Path(__file__).parent.parent


class TestTestsDirectoryStructure:
    def test_tests_directory_exists(self):
        repo_root = get_repo_root()
        tests_dir = repo_root / "tests"
        assert tests_dir.exists(), f"tests/ directory should exist at {tests_dir}"
        assert tests_dir.is_dir(), "tests/ should be a directory"

    def test_tests_init_exists(self):
        repo_root = get_repo_root()
        init_file = repo_root / "tests" / "__init__.py"
        assert init_file.exists(), f"tests/__init__.py should exist at {init_file}"

    def test_all_tests_in_tests_directory(self):
        repo_root = get_repo_root()
        tests_dir = repo_root / "tests"

        expected_test_files = [
            "test_browse.py",
            "test_core_modules.py",
            "test_documentation.py",
            "test_examples_directory.py",
            "test_issue.py",
            "test_prompts_directory.py",
            "test_pyproject_config.py",
            "test_recent.py",
            "test_repo.py",
            "test_runner_modules.py",
            "test_scripts_directory.py",
            "test_server.py",
            "test_structure.py",
            "test_tests_directory.py",
            "test_viewer_modules.py",
        ]

        for test_file in expected_test_files:
            file_path = tests_dir / test_file
            assert file_path.exists(), f"{test_file} should exist in tests/"
