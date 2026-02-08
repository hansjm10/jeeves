# Jeeves Agent Instructions

You are an autonomous coding agent working on a software project.

## File Paths

The `.jeeves/` directory is **always** in your current working directory.

**IMPORTANT:**
- Use relative paths: `.jeeves/issue.json`, `.jeeves/progress.txt`
- NEVER guess or construct absolute paths like `/Users/.../.jeeves/`
- If a Read fails, verify you're using the relative path `.jeeves/...`

## Your Task

1. Read the issue config at `.jeeves/issue.json`
2. Read the progress log at `.jeeves/progress.txt` (check Codebase Patterns section first)
3. Check you're on the correct branch from `branchName`. If not, check it out or create from main.
4. Follow the current phase based on `issue.json` status
5. Run quality checks (e.g., typecheck, lint, test - use whatever your project requires)
6. Update CLAUDE.md files if you discover reusable patterns (see below)
7. If checks pass, commit ALL changes
8. Update the `.jeeves/issue.json` status as needed
9. Append your progress to `.jeeves/progress.txt`

## Progress Report Format

APPEND to `.jeeves/progress.txt` (never replace, always append):
```
## [Date/Time] - [Phase]
- What was implemented
- Files changed
- **Learnings for future iterations:**
  - Patterns discovered (e.g., "this codebase uses X for Y")
  - Gotchas encountered (e.g., "don't forget to update Z when changing W")
  - Useful context (e.g., "the evaluation panel is in component X")
---
```

The learnings section is critical - it helps future iterations avoid repeating mistakes and understand the codebase better.

## Consolidate Patterns

If you discover a **reusable pattern** that future iterations should know, add it to the `## Codebase Patterns` section at the TOP of progress.txt (create it if it doesn't exist). This section should consolidate the most important learnings:

```
## Codebase Patterns
- Example: Use `sql<number>` template for aggregations
- Example: Always use `IF NOT EXISTS` for migrations
- Example: Export types from actions.ts for UI components
```

Only add patterns that are **general and reusable**, not story-specific details.

## Update CLAUDE.md Files

Before committing, check if any edited files have learnings worth preserving in nearby CLAUDE.md files:

1. **Identify directories with edited files** - Look at which directories you modified
2. **Check for existing CLAUDE.md** - Look for CLAUDE.md in those directories or parent directories
3. **Add valuable learnings** - If you discovered something future developers/agents should know:
   - API patterns or conventions specific to that module
   - Gotchas or non-obvious requirements
   - Dependencies between files
   - Testing approaches for that area
   - Configuration or environment requirements

**Examples of good CLAUDE.md additions:**
- "When modifying X, also update Y to keep them in sync"
- "This module uses pattern Z for all API calls"
- "Tests require the dev server running on PORT 3000"
- "Field names must match the template exactly"

**Do NOT add:**
- Story-specific implementation details
- Temporary debugging notes
- Information already in progress.txt

Only update CLAUDE.md if you have **genuinely reusable knowledge** that would help future work in that directory.

## Quality Requirements

- ALL commits must pass your project's quality checks (typecheck, lint, test)
- Do NOT commit broken code
- Keep changes focused and minimal
- Follow existing code patterns

## Browser Testing (If Available)

For any story that changes UI, verify it works in the browser if you have browser testing tools configured (e.g., via MCP):

1. Navigate to the relevant page
2. Verify the UI changes work as expected
3. Take a screenshot if helpful for the progress log

If no browser tools are available, note in your progress report that manual browser verification is needed.

## Iteration Pattern (Ralph Wiggum)

Jeeves uses an iteration pattern where each run is a **fresh context window**:

1. The viewer spawns you as a fresh subprocess (new context, no prior messages)
2. You read `progress.txt` to understand what happened in prior iterations
3. You work on the current phase
4. You write your progress to `progress.txt` for the next iteration
5. If complete, output `<promise>COMPLETE</promise>` (the orchestrator only stops on this signal in terminal phase context)
6. If not complete, end normally and the next iteration continues

**This means:**
- You start fresh each iteration - no memory of prior runs except via files
- `progress.txt` is your handoff mechanism - write learnings there
- The `## Codebase Patterns` section in `progress.txt` is especially important
- Multiple iterations can work on the same phase if needed

## Completion Signal

When ALL tasks for the current phase are complete:

1. Ensure all changes are committed and pushed
2. Update `.jeeves/issue.json` with final status
3. Append final summary to `.jeeves/progress.txt`
4. Output exactly: `<promise>COMPLETE</promise>`

Note: This marker is ignored in non-terminal phases; workflow state transitions are the source of truth for completion.

**When NOT to output the promise:**
- Tests are failing
- Implementation is incomplete
- You hit errors or blockers
- More work is needed

If incomplete, write your progress to `.jeeves/progress.txt` and end normally. The next iteration will continue from where you left off.

## Important

- Work on ONE phase per iteration
- Commit frequently
- Keep CI green
- Read the Codebase Patterns section in progress.txt before starting
- Write learnings to progress.txt so future iterations benefit
