# Issue 72 Design: Auto-expand `filesAllowed` for Tests

## Summary

Task retries are frequently caused by `task_spec_check` failing when an implementation edits a test file adjacent to an allowed source file, but the task’s `filesAllowed` list only includes the source file pattern.

This change makes the allowance deterministic by expanding each task’s `filesAllowed` patterns to include common test-file variants.

## Goals

- Reduce `task_spec_check` failures caused by editing corresponding test files.
- Keep task scoping tight: only add test variants that are plausibly “the tests for an allowed source file”.
- Make the behavior deterministic (not reliant on prompt interpretation).

## Non-goals

- Allow arbitrary tests outside the scope implied by the allowed source patterns.
- Change the definition of `filesAllowed` beyond adding test variants.

## Expansion Rules (Pattern-Based)

For each `filesAllowed` pattern that ends in `.ts` or `.tsx` and does **not** already appear to be a test file:

1. Same-directory test variants:
   - `<patternStem>.test.ts`
   - `<patternStem>.test.tsx`

2. `__tests__/` directory variants:
   - `<dir>/__tests__/<basename>.<originalExt>`
   - `<dir>/__tests__/<basename>.test.ts`
   - `<dir>/__tests__/<basename>.test.tsx`

Notes:
- These rules apply to both exact file paths and glob patterns.
- Expansion is idempotent (re-expanding does not grow the list indefinitely).
- Patterns that already contain `.test.` are not expanded.

## Where It Runs

The viewer server post-processes `.jeeves/tasks.json` (in the issue state directory) when transitioning into `implement_task`, expanding each task's `filesAllowed` list in-place before the next task iteration runs.

**Note:** As of Issue #76, the default workflow includes a `pre_implementation_check` phase between `task_decomposition` and `implement_task`. This means the flow is now:

```
task_decomposition → pre_implementation_check → implement_task → task_spec_check
```

The `filesAllowed` expansion still occurs on the transition into `implement_task` (i.e., after `pre_implementation_check` passes). See [issue-76-design.md](issue-76-design.md) for details on the pre-check semantics.

