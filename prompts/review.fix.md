# Code Review - Fix

## Phase Type: execute

## Inputs

The `.jeeves/` directory is in your **current working directory**. Use relative paths only.

- Issue config: `.jeeves/issue.json`
- Progress log: `.jeeves/progress.txt`
- Design doc template: `docs/design-document-template.md`
- Do not use absolute paths - always use relative paths starting with `.jeeves/`


You are applying fixes based on code review feedback.

## Your Task

1. Read the review from `.jeeves/review.md`
2. Apply the necessary fixes
3. Run tests to verify
4. Clear the fix flags

## Completion

When done, update `.jeeves/issue.json`:
```json
{
  "status": {
    "reviewNeedsChanges": false
  }
}
```
