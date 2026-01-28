"""
Integration tests for T12: Validate and integration test.

This module validates the repository reorganization by testing:
1. All package imports work correctly
2. CLI commands are functional
3. No import errors anywhere in the codebase
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest

# Get the repo root and src directory for PYTHONPATH
REPO_ROOT = Path(__file__).parent.parent
SRC_DIR = REPO_ROOT / "src"


def run_python_cmd(code: str) -> subprocess.CompletedProcess:
    """Run a Python command with src/ in PYTHONPATH."""
    env = os.environ.copy()
    env["PYTHONPATH"] = str(SRC_DIR)
    return subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        env=env,
    )


def run_module_cmd(module: str, *args: str) -> subprocess.CompletedProcess:
    """Run a Python module with src/ in PYTHONPATH."""
    env = os.environ.copy()
    env["PYTHONPATH"] = str(SRC_DIR)
    return subprocess.run(
        [sys.executable, "-m", module, *args],
        capture_output=True,
        text=True,
        env=env,
    )


class TestPackageImports:
    """Test that all package imports work correctly after reorganization."""

    def test_import_jeeves_package(self):
        """Verify 'import jeeves' succeeds."""
        result = run_python_cmd("import jeeves")
        assert result.returncode == 0, f"Failed to import jeeves: {result.stderr}"

    def test_import_jeeves_core(self):
        """Verify 'import jeeves.core' succeeds."""
        result = run_python_cmd("import jeeves.core")
        assert result.returncode == 0, f"Failed to import jeeves.core: {result.stderr}"

    def test_import_jeeves_core_modules(self):
        """Verify all core modules can be imported."""
        modules = [
            "jeeves.core.browse",
            "jeeves.core.config",
            "jeeves.core.issue",
            "jeeves.core.paths",
            "jeeves.core.repo",
            "jeeves.core.worktree",
        ]
        for module in modules:
            result = run_python_cmd(f"import {module}")
            assert result.returncode == 0, f"Failed to import {module}: {result.stderr}"

    def test_import_jeeves_runner(self):
        """Verify 'import jeeves.runner' succeeds."""
        result = run_python_cmd("import jeeves.runner")
        assert result.returncode == 0, f"Failed to import jeeves.runner: {result.stderr}"

    def test_import_jeeves_runner_providers(self):
        """Verify runner provider modules can be imported."""
        result = run_python_cmd("import jeeves.runner.providers")
        assert result.returncode == 0, f"Failed to import jeeves.runner.providers: {result.stderr}"

    def test_import_jeeves_viewer(self):
        """Verify 'import jeeves.viewer' succeeds."""
        result = run_python_cmd("import jeeves.viewer")
        assert result.returncode == 0, f"Failed to import jeeves.viewer: {result.stderr}"

    def test_import_jeeves_cli(self):
        """Verify 'import jeeves.cli' succeeds."""
        result = run_python_cmd("import jeeves.cli")
        assert result.returncode == 0, f"Failed to import jeeves.cli: {result.stderr}"


class TestCLIFunctionality:
    """Test that CLI commands work correctly after reorganization."""

    def test_jeeves_help(self):
        """Verify 'jeeves --help' works."""
        result = run_module_cmd("jeeves.cli", "--help")
        assert result.returncode == 0, f"jeeves --help failed: {result.stderr}"
        assert "Usage:" in result.stdout or "usage:" in result.stdout.lower()

    def test_jeeves_version(self):
        """Verify 'jeeves --version' works."""
        result = run_module_cmd("jeeves.cli", "--version")
        # Version might be in stdout or stderr depending on click version
        output = result.stdout + result.stderr
        assert "0.1.0" in output or result.returncode == 0

    def test_jeeves_init_help(self):
        """Verify 'jeeves init --help' works."""
        result = run_module_cmd("jeeves.cli", "init", "--help")
        assert result.returncode == 0, f"jeeves init --help failed: {result.stderr}"

    def test_jeeves_run_help(self):
        """Verify 'jeeves run --help' works."""
        result = run_module_cmd("jeeves.cli", "run", "--help")
        assert result.returncode == 0, f"jeeves run --help failed: {result.stderr}"

    def test_jeeves_list_help(self):
        """Verify 'jeeves list --help' works."""
        result = run_module_cmd("jeeves.cli", "list", "--help")
        assert result.returncode == 0, f"jeeves list --help failed: {result.stderr}"

    def test_jeeves_status_help(self):
        """Verify 'jeeves status --help' works."""
        result = run_module_cmd("jeeves.cli", "status", "--help")
        assert result.returncode == 0, f"jeeves status --help failed: {result.stderr}"


class TestDirectoryStructure:
    """Test that directory structure matches design doc specification."""

    @pytest.fixture
    def repo_root(self):
        """Get repository root directory."""
        return REPO_ROOT

    def test_src_jeeves_exists(self, repo_root):
        """Verify src/jeeves/ directory exists."""
        assert (repo_root / "src" / "jeeves").is_dir()

    def test_src_jeeves_core_exists(self, repo_root):
        """Verify src/jeeves/core/ directory exists."""
        assert (repo_root / "src" / "jeeves" / "core").is_dir()

    def test_src_jeeves_runner_exists(self, repo_root):
        """Verify src/jeeves/runner/ directory exists."""
        assert (repo_root / "src" / "jeeves" / "runner").is_dir()

    def test_src_jeeves_viewer_exists(self, repo_root):
        """Verify src/jeeves/viewer/ directory exists."""
        assert (repo_root / "src" / "jeeves" / "viewer").is_dir()

    def test_prompts_directory_exists(self, repo_root):
        """Verify prompts/ directory exists."""
        assert (repo_root / "prompts").is_dir()

    def test_scripts_directory_exists(self, repo_root):
        """Verify scripts/ directory exists."""
        assert (repo_root / "scripts").is_dir()

    def test_tests_directory_exists(self, repo_root):
        """Verify tests/ directory exists."""
        assert (repo_root / "tests").is_dir()

    def test_examples_directory_exists(self, repo_root):
        """Verify examples/ directory exists."""
        assert (repo_root / "examples").is_dir()

    def test_old_jeeves_directory_removed(self, repo_root):
        """Verify old jeeves/ directory at root is removed."""
        # There should NOT be a jeeves/ directory at root (only src/jeeves/)
        old_jeeves = repo_root / "jeeves"
        assert not old_jeeves.exists(), f"Old jeeves/ directory should be removed: {old_jeeves}"


class TestNoImportErrors:
    """Test that there are no import errors anywhere in the codebase."""

    def test_all_python_files_parse(self):
        """Verify all Python files in src/ can be parsed without syntax errors."""
        src_dir = SRC_DIR

        python_files = list(src_dir.rglob("*.py"))
        assert len(python_files) > 0, "No Python files found in src/"

        for py_file in python_files:
            result = subprocess.run(
                [sys.executable, "-m", "py_compile", str(py_file)],
                capture_output=True,
                text=True,
            )
            assert result.returncode == 0, f"Syntax error in {py_file}: {result.stderr}"

    def test_all_test_files_parse(self):
        """Verify all Python files in tests/ can be parsed without syntax errors."""
        tests_dir = REPO_ROOT / "tests"

        python_files = list(tests_dir.rglob("*.py"))
        assert len(python_files) > 0, "No Python files found in tests/"

        for py_file in python_files:
            result = subprocess.run(
                [sys.executable, "-m", "py_compile", str(py_file)],
                capture_output=True,
                text=True,
            )
            assert result.returncode == 0, f"Syntax error in {py_file}: {result.stderr}"


class TestModuleAttributes:
    """Test that imported modules have expected attributes."""

    def test_jeeves_core_browse_has_functions(self):
        """Verify jeeves.core.browse has expected functions."""
        result = run_python_cmd(
            "from jeeves.core.browse import select_repository, select_issue; print('OK')"
        )
        assert result.returncode == 0, f"Missing functions in browse: {result.stderr}"
        assert "OK" in result.stdout

    def test_jeeves_core_issue_has_functions(self):
        """Verify jeeves.core.issue has expected functions."""
        result = run_python_cmd(
            "from jeeves.core.issue import create_issue_state, fetch_issue_metadata, list_issues; print('OK')"
        )
        assert result.returncode == 0, f"Missing functions in issue: {result.stderr}"
        assert "OK" in result.stdout

    def test_jeeves_core_repo_has_functions(self):
        """Verify jeeves.core.repo has expected functions."""
        result = run_python_cmd(
            "from jeeves.core.repo import ensure_repo, clone_repo, run_git; print('OK')"
        )
        assert result.returncode == 0, f"Missing functions in repo: {result.stderr}"
        assert "OK" in result.stdout

    def test_jeeves_cli_has_commands(self):
        """Verify jeeves.cli has expected click commands."""
        result = run_python_cmd(
            "from jeeves.cli import main, init, run, list_cmd, status, clean; print('OK')"
        )
        assert result.returncode == 0, f"Missing commands in cli: {result.stderr}"
        assert "OK" in result.stdout


class TestDirectImports:
    """Test direct Python imports (not subprocess) to verify sys.path setup."""

    def test_direct_import_jeeves(self):
        """Verify jeeves can be imported directly."""
        import jeeves
        assert hasattr(jeeves, "__version__")

    def test_direct_import_jeeves_core(self):
        """Verify jeeves.core can be imported directly."""
        from jeeves import core
        assert hasattr(core, "browse")
        assert hasattr(core, "config")
        assert hasattr(core, "issue")
        assert hasattr(core, "paths")
        assert hasattr(core, "repo")
        assert hasattr(core, "worktree")

    def test_direct_import_jeeves_core_browse(self):
        """Verify jeeves.core.browse functions are accessible."""
        from jeeves.core.browse import select_repository, select_issue
        assert callable(select_repository)
        assert callable(select_issue)

    def test_direct_import_jeeves_core_issue(self):
        """Verify jeeves.core.issue functions are accessible."""
        from jeeves.core.issue import create_issue_state, fetch_issue_metadata, list_issues
        assert callable(create_issue_state)
        assert callable(fetch_issue_metadata)
        assert callable(list_issues)

    def test_direct_import_jeeves_runner(self):
        """Verify jeeves.runner can be imported."""
        import jeeves.runner
        assert jeeves.runner is not None

    def test_direct_import_jeeves_viewer(self):
        """Verify jeeves.viewer can be imported."""
        import jeeves.viewer
        assert jeeves.viewer is not None

    def test_direct_import_jeeves_cli(self):
        """Verify jeeves.cli commands are accessible."""
        from jeeves.cli import main, init, run, list_cmd, status, clean
        assert callable(main)
        assert callable(init)
        assert callable(run)
        assert callable(list_cmd)
        assert callable(status)
        assert callable(clean)
