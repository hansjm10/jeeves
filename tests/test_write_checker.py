# tests/test_write_checker.py
import pytest
from pathlib import Path
from jeeves.core.write_checker import check_forbidden_writes


class TestWriteChecker:
    def test_allowed_write_jeeves_dir(self):
        allowed = [".jeeves/*"]
        changed_files = [".jeeves/issue.json", ".jeeves/progress.txt"]

        violations = check_forbidden_writes(changed_files, allowed)

        assert violations == []

    def test_forbidden_write_src(self):
        allowed = [".jeeves/*"]
        changed_files = [".jeeves/issue.json", "src/main.py"]

        violations = check_forbidden_writes(changed_files, allowed)

        assert "src/main.py" in violations

    def test_multiple_allowed_patterns(self):
        allowed = [".jeeves/*", "docs/plans/*"]
        changed_files = [".jeeves/issue.json", "docs/plans/design.md"]

        violations = check_forbidden_writes(changed_files, allowed)

        assert violations == []

    def test_empty_changed_files(self):
        allowed = [".jeeves/*"]
        changed_files = []

        violations = check_forbidden_writes(changed_files, allowed)

        assert violations == []
