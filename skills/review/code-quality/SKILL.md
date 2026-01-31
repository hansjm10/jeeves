---
name: code-quality
description: "Guide code quality reviews and improvements. Use when reviewing code, fixing linting issues, or improving code quality. Triggers on: code review, quality check, fix lint, improve code."
---

# Code Quality

Helps ensure code meets quality standards during review phases.

---

## The Job

Review code for quality issues and provide actionable feedback for improvement.

---

## Review Checklist

### Correctness
- [ ] Does the code do what it's supposed to do?
- [ ] Are edge cases handled?
- [ ] Are error conditions handled gracefully?

### Readability
- [ ] Are names descriptive and consistent?
- [ ] Is the code self-documenting?
- [ ] Are complex sections commented?

### Maintainability
- [ ] Is the code DRY (Don't Repeat Yourself)?
- [ ] Are functions/methods focused and small?
- [ ] Is the code testable?

### Security
- [ ] Are inputs validated?
- [ ] Are secrets handled securely?
- [ ] Are dependencies up to date?

---

## Common Issues

### Naming
```ts
// Bad
function proc(x: number, y: number): number {
  return x + y;
}

// Good
function calculateTotal(basePrice: number, tax: number): number {
  return basePrice + tax;
}
```

### Function Size
Functions should do one thing. If you need "and" to describe it, split it.

### Error Handling
```ts
// Bad
try {
  doSomething();
} catch {
  // swallowed
}

// Good
try {
  doSomething();
} catch (err) {
  logger.error({ err }, 'failed to do something');
  throw err;
}
```

---

## Quality Metrics

### Cyclomatic Complexity
- 1-10: Simple, low risk
- 11-20: Moderate, some risk
- 21+: Complex, high risk - consider refactoring

### Code Coverage
- Target: 80%+ line coverage
- Focus on critical paths
- Don't chase 100% blindly

---

## Running Quality Checks

```bash
# All checks
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

---

## Review Feedback Format

When providing review feedback:

```markdown
## Summary
[Overall assessment]

## Issues Found
### [Category]
- **File:Line** - [Issue description]
  - Suggestion: [How to fix]

## Suggestions
[Optional improvements]

## Approval Status
[ ] Approved
[ ] Needs Changes
```
