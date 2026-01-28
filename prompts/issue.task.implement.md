# Jeeves Issue - Task Implement (TDD)

You are an autonomous coding agent working on a software project.

## Inputs

The `.jeeves/` directory is in your **current working directory**. Use relative paths only.

- Issue config: `.jeeves/issue.json`
- Progress log: `.jeeves/progress.txt`
- Design document: path in `.jeeves/issue.json` (`designDocPath`)
- Task list: `.jeeves/issue.json.tasks`
- Do not use absolute paths - always use relative paths starting with `.jeeves/`
- Do not delete the .jeeves folder.

## Your Task

1. Read `.jeeves/issue.json` and `.jeeves/progress.txt`.
2. Check out the configured branch from `.jeeves/issue.json.branchName` (create from `main` if needed).
3. Identify the current task:
   - Use `.jeeves/issue.json.status.currentTaskId`.
   - If missing, pick the first task with `status != done` and set `currentTaskId`.
4. Implement **only** the current task using TDD:
   - Write a failing test first.
   - Implement the minimum code to pass.
   - Refactor if needed.
5. Run relevant checks (prefer targeted `pnpm test`/`pnpm lint`/`pnpm typecheck` equivalents).
6. Commit changes with a Conventional Commit message that includes the issue number. Use `git commit --no-verify -m ...`.
7. Ensure a PR exists and its description is compliant (only if not already done):
   - If `status.prCreated` is not `true`, push the branch and create a PR targeting `main`.
   - Ensure the PR body includes a short summary and a closing line `Fixes #<issueNumber>`.
8. Update `.jeeves/issue.json`:
   - See "Task Review Skipping" below to decide `taskStage`.
   - Preserve `status.currentTaskId`.
9. Append a progress entry to `.jeeves/progress.txt` summarizing what changed, tests run, and the task id.

## Task Review Skipping

Check if `.jeeves/issue.json.config.autoSkipTaskReviews` is `true`. If so, assess whether this task needs review phases:

**Skip reviews (set `taskStage=implement` and advance to next pending task, or mark `tasksComplete` if none remain) if ALL of:**
- Task is low-risk: documentation, config changes, simple wiring, straightforward CRUD
- Changes are localized: 1-2 files, no complex logic or algorithms
- Tests are comprehensive: good coverage of the change, all tests pass
- No security/performance implications

**Require reviews (set `taskStage=spec-review`) if ANY of:**
- Task touches critical paths (auth, data validation, payments, security)
- Complex logic or algorithms added
- Multiple modules/packages affected (3+ files with interdependencies)
- Edge cases or error handling need verification
- Changes affect public API or external integrations

If `autoSkipTaskReviews` is `false` or not set, always set `taskStage=spec-review`.

## Completion Signal

When the current task implementation is complete (tests pass, code committed, PR exists):

1. Ensure all changes are committed and pushed
2. Update `.jeeves/issue.json` with task status and `taskStage`
3. Append final summary to `.jeeves/progress.txt`
4. Output exactly: `<promise>COMPLETE</promise>`

If the task is incomplete or tests fail, write your progress to `.jeeves/progress.txt` and end normally WITHOUT the promise. The next iteration will continue from where you left off.
