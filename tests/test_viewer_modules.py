"""Test that viewer modules exist in src/jeeves/viewer."""
import importlib.util
import sys
from pathlib import Path


def get_repo_root() -> Path:
    """Get the repository root directory."""
    return Path(__file__).parent.parent


def load_module_from_path(module_name: str, file_path: Path):
    """Load a Python module from a specific file path.

    This allows us to import modules from src/jeeves/viewer even when
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


class TestViewerStructureExists:
    """Tests for verifying viewer directory structure in src/jeeves/viewer."""

    def test_viewer_directory_exists(self):
        """Verify src/jeeves/viewer directory exists."""
        repo_root = get_repo_root()
        viewer_dir = repo_root / "src" / "jeeves" / "viewer"
        assert viewer_dir.exists(), f"viewer directory should exist at {viewer_dir}"
        assert viewer_dir.is_dir(), "viewer should be a directory"

    def test_viewer_init_exists(self):
        """Verify viewer __init__.py exists."""
        repo_root = get_repo_root()
        init_file = repo_root / "src" / "jeeves" / "viewer" / "__init__.py"
        assert init_file.exists(), f"__init__.py should exist at {init_file}"
        assert init_file.is_file(), "__init__.py should be a file"

    def test_viewer_server_exists(self):
        """Verify viewer server.py exists."""
        repo_root = get_repo_root()
        server_file = repo_root / "src" / "jeeves" / "viewer" / "server.py"
        assert server_file.exists(), f"server.py should exist at {server_file}"
        assert server_file.is_file(), "server.py should be a file"

    def test_viewer_tui_exists(self):
        """Verify viewer tui.py exists."""
        repo_root = get_repo_root()
        tui_file = repo_root / "src" / "jeeves" / "viewer" / "tui.py"
        assert tui_file.exists(), f"tui.py should exist at {tui_file}"
        assert tui_file.is_file(), "tui.py should be a file"

    def test_viewer_static_directory_exists(self):
        """Verify src/jeeves/viewer/static directory exists."""
        repo_root = get_repo_root()
        static_dir = repo_root / "src" / "jeeves" / "viewer" / "static"
        assert static_dir.exists(), f"static directory should exist at {static_dir}"
        assert static_dir.is_dir(), "static should be a directory"

    def test_viewer_index_html_exists(self):
        """Verify viewer static/index.html exists."""
        repo_root = get_repo_root()
        index_file = repo_root / "src" / "jeeves" / "viewer" / "static" / "index.html"
        assert index_file.exists(), f"index.html should exist at {index_file}"
        assert index_file.is_file(), "index.html should be a file"


class TestViewerModulesImportable:
    """Tests for verifying viewer modules can be loaded and have expected attributes.

    These tests use importlib to load modules directly from src/jeeves/viewer,
    bypassing any installed jeeves package.
    """

    def test_viewer_server_has_main_classes(self):
        """Verify viewer server module has expected main classes."""
        repo_root = get_repo_root()
        viewer_dir = repo_root / "src" / "jeeves" / "viewer"

        # Clear any previously cached versions to ensure we get fresh imports
        for mod_name in list(sys.modules.keys()):
            if mod_name.startswith("jeeves.viewer") or mod_name.startswith("src.jeeves.viewer"):
                del sys.modules[mod_name]

        server = load_module_from_path("jeeves.viewer.server", viewer_dir / "server.py")

        assert hasattr(server, 'JeevesState'), "server should have JeevesState"
        assert hasattr(server, 'JeevesViewerHandler'), "server should have JeevesViewerHandler"
        assert hasattr(server, 'JeevesPromptManager'), "server should have JeevesPromptManager"
        assert hasattr(server, 'JeevesRunManager'), "server should have JeevesRunManager"
        assert hasattr(server, 'LogWatcher'), "server should have LogWatcher"
        assert hasattr(server, 'main'), "server should have main function"

    def test_viewer_tui_has_main_classes(self):
        """Verify viewer tui module has expected main classes."""
        repo_root = get_repo_root()
        viewer_dir = repo_root / "src" / "jeeves" / "viewer"

        tui = load_module_from_path("jeeves.viewer.tui", viewer_dir / "tui.py")

        assert hasattr(tui, 'JeevesTerminalViewer'), "tui should have JeevesTerminalViewer"
        assert hasattr(tui, 'main'), "tui should have main function"
