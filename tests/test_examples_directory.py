"""Tests for T9: Move examples and clean root directory.

This module verifies:
1. examples/ directory exists
2. issue.json.example moved to examples/
3. State files removed from root (not tracked)
4. Root directory contains only essential files
"""

from pathlib import Path


def get_repo_root() -> Path:
    """Get the repository root directory."""
    return Path(__file__).parent.parent


class TestExamplesDirectory:
    """Test examples/ directory structure."""

    def test_examples_directory_exists(self) -> None:
        """Verify examples/ directory exists at repo root."""
        repo_root = get_repo_root()
        examples_dir = repo_root / "examples"
        assert examples_dir.is_dir(), f"examples/ directory not found at {examples_dir}"

    def test_issue_json_example_moved(self) -> None:
        """Verify issue.json.example is in examples/ directory."""
        repo_root = get_repo_root()
        example_file = repo_root / "examples" / "issue.json.example"
        assert example_file.is_file(), f"issue.json.example not found at {example_file}"


class TestRootDirectoryCleaned:
    """Test root directory is cleaned of state files."""

    def test_issue_json_example_removed_from_root(self) -> None:
        """Verify issue.json.example is removed from root."""
        repo_root = get_repo_root()
        old_file = repo_root / "issue.json.example"
        assert not old_file.exists(), f"issue.json.example should be removed from root: {old_file}"

    def test_last_run_log_removed_from_root(self) -> None:
        """Verify last-run.log is removed from root (should be gitignored)."""
        repo_root = get_repo_root()
        old_file = repo_root / "last-run.log"
        # File may exist but should not be tracked by git
        # This test verifies the file doesn't exist in a fresh checkout
        assert not old_file.exists(), f"last-run.log should be removed from root: {old_file}"

    def test_metrics_jsonl_removed_from_root(self) -> None:
        """Verify metrics.jsonl is removed from root (should be gitignored)."""
        repo_root = get_repo_root()
        old_file = repo_root / "metrics.jsonl"
        assert not old_file.exists(), f"metrics.jsonl should be removed from root: {old_file}"

    def test_task_files_removed_from_root(self) -> None:
        """Verify task-*.md files are removed from root."""
        repo_root = get_repo_root()
        task_files = [
            "task-issues.md",
            "task-quality-review.md",
            "task-spec-review.md",
        ]
        for task_file in task_files:
            old_file = repo_root / task_file
            assert not old_file.exists(), f"{task_file} should be removed from root: {old_file}"


class TestJeevesPackageDirectoryCleaned:
    """Test old jeeves/ package directory is cleaned."""

    def test_state_files_removed_from_jeeves_dir(self) -> None:
        """Verify state files are removed from jeeves/ directory."""
        repo_root = get_repo_root()
        jeeves_dir = repo_root / "jeeves"

        if not jeeves_dir.exists():
            # If jeeves/ directory no longer exists, test passes
            return

        state_files = [
            "last-run.log",
            "metrics.jsonl",
            "current-run.json",
            "viewer-run.log",
        ]
        for state_file in state_files:
            old_file = jeeves_dir / state_file
            assert not old_file.exists(), f"{state_file} should be removed from jeeves/: {old_file}"


class TestViewerDirectoryCleaned:
    """Test old viewer/ directory is cleaned."""

    def test_viewer_readme_can_be_removed(self) -> None:
        """Verify viewer/ README.md can be safely removed since viewer is now in src/."""
        repo_root = get_repo_root()
        viewer_dir = repo_root / "viewer"

        if not viewer_dir.exists():
            # If viewer/ directory no longer exists, test passes (ideal state)
            return

        # Check that only README.md remains (will be removed in this task)
        remaining_files = list(viewer_dir.iterdir())
        # Filter out __pycache__ and other non-essential files
        essential_files = [f for f in remaining_files if not f.name.startswith(('.', '__'))]

        # At most README.md should remain (and will be removed)
        assert len(essential_files) <= 1, f"Unexpected files in viewer/: {essential_files}"
        if essential_files:
            assert essential_files[0].name == "README.md", f"Only README.md expected, found: {essential_files}"


class TestRootContainsOnlyEssentialFiles:
    """Test root directory contains only essential files per design doc."""

    def test_root_essential_files_present(self) -> None:
        """Verify essential files are still present at root."""
        repo_root = get_repo_root()
        essential_files = [
            "README.md",
            "LICENSE",
            "pyproject.toml",
            "CLAUDE.md",
            "AGENTS.md",
        ]
        for essential_file in essential_files:
            file_path = repo_root / essential_file
            assert file_path.is_file(), f"Essential file {essential_file} missing from root"

    def test_root_essential_directories_present(self) -> None:
        """Verify essential directories are present at root."""
        repo_root = get_repo_root()
        essential_dirs = [
            "src",
            "tests",
            "prompts",
            "scripts",
            "docs",
            "examples",  # New directory from this task
            "skills",
        ]
        for essential_dir in essential_dirs:
            dir_path = repo_root / essential_dir
            assert dir_path.is_dir(), f"Essential directory {essential_dir} missing from root"
