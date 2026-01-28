# Design Phase - Edit

## Phase Type: execute

You are applying changes to the design document based on review feedback.

## Your Task

1. Read the feedback from `.jeeves/issue.json` `status.designFeedback`
2. Update the design document at `designDocPath`
3. Clear the feedback flag

## Completion

When done, update `.jeeves/issue.json`:
```json
{
  "status": {
    "designNeedsChanges": false,
    "designFeedback": null
  }
}
```
