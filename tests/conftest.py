"""Pytest configuration for Jeeves tests.

This file ensures src/ is in the Python path for imports during testing.
The package uses src/ layout with all modules under src/jeeves/.
"""
import sys
from pathlib import Path


def pytest_configure(config):
    """Hook called after command line options have been parsed.

    This runs BEFORE test collection, allowing us to manipulate
    sys.path before any test modules are imported.
    """
    # Get absolute paths
    repo_root = Path(__file__).parent.parent.absolute()
    src_path = str(repo_root / "src")

    # Ensure src/ is at the very front of sys.path
    if src_path in sys.path:
        sys.path.remove(src_path)
    sys.path.insert(0, src_path)
