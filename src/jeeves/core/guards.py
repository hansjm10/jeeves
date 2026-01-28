# src/jeeves/core/guards.py
"""Guard expression parser for workflow transitions.

Supports simple expressions:
- field.path == value
- field.path != value
- expr and expr
- expr or expr
"""

from typing import Any, Dict


def _get_nested_value(obj: Dict[str, Any], path: str) -> Any:
    """Get a nested value from a dict using dot notation."""
    parts = path.split(".")
    current = obj
    for part in parts:
        if isinstance(current, dict):
            current = current.get(part)
        else:
            return None
    return current


def _parse_value(value_str: str) -> Any:
    """Parse a string value into its Python type."""
    value_str = value_str.strip()
    if value_str.lower() == "true":
        return True
    if value_str.lower() == "false":
        return False
    if value_str.lower() == "null" or value_str.lower() == "none":
        return None
    if value_str.isdigit():
        return int(value_str)
    # Remove quotes if present
    if (value_str.startswith('"') and value_str.endswith('"')) or \
       (value_str.startswith("'") and value_str.endswith("'")):
        return value_str[1:-1]
    return value_str


def _evaluate_comparison(expr: str, context: Dict[str, Any]) -> bool:
    """Evaluate a single comparison expression."""
    expr = expr.strip()

    # Handle != operator
    if "!=" in expr:
        parts = expr.split("!=", 1)
        if len(parts) != 2:
            return False
        field_path = parts[0].strip()
        expected = _parse_value(parts[1])
        actual = _get_nested_value(context, field_path)
        return actual != expected

    # Handle == operator
    if "==" in expr:
        parts = expr.split("==", 1)
        if len(parts) != 2:
            return False
        field_path = parts[0].strip()
        expected = _parse_value(parts[1])
        actual = _get_nested_value(context, field_path)
        return actual == expected

    # Bare field name treated as truthy check
    value = _get_nested_value(context, expr)
    return bool(value)


def evaluate_guard(expression: str, context: Dict[str, Any]) -> bool:
    """Evaluate a guard expression against a context.

    Args:
        expression: Guard expression like "status.reviewClean == true"
        context: Dictionary containing the evaluation context (usually issue.json)

    Returns:
        True if the guard passes, False otherwise
    """
    if not expression or not expression.strip():
        return True  # Empty guard always passes

    expression = expression.strip()

    # Handle 'or' (lower precedence)
    if " or " in expression:
        parts = expression.split(" or ")
        return any(_evaluate_comparison(p, context) if " and " not in p
                   else evaluate_guard(p, context) for p in parts)

    # Handle 'and' (higher precedence)
    if " and " in expression:
        parts = expression.split(" and ")
        return all(_evaluate_comparison(p, context) for p in parts)

    # Single comparison
    return _evaluate_comparison(expression, context)
