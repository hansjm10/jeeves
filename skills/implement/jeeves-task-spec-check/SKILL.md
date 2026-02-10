---
name: jeeves-task-spec-check
description: "Jeeves-specific task spec-check adapter defining MCP state contracts, artifact schemas, and PASS/FAIL handling. Use when: (1) verifying task acceptance criteria in the task_spec_check phase, (2) producing phase-report.json or task-feedback.md artifacts, (3) enforcing filesAllowed compliance, (4) writing criterion-level evidence with structured verdicts. Triggers on: spec check, task verification, acceptance criteria check, phase report, task feedback."
---

# Jeeves Task Spec-Check Adapter

Defines the Jeeves-specific contracts for task specification checking: MCP state tool usage, `.jeeves` artifact schemas, filesAllowed enforcement, and structured PASS/FAIL handling with criterion-level evidence.

---

## The Job

Verify each acceptance criterion for the current task using direct evidence, enforce file permission compliance, produce structured status updates via MCP state tools, and write canonical `.jeeves` artifacts that the orchestrator consumes for workflow transitions.

---

## MCP State Contracts

### Reading Task State

1. Call `state_get_issue` and extract `status.currentTaskId`.
2. Call `state_get_tasks` and locate the task matching `currentTaskId`.
3. Extract from the task definition:
   - `acceptanceCriteria` (array of strings)
   - `filesAllowed` (array of glob patterns)

### Writing Status Updates

#### On PASS

1. Call `state_set_task_status` with the current task ID and status `"passed"`.
2. Call `state_update_issue_status` with:
   - `currentTaskId`: next pending task ID (or current if none remain)
   - `taskPassed`: `true`
   - `taskFailed`: `false`
   - `hasMoreTasks`: `true` if pending tasks remain, `false` otherwise
   - `allTasksComplete`: `true` only if no pending tasks remain

#### On FAIL

1. Call `state_set_task_status` with the current task ID and status `"failed"`.
2. Call `state_update_issue_status` with:
   - `currentTaskId`: unchanged (same task will be retried)
   - `taskPassed`: `false`
   - `taskFailed`: `true`
   - `hasMoreTasks`: `true`
   - `allTasksComplete`: `false`

### Progress Logging

Call `state_append_progress` with a structured entry including:
- Task ID and title
- Per-criterion PASS/FAIL with evidence references
- File permission check result
- Overall verdict

---

## `.jeeves` Artifact Contracts

### `.jeeves/phase-report.json`

Written after every spec-check completion (PASS or FAIL). Consumed by the orchestrator for workflow transitions.

**Schema:**

```json
{
  "schemaVersion": 1,
  "phase": "task_spec_check",
  "outcome": "<passed|failed>",
  "statusUpdates": {
    "taskPassed": "<boolean>",
    "taskFailed": "<boolean>",
    "hasMoreTasks": "<boolean>",
    "allTasksComplete": "<boolean>"
  },
  "reasons": ["<string>"],
  "evidenceRefs": ["<string>"]
}
```

**Field rules:**
- `schemaVersion`: Always `1`.
- `phase`: Always `"task_spec_check"`.
- `outcome`: `"passed"` when all criteria pass and file permissions are clean; `"failed"` otherwise.
- `statusUpdates`: Must match the values written to MCP state.
- `reasons`: Array of non-empty strings summarizing why the task passed or failed. Omit empty strings. Default to `[]` if not provided.
- `evidenceRefs`: Array of non-empty strings pointing to evidence locations (`<path>:<line>`, executed command, or artifact reference). Default to `[]` if not provided.

### `.jeeves/task-feedback.md` (FAIL only, sequential mode)

Written only on FAIL to provide actionable retry guidance for the next implementation iteration.

**Format:**

```markdown
# Task Feedback: <task_id>

## Failed Criteria
- <criterion text>: <precise failure reason + evidence or missing evidence>

## Suggested Fixes
- <actionable fix description>

## Files to Review
- <file path>: <what to check>
```

### `.jeeves/task-feedback/<taskId>.md` (FAIL only, parallel mode)

Same format as sequential feedback, but written to a per-task path for parallel wave execution.

---

## Criterion Verification Rules

### Evidence Requirements

For each acceptance criterion:

1. Determine exactly what the criterion requires.
2. Verify using **direct evidence**:
   - File existence checks
   - Code inspection with file path and line reference
   - Executed command output
   - Test execution results
3. Record verdict as `PASS`, `FAIL`, or `INCONCLUSIVE`.

### Verdict Rules

- **PASS**: Criterion is explicitly and provably satisfied. Evidence directly demonstrates the requirement is met.
- **FAIL**: Criterion is not satisfied, or evidence shows the requirement is violated.
- **INCONCLUSIVE**: Evidence is insufficient to determine pass or fail (e.g., pruner output was truncated, required infrastructure is unavailable).

A criterion only passes if it is **explicitly satisfied**. Absence of counter-evidence is not sufficient for PASS.

If implementation differs from criterion wording, PASS only if the result is **provably equivalent in externally observable behavior**.

### Overall Verdict

- **PASS** requires: ALL acceptance criteria pass AND all file modifications comply with `filesAllowed`.
- **FAIL** if: ANY criterion fails, ANY criterion is unverifiable, OR any file permission violation occurs.

---

## `filesAllowed` Enforcement

### Checking Modified Files

Inspect the working tree for modifications using:
- `git diff --name-only` (staged and unstaged changes)
- `git status --porcelain` (untracked files)

### Matching Rules

- Each modified/untracked file must match at least one pattern in `filesAllowed`.
- `filesAllowed` is automatically expanded to include common test-file variants for allowed source files (e.g., `foo.test.ts`, `foo.test.tsx`, `__tests__/foo.ts`, `__tests__/foo.test.ts`).
- `.jeeves/` files are always allowed (workflow state).
- **ANY modified file not matching `filesAllowed` is a FAIL**, regardless of criterion results.

---

## Evidence Schema Reference

Criterion-level evidence records follow the structured schema defined in `references/evidence-schema.json`. This schema normalizes verdict/evidence shape for consistent evaluation across runs.

Key constraints:
- `criteria[].verdict`: Enum of `PASS`, `FAIL`, `INCONCLUSIVE`
- `criteria[].evidence[].confidence`: Numeric value in closed interval `[0, 1]`
- `criteria[].evidence[].type`: One of `file_inspection`, `command_output`, `test_result`, `file_existence`

See `references/evidence-schema.json` for the complete schema definition.

---

## Quick Reference

| Action | Contract |
|--------|----------|
| Read task state | `state_get_issue` + `state_get_tasks` |
| Update task status | `state_set_task_status` |
| Update issue status | `state_update_issue_status` |
| Log progress | `state_append_progress` |
| Write phase report | `.jeeves/phase-report.json` |
| Write failure feedback (sequential) | `.jeeves/task-feedback.md` |
| Write failure feedback (parallel) | `.jeeves/task-feedback/<taskId>.md` |
| Evidence schema | `references/evidence-schema.json` |
