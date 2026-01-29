---
name: test-driven-dev
description: "Guide test-driven development practices. Use when implementing features, writing tests, or ensuring code quality. Triggers on: write tests, TDD, test first, add test coverage."
---

# Test-Driven Development

Helps implement features using test-driven development practices.

---

## The Job

Write tests before implementation to drive design and ensure correctness.

---

## TDD Cycle

### 1. Red - Write a Failing Test
```python
def test_feature_does_something():
    # Arrange
    input_data = create_input()

    # Act
    result = feature_under_test(input_data)

    # Assert
    assert result == expected_output
```

### 2. Green - Write Minimal Code to Pass
Implement just enough code to make the test pass. No more.

### 3. Refactor - Improve the Code
Clean up duplication, improve names, extract abstractions.

---

## Test Structure

Follow the **AAA Pattern**:

```python
def test_descriptive_name():
    # Arrange - Set up test data and dependencies

    # Act - Execute the code under test

    # Assert - Verify the expected outcome
```

---

## Test Categories

### Unit Tests
- Test individual functions/methods in isolation
- Mock external dependencies
- Fast execution, run frequently

### Integration Tests
- Test component interactions
- Use real dependencies where practical
- Verify contracts between modules

### End-to-End Tests
- Test complete workflows
- Validate user-facing behavior
- Run less frequently due to cost

---

## Best Practices

1. **One assertion per test** - Tests should verify one behavior
2. **Descriptive names** - Test name should describe the scenario
3. **Independent tests** - Tests should not depend on each other
4. **Fast tests** - Unit tests should run in milliseconds
5. **Test edge cases** - Empty inputs, nulls, boundaries

---

## Running Tests

```bash
# Run all tests
pytest

# Run specific test file
pytest tests/test_feature.py

# Run with coverage
pytest --cov=src

# Run tests matching pattern
pytest -k "test_feature"
```

---

## Common Assertions

```python
# Equality
assert result == expected

# Exceptions
with pytest.raises(ValueError):
    function_that_raises()

# Collections
assert item in collection
assert len(result) == 3

# Approximate
assert result == pytest.approx(3.14, rel=1e-2)
```
