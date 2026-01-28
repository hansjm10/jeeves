# tests/test_guards.py
"""Tests for guard expression parser."""

import pytest
from jeeves.core.guards import evaluate_guard


class TestEvaluateGuard:
    """Tests for evaluate_guard function."""

    def test_simple_equality_true(self):
        """Should return True when field equals expected value."""
        context = {"status": {"reviewClean": True}}
        assert evaluate_guard("status.reviewClean == true", context) is True

    def test_simple_equality_false(self):
        """Should return False when field does not equal expected value."""
        context = {"status": {"reviewClean": False}}
        assert evaluate_guard("status.reviewClean == true", context) is False

    def test_not_equal(self):
        """Should return True when field does not equal value with != operator."""
        context = {"status": {"phase": "review"}}
        assert evaluate_guard("status.phase != design", context) is True

    def test_and_operator_both_true(self):
        """Should return True when both conditions with 'and' are true."""
        context = {"status": {"implemented": True, "prCreated": True}}
        assert evaluate_guard("status.implemented == true and status.prCreated == true", context) is True

    def test_and_operator_one_false(self):
        """Should return False when one condition with 'and' is false."""
        context = {"status": {"implemented": True, "prCreated": False}}
        assert evaluate_guard("status.implemented == true and status.prCreated == true", context) is False

    def test_or_operator(self):
        """Should return True when at least one condition with 'or' is true."""
        context = {"status": {"ciFailed": True, "reviewFailed": False}}
        assert evaluate_guard("status.ciFailed == true or status.reviewFailed == true", context) is True

    def test_nested_field_access(self):
        """Should support deeply nested field access via dot notation."""
        context = {"config": {"workflow": {"name": "default"}}}
        assert evaluate_guard("config.workflow.name == default", context) is True

    def test_missing_field_is_none(self):
        """Should treat missing fields as None/null."""
        context = {"status": {}}
        assert evaluate_guard("status.nonexistent == null", context) is True

    def test_empty_guard_passes(self):
        """Should return True for empty guard expression."""
        context = {}
        assert evaluate_guard("", context) is True
