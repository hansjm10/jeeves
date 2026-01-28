# src/jeeves/core/write_checker.py
"""Check for forbidden file writes in evaluate phases."""

import fnmatch
from typing import List


def check_forbidden_writes(
    changed_files: List[str],
    allowed_patterns: List[str],
) -> List[str]:
    """Check if any changed files violate the allowed patterns.

    Args:
        changed_files: List of file paths that were modified
        allowed_patterns: Glob patterns for allowed modifications

    Returns:
        List of file paths that were modified but not allowed
    """
    violations = []

    for file_path in changed_files:
        is_allowed = False
        for pattern in allowed_patterns:
            if fnmatch.fnmatch(file_path, pattern):
                is_allowed = True
                break

        if not is_allowed:
            violations.append(file_path)

    return violations
