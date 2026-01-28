"""Tests for CLI module at src/jeeves/cli.py.

This test suite verifies that:
1. The CLI module exists at the new location
2. The CLI module can be imported
3. The CLI module exports the expected functions and classes
"""
import sys
from pathlib import Path

# Helper to load modules from src/jeeves/ path
def _load_module_from_src(module_name: str):
    """Load a module directly from src/jeeves/ path using importlib."""
    import importlib.util

    repo_root = Path(__file__).parent.parent

    if module_name == "cli":
        module_path = repo_root / "src" / "jeeves" / f"{module_name}.py"
    else:
        raise ValueError(f"Unknown module: {module_name}")

    if not module_path.exists():
        raise FileNotFoundError(f"Module not found: {module_path}")

    # Clear any cached jeeves imports
    modules_to_remove = [key for key in sys.modules.keys() if key == 'jeeves' or key.startswith('jeeves.')]
    for mod in modules_to_remove:
        del sys.modules[mod]

    spec = importlib.util.spec_from_file_location(f"jeeves.{module_name}", module_path)
    module = importlib.util.module_from_spec(spec)

    # Add src/ to path temporarily for relative imports
    src_path = str(repo_root / "src")
    original_path = sys.path.copy()
    sys.path.insert(0, src_path)

    try:
        spec.loader.exec_module(module)
    finally:
        sys.path = original_path

    return module


class TestCLIExists:
    """Tests that CLI module exists at new location."""

    def test_src_jeeves_cli_exists(self):
        """cli.py should exist at src/jeeves/cli.py."""
        repo_root = Path(__file__).parent.parent
        cli_path = repo_root / "src" / "jeeves" / "cli.py"
        assert cli_path.exists(), f"cli.py not found at {cli_path}"

    def test_old_cli_removed(self):
        """cli.py should not exist at old location jeeves/cli.py."""
        repo_root = Path(__file__).parent.parent
        old_cli_path = repo_root / "jeeves" / "cli.py"
        assert not old_cli_path.exists(), f"Old cli.py still exists at {old_cli_path}"


class TestCLIImports:
    """Tests that CLI module can be imported."""

    def test_cli_module_can_be_imported(self):
        """CLI module should be importable from src/jeeves/."""
        cli = _load_module_from_src("cli")
        assert cli is not None

    def test_cli_has_main_function(self):
        """CLI module should have a main() function."""
        cli = _load_module_from_src("cli")
        assert hasattr(cli, "main"), "CLI module missing 'main' function"
        assert callable(cli.main), "'main' should be callable"

    def test_cli_has_init_command(self):
        """CLI module should have an init command."""
        cli = _load_module_from_src("cli")
        assert hasattr(cli, "init"), "CLI module missing 'init' command"

    def test_cli_has_run_command(self):
        """CLI module should have a run command."""
        cli = _load_module_from_src("cli")
        assert hasattr(cli, "run"), "CLI module missing 'run' command"

    def test_cli_has_list_command(self):
        """CLI module should have a list_cmd command."""
        cli = _load_module_from_src("cli")
        assert hasattr(cli, "list_cmd"), "CLI module missing 'list_cmd' command"

    def test_cli_has_resume_command(self):
        """CLI module should have a resume command."""
        cli = _load_module_from_src("cli")
        assert hasattr(cli, "resume"), "CLI module missing 'resume' command"

    def test_cli_has_status_command(self):
        """CLI module should have a status command."""
        cli = _load_module_from_src("cli")
        assert hasattr(cli, "status"), "CLI module missing 'status' command"

    def test_cli_has_clean_command(self):
        """CLI module should have a clean command."""
        cli = _load_module_from_src("cli")
        assert hasattr(cli, "clean"), "CLI module missing 'clean' command"


class TestCLIUsesNewImports:
    """Tests that CLI uses jeeves.core.* imports."""

    def test_cli_uses_core_imports(self):
        """CLI should import from jeeves.core not relative imports."""
        repo_root = Path(__file__).parent.parent
        cli_path = repo_root / "src" / "jeeves" / "cli.py"

        if not cli_path.exists():
            import pytest
            pytest.skip("CLI not yet at new location")

        content = cli_path.read_text()

        # Should NOT have old relative imports
        assert "from .config import" not in content, "CLI still uses old relative import for config"
        assert "from .issue import" not in content, "CLI still uses old relative import for issue"
        assert "from .paths import" not in content, "CLI still uses old relative import for paths"
        assert "from .repo import" not in content, "CLI still uses old relative import for repo"
        assert "from .browse import" not in content, "CLI still uses old relative import for browse"
        assert "from .worktree import" not in content, "CLI still uses old relative import for worktree"

        # Should have new jeeves.core imports
        assert "from jeeves.core" in content or "from .core" in content, \
            "CLI should import from jeeves.core or .core"
