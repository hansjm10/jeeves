"""Pytest configuration for Jeeves tests.

This file ensures src/ is in the Python path for imports during testing.
"""
import sys
from pathlib import Path

# Add src/ to Python path for import tests
# This is required until pyproject.toml is updated in T10 to use src/ layout
repo_root = Path(__file__).parent.parent
src_path = str(repo_root / "src")

# Remove the repo root from sys.path if present to avoid importing the old jeeves package
# This is a transitional measure during the migration from flat layout to src/ layout
repo_root_str = str(repo_root)
sys.path = [p for p in sys.path if p != repo_root_str]

# Add src/ to the beginning of sys.path
if src_path not in sys.path:
    sys.path.insert(0, src_path)

# Remove any cached imports of jeeves to ensure we import from src/
if 'jeeves' in sys.modules:
    # Remove all jeeves-related modules from cache
    modules_to_remove = [key for key in sys.modules.keys() if key == 'jeeves' or key.startswith('jeeves.')]
    for mod in modules_to_remove:
        del sys.modules[mod]
