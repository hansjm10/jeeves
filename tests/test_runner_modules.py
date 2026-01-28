"""Test that runner modules exist in src/jeeves/runner."""
import importlib.util
import sys
from pathlib import Path


def get_repo_root() -> Path:
    """Get the repository root directory."""
    return Path(__file__).parent.parent


def load_module_from_path(module_name: str, file_path: Path):
    """Load a Python module from a specific file path.

    This allows us to import modules from src/jeeves/runner even when
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


class TestRunnerStructureExists:
    """Tests for verifying runner directory structure in src/jeeves/runner."""

    def test_runner_directory_exists(self):
        """Verify src/jeeves/runner directory exists."""
        repo_root = get_repo_root()
        runner_dir = repo_root / "src" / "jeeves" / "runner"
        assert runner_dir.exists(), f"runner directory should exist at {runner_dir}"
        assert runner_dir.is_dir(), "runner should be a directory"

    def test_runner_init_exists(self):
        """Verify runner __init__.py exists."""
        repo_root = get_repo_root()
        init_file = repo_root / "src" / "jeeves" / "runner" / "__init__.py"
        assert init_file.exists(), f"__init__.py should exist at {init_file}"
        assert init_file.is_file(), "__init__.py should be a file"

    def test_runner_config_exists(self):
        """Verify runner config.py exists."""
        repo_root = get_repo_root()
        config_file = repo_root / "src" / "jeeves" / "runner" / "config.py"
        assert config_file.exists(), f"config.py should exist at {config_file}"
        assert config_file.is_file(), "config.py should be a file"

    def test_runner_output_exists(self):
        """Verify runner output.py exists."""
        repo_root = get_repo_root()
        output_file = repo_root / "src" / "jeeves" / "runner" / "output.py"
        assert output_file.exists(), f"output.py should exist at {output_file}"
        assert output_file.is_file(), "output.py should be a file"

    def test_runner_sdk_runner_exists(self):
        """Verify runner sdk_runner.py exists."""
        repo_root = get_repo_root()
        sdk_runner_file = repo_root / "src" / "jeeves" / "runner" / "sdk_runner.py"
        assert sdk_runner_file.exists(), f"sdk_runner.py should exist at {sdk_runner_file}"
        assert sdk_runner_file.is_file(), "sdk_runner.py should be a file"

    def test_providers_directory_exists(self):
        """Verify src/jeeves/runner/providers directory exists."""
        repo_root = get_repo_root()
        providers_dir = repo_root / "src" / "jeeves" / "runner" / "providers"
        assert providers_dir.exists(), f"providers directory should exist at {providers_dir}"
        assert providers_dir.is_dir(), "providers should be a directory"

    def test_providers_init_exists(self):
        """Verify providers __init__.py exists."""
        repo_root = get_repo_root()
        init_file = repo_root / "src" / "jeeves" / "runner" / "providers" / "__init__.py"
        assert init_file.exists(), f"__init__.py should exist at {init_file}"
        assert init_file.is_file(), "__init__.py should be a file"

    def test_providers_base_exists(self):
        """Verify providers base.py exists."""
        repo_root = get_repo_root()
        base_file = repo_root / "src" / "jeeves" / "runner" / "providers" / "base.py"
        assert base_file.exists(), f"base.py should exist at {base_file}"
        assert base_file.is_file(), "base.py should be a file"

    def test_providers_claude_sdk_exists(self):
        """Verify providers claude_sdk.py exists."""
        repo_root = get_repo_root()
        claude_sdk_file = repo_root / "src" / "jeeves" / "runner" / "providers" / "claude_sdk.py"
        assert claude_sdk_file.exists(), f"claude_sdk.py should exist at {claude_sdk_file}"
        assert claude_sdk_file.is_file(), "claude_sdk.py should be a file"


class TestRunnerModulesImportable:
    """Tests for verifying runner modules can be loaded and have expected attributes.

    These tests use importlib to load modules directly from src/jeeves/runner,
    bypassing any installed jeeves package.
    """

    def test_runner_config_importable(self):
        """Verify runner config module can be loaded and has expected classes."""
        repo_root = get_repo_root()
        runner_dir = repo_root / "src" / "jeeves" / "runner"

        config = load_module_from_path("jeeves.runner.config", runner_dir / "config.py")

        assert hasattr(config, 'RunnerConfig'), "config should have RunnerConfig"

    def test_runner_output_importable(self):
        """Verify runner output module can be loaded and has expected classes."""
        repo_root = get_repo_root()
        runner_dir = repo_root / "src" / "jeeves" / "runner"

        output = load_module_from_path("jeeves.runner.output", runner_dir / "output.py")

        assert hasattr(output, 'ToolCall'), "output should have ToolCall"
        assert hasattr(output, 'Message'), "output should have Message"
        assert hasattr(output, 'SDKOutput'), "output should have SDKOutput"
        assert hasattr(output, 'create_output'), "output should have create_output"

    def test_providers_base_importable(self):
        """Verify providers base module can be loaded and has expected classes."""
        repo_root = get_repo_root()
        runner_dir = repo_root / "src" / "jeeves" / "runner"

        # First load output since base depends on it
        load_module_from_path("jeeves.runner.output", runner_dir / "output.py")
        base = load_module_from_path("jeeves.runner.providers.base", runner_dir / "providers" / "base.py")

        assert hasattr(base, 'OutputProvider'), "base should have OutputProvider"

    def test_providers_claude_sdk_importable(self):
        """Verify providers claude_sdk module can be loaded and has expected classes."""
        repo_root = get_repo_root()
        runner_dir = repo_root / "src" / "jeeves" / "runner"

        # First load dependencies
        load_module_from_path("jeeves.runner.output", runner_dir / "output.py")
        load_module_from_path("jeeves.runner.providers.base", runner_dir / "providers" / "base.py")
        claude_sdk = load_module_from_path(
            "jeeves.runner.providers.claude_sdk",
            runner_dir / "providers" / "claude_sdk.py"
        )

        assert hasattr(claude_sdk, 'ClaudeSDKProvider'), "claude_sdk should have ClaudeSDKProvider"
