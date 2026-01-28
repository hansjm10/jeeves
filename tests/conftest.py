"""Pytest configuration for Jeeves tests.

This file ensures src/ is in the Python path for imports during testing.
The src/ layout contains the new package structure while the root jeeves/
directory still exists during the migration period.

IMPORTANT: During the migration period, there's a conflict between the old
jeeves/ package in the repo root and the new src/jeeves/ package. This
conftest.py attempts to set up the correct import order, but if PYTHONPATH
is set externally (e.g., to /work/jeeves), Python may still find the old
package first.

To run tests correctly during migration, you may need to:
1. Temporarily rename jeeves/__init__.py to jeeves/__init__.py.bak
2. Or run tests with: PYTHONPATH= python -m pytest tests/

Once T10 completes and pyproject.toml is updated to use src/ layout,
this workaround will no longer be needed.
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
    repo_root_str = str(repo_root)

    # Remove the old jeeves module if it was already imported
    modules_to_remove = [key for key in list(sys.modules.keys())
                         if key == 'jeeves' or key.startswith('jeeves.')
                         or key == 'viewer' or key.startswith('viewer.')]
    for mod in modules_to_remove:
        del sys.modules[mod]

    # Remove the repo root from sys.path (it contains the old jeeves/)
    while repo_root_str in sys.path:
        sys.path.remove(repo_root_str)

    # Also remove any path that points to a directory containing old jeeves/
    # This handles cases like PYTHONPATH=/work/jeeves
    paths_to_keep = []
    for p in sys.path:
        if p and Path(p).exists():
            old_jeeves = Path(p) / "jeeves" / "__init__.py"
            src_jeeves = Path(p) / "src" / "jeeves" / "__init__.py"
            # Keep if it's src/ or doesn't have an old jeeves package
            if p == src_path or not old_jeeves.exists() or src_jeeves.exists():
                paths_to_keep.append(p)
        else:
            paths_to_keep.append(p)
    sys.path[:] = paths_to_keep

    # Remove the empty string (current directory) if present
    # We'll add it back after src/ to ensure proper ordering
    cwd_entries = []
    while '' in sys.path:
        sys.path.remove('')
        cwd_entries.append('')

    # Ensure src/ is at the very front
    if src_path in sys.path:
        sys.path.remove(src_path)
    sys.path.insert(0, src_path)

    # Re-add CWD entries after src/ but try to keep them reasonable
    for entry in cwd_entries:
        if entry not in sys.path:
            sys.path.insert(1, entry)
