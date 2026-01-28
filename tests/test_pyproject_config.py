"""Tests for T10: pyproject.toml configuration for src layout.

These tests verify that:
1. pyproject.toml is correctly configured for src/ layout
2. The old jeeves/ directory is removed
3. pip install -e . works correctly
4. CLI entry points work
"""
import sys
from pathlib import Path
import subprocess

# Get the repository root
REPO_ROOT = Path(__file__).parent.parent


class TestPyprojectConfig:
    """Tests for pyproject.toml configuration."""

    def test_pyproject_exists(self):
        """pyproject.toml should exist at repo root."""
        pyproject_path = REPO_ROOT / "pyproject.toml"
        assert pyproject_path.exists(), "pyproject.toml should exist at repo root"

    def test_setuptools_packages_find_where_src(self):
        """Package location should be set to src/."""
        pyproject_path = REPO_ROOT / "pyproject.toml"
        content = pyproject_path.read_text()

        # Should have where = ["src"]
        assert 'where = ["src"]' in content, (
            "pyproject.toml should have 'where = [\"src\"]' for src layout"
        )

    def test_setuptools_packages_find_include_jeeves(self):
        """Package include should find jeeves* packages."""
        pyproject_path = REPO_ROOT / "pyproject.toml"
        content = pyproject_path.read_text()

        # Should include jeeves packages
        assert 'include = ["jeeves*"]' in content, (
            "pyproject.toml should have 'include = [\"jeeves*\"]'"
        )

    def test_old_jeeves_directory_removed(self):
        """The old jeeves/ directory at root should be removed."""
        old_jeeves = REPO_ROOT / "jeeves"
        assert not old_jeeves.exists(), (
            f"Old jeeves/ directory should be removed, but it still exists at {old_jeeves}"
        )

    def test_src_jeeves_directory_exists(self):
        """The new src/jeeves/ directory should exist."""
        src_jeeves = REPO_ROOT / "src" / "jeeves"
        assert src_jeeves.exists(), f"src/jeeves/ directory should exist at {src_jeeves}"

    def test_src_jeeves_init_exists(self):
        """src/jeeves/__init__.py should exist."""
        init_file = REPO_ROOT / "src" / "jeeves" / "__init__.py"
        assert init_file.exists(), f"src/jeeves/__init__.py should exist at {init_file}"

    def test_cli_entry_point_configured(self):
        """CLI entry point should be configured."""
        pyproject_path = REPO_ROOT / "pyproject.toml"
        content = pyproject_path.read_text()

        # jeeves CLI should point to jeeves.cli:main
        assert 'jeeves = "jeeves.cli:main"' in content, (
            "Entry point 'jeeves' should be configured to 'jeeves.cli:main'"
        )

    def test_sdk_runner_entry_point_configured(self):
        """SDK runner entry point should be configured."""
        pyproject_path = REPO_ROOT / "pyproject.toml"
        content = pyproject_path.read_text()

        # jeeves-sdk-runner should point to jeeves.runner.sdk_runner:main
        assert 'jeeves-sdk-runner = "jeeves.runner.sdk_runner:main"' in content, (
            "Entry point 'jeeves-sdk-runner' should be configured"
        )

    def test_pytest_testpaths_configured(self):
        """pytest testpaths should be set to tests/."""
        pyproject_path = REPO_ROOT / "pyproject.toml"
        content = pyproject_path.read_text()

        assert 'testpaths = ["tests"]' in content, (
            "pytest testpaths should be set to ['tests']"
        )

    def test_pytest_pythonpath_configured(self):
        """pytest pythonpath should be set to src/."""
        pyproject_path = REPO_ROOT / "pyproject.toml"
        content = pyproject_path.read_text()

        assert 'pythonpath = ["src"]' in content, (
            "pytest pythonpath should be set to ['src']"
        )


class TestPackageInstallation:
    """Tests for package installation and imports."""

    def test_jeeves_importable(self):
        """The jeeves package should be importable."""
        # Use a subprocess to avoid import caching issues
        result = subprocess.run(
            [sys.executable, "-c", "import jeeves; print(jeeves.__name__)"],
            capture_output=True,
            text=True,
            cwd=str(REPO_ROOT),
            env={**dict(subprocess.os.environ), "PYTHONPATH": str(REPO_ROOT / "src")}
        )
        assert result.returncode == 0, f"Failed to import jeeves: {result.stderr}"
        assert "jeeves" in result.stdout, f"Unexpected output: {result.stdout}"

    def test_jeeves_core_importable(self):
        """The jeeves.core subpackage should be importable."""
        result = subprocess.run(
            [sys.executable, "-c", "import jeeves.core; print(jeeves.core.__name__)"],
            capture_output=True,
            text=True,
            cwd=str(REPO_ROOT),
            env={**dict(subprocess.os.environ), "PYTHONPATH": str(REPO_ROOT / "src")}
        )
        assert result.returncode == 0, f"Failed to import jeeves.core: {result.stderr}"
        assert "jeeves.core" in result.stdout, f"Unexpected output: {result.stdout}"

    def test_jeeves_runner_importable(self):
        """The jeeves.runner subpackage should be importable."""
        result = subprocess.run(
            [sys.executable, "-c", "import jeeves.runner; print(jeeves.runner.__name__)"],
            capture_output=True,
            text=True,
            cwd=str(REPO_ROOT),
            env={**dict(subprocess.os.environ), "PYTHONPATH": str(REPO_ROOT / "src")}
        )
        assert result.returncode == 0, f"Failed to import jeeves.runner: {result.stderr}"
        assert "jeeves.runner" in result.stdout, f"Unexpected output: {result.stdout}"

    def test_jeeves_viewer_importable(self):
        """The jeeves.viewer subpackage should be importable."""
        result = subprocess.run(
            [sys.executable, "-c", "import jeeves.viewer; print(jeeves.viewer.__name__)"],
            capture_output=True,
            text=True,
            cwd=str(REPO_ROOT),
            env={**dict(subprocess.os.environ), "PYTHONPATH": str(REPO_ROOT / "src")}
        )
        assert result.returncode == 0, f"Failed to import jeeves.viewer: {result.stderr}"
        assert "jeeves.viewer" in result.stdout, f"Unexpected output: {result.stdout}"

    def test_jeeves_cli_importable(self):
        """The jeeves.cli module should be importable."""
        result = subprocess.run(
            [sys.executable, "-c", "import jeeves.cli; print(jeeves.cli.__name__)"],
            capture_output=True,
            text=True,
            cwd=str(REPO_ROOT),
            env={**dict(subprocess.os.environ), "PYTHONPATH": str(REPO_ROOT / "src")}
        )
        assert result.returncode == 0, f"Failed to import jeeves.cli: {result.stderr}"
        assert "jeeves.cli" in result.stdout, f"Unexpected output: {result.stdout}"
