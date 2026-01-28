# src/jeeves/core/write_checker.py
"""Write checker for evaluate phases.

Detects forbidden file modifications during evaluate (read-only) phases.
"""
from fnmatch import fnmatch
from typing import List


def check_forbidden_writes(
    changed_files: List[str],
    allowed_patterns: List[str]
) -> List[str]:
    """Check for forbidden file writes.

    Args:
        changed_files: List of file paths that were modified
        allowed_patterns: Glob patterns for allowed writes

    Returns:
        List of file paths that were modified but not allowed
    """
    forbidden = []

    for file_path in changed_files:
        # .jeeves/ is always allowed
        if file_path.startswith(".jeeves/"):
            continue

        # Check against allowed patterns
        allowed = False
        for pattern in allowed_patterns:
            if fnmatch(file_path, pattern):
                allowed = True
                break

        if not allowed:
            forbidden.append(file_path)

    return forbidden
