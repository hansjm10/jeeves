# Code Review - Evaluate

## Phase Type: evaluate

## Inputs

The `.jeeves/` directory is in your **current working directory**. Use relative paths only.

- Issue config: `.jeeves/issue.json`
- Progress log: `.jeeves/progress.txt`
- Design doc template: `docs/design-document-template.md`
- Do not use absolute paths - always use relative paths starting with `.jeeves/`



IMPORTANT: This is a read-only evaluation phase.
- You MUST NOT modify source code files
- You CAN modify: `.jeeves/issue.json`, `.jeeves/progress.txt`, `.jeeves/review.md`
- Your role is to review and set status flags

## Your Task

1. Review all code changes (use `git diff main...HEAD`)
2. Check for:
   - Code quality and best practices
   - Test coverage
   - Security issues
   - Performance concerns
3. Write review to `.jeeves/review.md`
4. Set appropriate status flags

## Completion

Update `.jeeves/issue.json` with ONE of:

**If changes needed:**
```json
{
  "status": {
    "reviewNeedsChanges": true,
    "reviewClean": false
  }
}
```

**If clean:**
```json
{
  "status": {
    "reviewNeedsChanges": false,
    "reviewClean": true
  }
}
```
