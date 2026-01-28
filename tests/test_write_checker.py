# tests/test_write_checker.py
"""Tests for write checker module."""
import pytest
from jeeves.core.write_checker import check_forbidden_writes


class TestWriteChecker:
    """Tests for check_forbidden_writes function."""

    def test_allowed_write_jeeves_dir(self):
        """Writing to .jeeves/ is always allowed."""
        changed = [".jeeves/issue.json", ".jeeves/progress.txt"]
        forbidden = check_forbidden_writes(changed, allowed_patterns=[])
        assert forbidden == []

    def test_forbidden_write_src(self):
        """Writing to src/ is forbidden without explicit allow."""
        changed = ["src/app.py", "tests/test_app.py"]
        forbidden = check_forbidden_writes(changed, allowed_patterns=[])
        assert "src/app.py" in forbidden
        assert "tests/test_app.py" in forbidden

    def test_multiple_allowed_patterns(self):
        """Multiple allowed patterns work correctly."""
        changed = ["src/app.py", "docs/readme.md", "config.yaml"]
        forbidden = check_forbidden_writes(
            changed,
            allowed_patterns=["src/**", "docs/**"]
        )
        assert forbidden == ["config.yaml"]

    def test_empty_changed_files(self):
        """Empty changed files returns empty forbidden list."""
        forbidden = check_forbidden_writes([], allowed_patterns=["src/**"])
        assert forbidden == []
