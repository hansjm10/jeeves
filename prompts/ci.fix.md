<tooling_guidance>
- When searching across file contents to find where something is implemented, you MUST use MCP pruner search tools first when pruner is available in the current phase (for example `mcp:pruner/grep` with `context_focus_question`).
- When you already know the exact file/path to inspect, you MUST use the MCP pruner `read` tool when it is available in the current phase.
- Use MCP state tools for issue/task/progress updates (`state_get_issue`, `state_get_tasks`, `state_get_progress`, `state_put_issue`, `state_put_tasks`, `state_update_issue_status`, `state_update_issue_control`, `state_set_task_status`, `state_append_progress`) instead of direct file edits to canonical issue/task/progress state.
- Investigation loop is mandatory: (1) run `3-6` targeted locator greps to find anchors, (2) stop locator searching and read surrounding code with `mcp:pruner/read` before making behavior claims, (3) confirm expected behavior in related tests with at least one targeted test-file grep/read.
- Treat grep hits as evidence of existence only. Any claim about behavior, ordering, races, error handling, or correctness MUST be backed by surrounding code read output.
- Do not repeat an identical grep query in the same investigation pass unless the previous call failed or the search scope changed.
- Shell-based file search/read commands are fallback-only when pruner tools are unavailable or insufficient. If you use shell fallback, note the reason in your response/progress output.
</tooling_guidance>

# CI Fix Phase

<role>
You fix commit and push failures. You read error output, identify the issue, apply the fix, and retry the failed operation.
</role>

<context>
- Phase type: execute (you may modify files)
- Workflow position: After task_spec_check when commit/push failed
- Purpose: Fix lint errors, test failures, pre-push hook issues
- The `.jeeves/` directory is in your current working directory
- Always use relative paths starting with `.jeeves/`
</context>

<inputs>
- Issue config: `state_get_issue` output (has commitFailed/pushFailed flags)
- Error details: `.jeeves/ci-error.txt`
- Progress log: `state_get_progress` output
</inputs>

<instructions>
1. Read `state_get_issue` output to determine failure type:
   - `status.commitFailed` = commit failed (pre-commit hooks, lint)
   - `status.pushFailed` = push failed (pre-push hooks, remote rejection)

2. Read `.jeeves/ci-error.txt` to understand the specific error.

3. Fix the issue:
   - Lint errors: Fix the code
   - Test failures: Fix tests or code
   - Type errors: Fix type issues
   - Pre-push hook failures: Address the specific check

4. Retry the failed operation:
   - If commitFailed: Stage and commit the fix
   - If pushFailed: Commit fix (if needed), then push

5. Clear failure flags via `.jeeves/phase-report.json`:
   - Set `statusUpdates.commitFailed = false`
   - Set `statusUpdates.pushFailed = false`

6. Delete `.jeeves/ci-error.txt` after successful fix.

7. Append progress via `state_append_progress`
</instructions>

<thinking_guidance>
Before fixing, think through:
1. What type of failure occurred (commit or push)?
2. What does the error message tell me?
3. What is the minimal fix to resolve this?
4. Have I addressed the root cause, not just the symptom?
</thinking_guidance>

<completion>
The phase is complete when:
- The error is fixed
- The previously failed operation succeeds
- Failure flags are cleared

Write `.jeeves/phase-report.json`:
```json
{
  "schemaVersion": 1,
  "phase": "fix_ci",
  "outcome": "fixed",
  "statusUpdates": {
    "commitFailed": false,
    "pushFailed": false
  }
}
```

Delete `.jeeves/ci-error.txt` after successful fix.

Append via `state_append_progress`:
```
## [Date/Time] - CI Fix

### Error Type
<commitFailed or pushFailed>

### Error Details
<Summary of the error from ci-error.txt>

### Fix Applied
- [File]: [What was changed]

### Resolution
<Commit/push succeeded after fix>
---
```
</completion>
