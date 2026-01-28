"""Test that core modules exist in src/jeeves/core."""
import importlib.util
import sys
from pathlib import Path


def get_repo_root() -> Path:
    """Get the repository root directory."""
    return Path(__file__).parent.parent


def load_module_from_path(module_name: str, file_path: Path):
    """Load a Python module from a specific file path.

    This allows us to import modules from src/jeeves/core even when
    an older version of jeeves is installed in the environment.

    Args:
        module_name: Name to assign to the loaded module.
        file_path: Path to the .py file.

    Returns:
        The loaded module.
    """
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load module from {file_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


class TestCoreModulesExist:
    """Tests for verifying core modules are in src/jeeves/core."""

    def test_paths_module_exists(self):
        """Verify paths.py exists in src/jeeves/core."""
        repo_root = get_repo_root()
        paths_file = repo_root / "src" / "jeeves" / "core" / "paths.py"
        assert paths_file.exists(), f"paths.py should exist at {paths_file}"
        assert paths_file.is_file(), "paths.py should be a file"

    def test_repo_module_exists(self):
        """Verify repo.py exists in src/jeeves/core."""
        repo_root = get_repo_root()
        repo_file = repo_root / "src" / "jeeves" / "core" / "repo.py"
        assert repo_file.exists(), f"repo.py should exist at {repo_file}"
        assert repo_file.is_file(), "repo.py should be a file"

    def test_config_module_exists(self):
        """Verify config.py exists in src/jeeves/core."""
        repo_root = get_repo_root()
        config_file = repo_root / "src" / "jeeves" / "core" / "config.py"
        assert config_file.exists(), f"config.py should exist at {config_file}"
        assert config_file.is_file(), "config.py should be a file"

    def test_issue_module_exists(self):
        """Verify issue.py exists in src/jeeves/core."""
        repo_root = get_repo_root()
        issue_file = repo_root / "src" / "jeeves" / "core" / "issue.py"
        assert issue_file.exists(), f"issue.py should exist at {issue_file}"
        assert issue_file.is_file(), "issue.py should be a file"

    def test_browse_module_exists(self):
        """Verify browse.py exists in src/jeeves/core."""
        repo_root = get_repo_root()
        browse_file = repo_root / "src" / "jeeves" / "core" / "browse.py"
        assert browse_file.exists(), f"browse.py should exist at {browse_file}"
        assert browse_file.is_file(), "browse.py should be a file"

    def test_worktree_module_exists(self):
        """Verify worktree.py exists in src/jeeves/core."""
        repo_root = get_repo_root()
        worktree_file = repo_root / "src" / "jeeves" / "core" / "worktree.py"
        assert worktree_file.exists(), f"worktree.py should exist at {worktree_file}"
        assert worktree_file.is_file(), "worktree.py should be a file"


class TestCoreModulesImportable:
    """Tests for verifying core modules can be loaded and have expected attributes.

    These tests use importlib to load modules directly from src/jeeves/core,
    bypassing any installed jeeves package. This is necessary during the
    transition from flat layout to src/ layout.
    """

    def test_paths_importable(self):
        """Verify paths module can be loaded and has expected functions."""
        repo_root = get_repo_root()
        core_dir = repo_root / "src" / "jeeves" / "core"

        paths = load_module_from_path("jeeves.core.paths", core_dir / "paths.py")

        assert hasattr(paths, 'get_data_dir'), "paths should have get_data_dir"
        assert hasattr(paths, 'get_repo_path'), "paths should have get_repo_path"
        assert hasattr(paths, 'get_worktree_path'), "paths should have get_worktree_path"
        assert hasattr(paths, 'ensure_directory'), "paths should have ensure_directory"
        assert hasattr(paths, 'parse_repo_spec'), "paths should have parse_repo_spec"

    def test_repo_importable(self):
        """Verify repo module can be loaded and has expected classes/functions."""
        repo_root = get_repo_root()
        core_dir = repo_root / "src" / "jeeves" / "core"

        # Load paths first as repo depends on it
        load_module_from_path("jeeves.core.paths", core_dir / "paths.py")
        repo = load_module_from_path("jeeves.core.repo", core_dir / "repo.py")

        assert hasattr(repo, 'RepoError'), "repo should have RepoError"
        assert hasattr(repo, 'run_git'), "repo should have run_git"
        assert hasattr(repo, 'run_gh'), "repo should have run_gh"
        assert hasattr(repo, 'ensure_repo'), "repo should have ensure_repo"

    def test_config_importable(self):
        """Verify config module can be loaded and has expected classes."""
        repo_root = get_repo_root()
        core_dir = repo_root / "src" / "jeeves" / "core"

        # Load paths first as config depends on it
        load_module_from_path("jeeves.core.paths", core_dir / "paths.py")
        config = load_module_from_path("jeeves.core.config", core_dir / "config.py")

        assert hasattr(config, 'GlobalConfig'), "config should have GlobalConfig"

    def test_issue_importable(self):
        """Verify issue module can be loaded and has expected classes."""
        repo_root = get_repo_root()
        core_dir = repo_root / "src" / "jeeves" / "core"

        # Load dependencies first
        load_module_from_path("jeeves.core.paths", core_dir / "paths.py")
        load_module_from_path("jeeves.core.repo", core_dir / "repo.py")
        issue = load_module_from_path("jeeves.core.issue", core_dir / "issue.py")

        assert hasattr(issue, 'IssueError'), "issue should have IssueError"
        assert hasattr(issue, 'IssueState'), "issue should have IssueState"
        assert hasattr(issue, 'IssueStatus'), "issue should have IssueStatus"

    def test_browse_importable(self):
        """Verify browse module can be loaded and has expected functions."""
        repo_root = get_repo_root()
        core_dir = repo_root / "src" / "jeeves" / "core"

        # Load dependencies first
        load_module_from_path("jeeves.core.paths", core_dir / "paths.py")
        load_module_from_path("jeeves.core.repo", core_dir / "repo.py")
        load_module_from_path("jeeves.core.issue", core_dir / "issue.py")
        browse = load_module_from_path("jeeves.core.browse", core_dir / "browse.py")

        assert hasattr(browse, 'BrowseError'), "browse should have BrowseError"
        assert hasattr(browse, 'select_repository'), "browse should have select_repository"
        assert hasattr(browse, 'select_issue'), "browse should have select_issue"

    def test_worktree_importable(self):
        """Verify worktree module can be loaded and has expected functions."""
        repo_root = get_repo_root()
        core_dir = repo_root / "src" / "jeeves" / "core"

        # Load dependencies first
        load_module_from_path("jeeves.core.paths", core_dir / "paths.py")
        load_module_from_path("jeeves.core.repo", core_dir / "repo.py")
        worktree = load_module_from_path("jeeves.core.worktree", core_dir / "worktree.py")

        assert hasattr(worktree, 'WorktreeError'), "worktree should have WorktreeError"
        assert hasattr(worktree, 'create_worktree'), "worktree should have create_worktree"
        assert hasattr(worktree, 'remove_worktree'), "worktree should have remove_worktree"
