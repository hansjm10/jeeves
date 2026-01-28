"""Test that the repository structure is set up correctly."""
import os
from pathlib import Path


def get_repo_root() -> Path:
    """Get the repository root directory."""
    return Path(__file__).parent.parent


class TestDirectoryStructure:
    """Tests for verifying the src/jeeves directory structure."""

    def test_src_directory_exists(self):
        """Verify src/ directory exists."""
        repo_root = get_repo_root()
        src_dir = repo_root / "src"
        assert src_dir.exists(), f"src/ directory should exist at {src_dir}"
        assert src_dir.is_dir(), "src/ should be a directory"

    def test_src_jeeves_directory_exists(self):
        """Verify src/jeeves/ directory exists."""
        repo_root = get_repo_root()
        jeeves_dir = repo_root / "src" / "jeeves"
        assert jeeves_dir.exists(), f"src/jeeves/ directory should exist at {jeeves_dir}"
        assert jeeves_dir.is_dir(), "src/jeeves/ should be a directory"

    def test_src_jeeves_init_file_exists(self):
        """Verify src/jeeves/__init__.py exists."""
        repo_root = get_repo_root()
        init_file = repo_root / "src" / "jeeves" / "__init__.py"
        assert init_file.exists(), f"src/jeeves/__init__.py should exist at {init_file}"
        assert init_file.is_file(), "src/jeeves/__init__.py should be a file"

    def test_src_jeeves_core_directory_exists(self):
        """Verify src/jeeves/core/ directory exists."""
        repo_root = get_repo_root()
        core_dir = repo_root / "src" / "jeeves" / "core"
        assert core_dir.exists(), f"src/jeeves/core/ directory should exist at {core_dir}"
        assert core_dir.is_dir(), "src/jeeves/core/ should be a directory"

    def test_src_jeeves_core_init_file_exists(self):
        """Verify src/jeeves/core/__init__.py exists."""
        repo_root = get_repo_root()
        init_file = repo_root / "src" / "jeeves" / "core" / "__init__.py"
        assert init_file.exists(), f"src/jeeves/core/__init__.py should exist at {init_file}"
        assert init_file.is_file(), "src/jeeves/core/__init__.py should be a file"
