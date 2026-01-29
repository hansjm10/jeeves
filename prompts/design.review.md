# Design Phase - Review

## Phase Type: evaluate

## Inputs

The `.jeeves/` directory is in your **current working directory**. Use relative paths only.

- Issue config: `.jeeves/issue.json`
- Progress log: `.jeeves/progress.txt`
- Design doc template: `docs/design-document-template.md`
- Do not use absolute paths - always use relative paths starting with `.jeeves/`


IMPORTANT: This is a read-only evaluation phase.
- You MUST NOT modify source code files
- You CAN modify: `.jeeves/issue.json`, `.jeeves/progress.txt`
- Your role is to review and set status flags

## Your Task

1. Read the design document at `designDocPath`
2. Evaluate against the issue requirements
3. Set appropriate status flags

## Review Criteria

- Does the design address all requirements?
- Is the approach sound and maintainable?
- Are there any missing considerations?
- Is the testing strategy adequate?

## Completion

Update `.jeeves/issue.json` with ONE of:

**If changes needed:**
```json
{
  "status": {
    "designNeedsChanges": true,
    "designApproved": false,
    "designFeedback": "Specific feedback here..."
  }
}
```

**If approved:**
```json
{
  "status": {
    "designNeedsChanges": false,
    "designApproved": true
  }
}
```
