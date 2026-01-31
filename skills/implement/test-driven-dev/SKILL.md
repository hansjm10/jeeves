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
```ts
import { expect, test } from 'vitest';

test('feature does something', () => {
  // Arrange
  const inputData = createInput();

  // Act
  const result = featureUnderTest(inputData);

  // Assert
  expect(result).toEqual(expectedOutput);
});
```

### 2. Green - Write Minimal Code to Pass
Implement just enough code to make the test pass. No more.

### 3. Refactor - Improve the Code
Clean up duplication, improve names, extract abstractions.

---

## Test Structure

Follow the **AAA Pattern**:

```ts
import { test } from 'vitest';

test('descriptive name', () => {
  // Arrange - Set up test data and dependencies

  // Act - Execute the code under test

  // Assert - Verify the expected outcome
});
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
pnpm test

# Run specific test file
pnpm exec vitest run path/to/feature.test.ts

# Run with coverage (if configured)
pnpm exec vitest run --coverage

# Run tests matching pattern
pnpm exec vitest run -t "feature"
```

---

## Common Assertions

```ts
import { expect } from 'vitest';

// Equality
expect(result).toEqual(expected);

// Exceptions
expect(() => functionThatThrows()).toThrow();

// Collections
expect(collection).toContain(item);
expect(result).toHaveLength(3);

// Approximate
expect(result).toBeCloseTo(3.14, 2);
```
