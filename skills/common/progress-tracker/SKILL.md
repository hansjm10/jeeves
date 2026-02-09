---
name: progress-tracker
description: "Track and report progress on multi-step tasks. Use when working through complex workflows, implementing features, or debugging. Triggers on: track progress, log progress, update status, checkpoint."
---

# Progress Tracker

Helps maintain clear progress tracking throughout multi-step tasks.

---

## The Job

Keep a running log of progress in the canonical progress event log (via `state_append_progress`) to maintain context and provide visibility into work status.

---

## Progress Format

```markdown
## [Date/Time] - Phase: [Phase Name]

### Current Task
[What you're working on]

### Completed Steps
- [x] Step 1 - done
- [x] Step 2 - done
- [ ] Step 3 - in progress

### Blockers
[Any issues encountered]

### Next Steps
[What comes next]
---
```

---

## Best Practices

1. **Update frequently** - Log progress after each significant step
2. **Be specific** - Include file names, function names, test results
3. **Note blockers early** - Don't wait until stuck to document issues
4. **Include context** - Future phases may need to understand decisions made
5. **Timestamp entries** - Helps track velocity and identify slow phases

---

## When to Update

- After completing a significant code change
- When encountering an unexpected issue
- Before and after running tests
- When making architectural decisions
- At phase transitions

---

## Integration

Progress logs are:
- Persisted in the canonical progress event log
- Used by evaluation phases to understand context
- Helpful for debugging failed phases
- Useful for generating PR descriptions
