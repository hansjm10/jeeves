# Parallel Task Execution

Jeeves supports parallel execution of independent tasks to reduce wall-clock time for large task lists. This document describes how to enable and configure parallel execution, and explains the expected behavior on failures and merge conflicts.

## Configuration

Parallel execution is configured in `.jeeves/issue.json` under `settings.taskExecution`:

```json
{
  "settings": {
    "taskExecution": {
      "mode": "parallel",
      "maxParallelTasks": 4
    }
  }
}
```

### Configuration Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | `"sequential"` \| `"parallel"` | `"sequential"` | Execution mode. Use `"parallel"` to enable parallel task execution. |
| `maxParallelTasks` | `number` (1-8) | `1` | Maximum number of tasks to execute concurrently. Capped at 8. |

### API Override

You can override `maxParallelTasks` per-run via the `POST /api/run` endpoint:

```bash
curl -X POST http://127.0.0.1:8081/api/run \
  -H "Content-Type: application/json" \
  -d '{"max_parallel_tasks": 4}'
```

The API validates that `max_parallel_tasks`:
- Is a positive integer
- Is in the range [1, 8]

Invalid values return `400 Bad Request`.

## Task Dependencies

Tasks can declare dependencies using the `dependsOn` field in `.jeeves/tasks.json`:

```json
{
  "tasks": [
    { "id": "T1", "status": "pending" },
    { "id": "T2", "status": "pending", "dependsOn": ["T1"] },
    { "id": "T3", "status": "pending", "dependsOn": ["T1", "T2"] }
  ]
}
```

### Dependency Rules

1. **Unique IDs**: All task IDs must be unique.
2. **Valid References**: `dependsOn` entries must reference existing task IDs.
3. **Acyclic Graph**: The dependency graph must be a DAG (no cycles).

Validation failures produce clear error messages:
- `DUPLICATE_ID`: "Duplicate task ID 'T1' found at indices 0 and 2"
- `MISSING_DEPENDENCY`: "Task 'T2' depends on non-existent task 'T3'"
- `CYCLE_DETECTED`: "Cycle detected in task dependencies: T1 -> T2 -> T3 -> T1"

### Ready-Task Selection

A task is "ready" when:
1. Its status is `"pending"` or `"failed"` (both are eligible for scheduling)
2. All tasks in its `dependsOn` list have `status === "passed"`

Tasks with `status === "in_progress"` are never scheduled.

### Deterministic Ordering

Ready tasks are selected in a deterministic order:
1. **Status rank**: `"failed"` tasks before `"pending"` (prioritize retries)
2. **List index**: Earlier tasks in `tasks.json` first
3. **Task ID**: Lexicographic string comparison (T1 < T10 < T2)

The first `maxParallelTasks` tasks in this sorted order are selected for each wave.

## Wave Execution

Parallel execution operates in "waves":

1. **Implement Wave**: Execute `implement_task` for all selected tasks in parallel
2. **Spec-Check Wave**: Execute `task_spec_check` for the same tasks in parallel
3. **Merge**: Merge passed task branches into the canonical branch
4. **Repeat**: Select new ready tasks and start the next wave

Each wave consumes two canonical workflow iterations (one for implement, one for spec-check).

## Failure Handling

### Worker Failures

When a task fails during execution:
- Other workers in the same wave **continue** (non-cancelling behavior)
- The failed task is marked `status: "failed"` in `tasks.json`
- If the worker generated a `task-feedback.md` file, it is copied to canonical `.jeeves/task-feedback/<taskId>.md`
- Failed tasks are eligible for retry in later waves

### Merge Conflicts

When merging a passed task's branch into the canonical branch:
1. Merge is attempted using `git merge --no-ff`
2. If a conflict occurs:
   - The merge is aborted (`git merge --abort`)
   - The conflicting task is marked as `failed`
   - A synthetic feedback file is written to `.jeeves/task-feedback/<taskId>.md` describing the conflict, resolution steps, and artifact locations
   - A progress log entry describes the conflict
   - The run is marked as **errored** and stops
   - Worker worktrees/branches are retained for debugging

### Timeout Handling

When a wave times out (`iteration_timeout_sec` or `inactivity_timeout_sec`):
- All workers are terminated
- All wave tasks are marked `status: "failed"`
- Synthetic feedback files are written to `.jeeves/task-feedback/<taskId>.md` explaining the timeout (includes wave ID, run ID, timeout type, and artifacts location)
- The run ends as **failed** (eligible for retry)

### Manual Stop

When an operator stops a run during an active wave:
- All workers are terminated
- Wave task statuses are rolled back to their pre-reservation values
- Parallel state is cleared
- A progress entry documents the abort

## Recovery and Resume

Parallel execution is restart-safe. If the server stops (manually, by crash, or by timeout), the next run can resume correctly.

### Restart Recovery

On run start, the orchestrator:
1. Checks for orphaned `in_progress` tasks not in any active wave
2. Marks orphaned tasks as `failed` with a recovery note
3. If an active wave exists (`issue.json.status.parallel`), resumes it

### Resume Behavior

When resuming an active wave:
- The same `activeWaveTaskIds` are used (no reselection)
- Completion markers (`implement_task.done`, `task_spec_check.done`) skip already-done work
- The wave continues where it left off

### Invariant

A task may only have `status: "in_progress"` when:
- `issue.json.status.parallel` exists, AND
- The task ID is in `status.parallel.activeWaveTaskIds`

Violations are automatically repaired at run start.

## Worker Sandboxes

Each task runs in an isolated sandbox:

- **State directory**: `<STATE>/.runs/<runId>/workers/<taskId>/`
- **Git worktree**: `<WORKTREES>/<owner>/<repo>/issue-<N>-workers/<runId>/<taskId>/`
- **Branch**: `issue/<N>-<taskId>` (e.g., `issue/78-T1`)

### Cleanup Behavior

| Outcome | Worktree | Branch | State Dir |
|---------|----------|--------|-----------|
| Passed + Merged | Deleted | Deleted | Retained |
| Failed | Retained | Retained | Retained |
| Timeout | Retained | Retained | Retained |
| Merge Conflict | Retained | Retained | Retained |

Retained artifacts support debugging and manual remediation.

## Wave Summaries and Artifacts

Each wave generates persistent artifacts for observability:

### Progress Entry

A single combined wave summary entry is appended to `.jeeves/progress.txt` after the spec-check phase completes. This entry includes:
- Wave tasks and run ID
- Implement phase summary (timestamps, pass/fail counts)
- Spec-check phase summary (timestamps, verdicts)
- Merge results (order, success/failure per task, commit SHAs)
- Per-task verdicts (implement status, spec-check status, final verdict)

### Wave Summary JSON

Each wave is recorded in `<STATE>/.runs/<runId>/waves/<waveId>.json` with:
- `waveId`, `phase`, `taskIds`
- `startedAt`, `endedAt` timestamps
- `workers` array with per-worker outcomes
- `taskVerdicts` object with per-task status, exit code, branch, taskPassed/taskFailed
- `mergeResult` (added after spec-check) with merge order and results

### Task Feedback Files

Canonical task feedback is stored in `.jeeves/task-feedback/<taskId>.md`:
- Worker-generated feedback is copied from worker state on failures
- Synthetic feedback is generated for timeouts and merge conflicts
- Feedback includes failure reason, details, timestamps, and artifact locations

## Merge Strategy

Passed branches are merged into the canonical branch in **lexicographic taskId order**:
- T1 < T10 < T2 (string comparison, not numeric)

Each merge uses `git merge --no-ff` to preserve commit history and attribution.

Passed tasks are merged even if other tasks in the same wave fail (partial success is preserved).

## Monitoring

### Run Status API

`GET /api/run` includes worker information when parallel execution is active:

```json
{
  "running": true,
  "workers": [
    {
      "taskId": "T1",
      "phase": "implement_task",
      "pid": 12345,
      "startedAt": "2026-02-03T12:00:00Z",
      "status": "running"
    },
    {
      "taskId": "T2",
      "phase": "implement_task",
      "pid": 12346,
      "startedAt": "2026-02-03T12:00:01Z",
      "status": "running"
    }
  ],
  "max_parallel_tasks": 4
}
```

### Viewer UI

The Watch page displays active workers with:
- Task ID
- Current phase (Implementing / Checking)
- Status (running / passed / failed / timed_out)

Status updates are live via WebSocket.

### Logs

Worker logs are prefixed with `[WORKER <taskId>]` to make interleaved output readable:
```
[WORKER T1][STDOUT] Starting implementation...
[WORKER T2][STDOUT] Starting implementation...
[PARALLEL] Wave implement_task completed: 2/2 passed
```

## Troubleshooting

### Merge Conflict

**Symptom**: Run stops with "Merge conflict on task T2" error.

**Resolution**:
1. Check `progress.txt` for conflict details
2. Inspect the retained worker worktree at `<WORKTREES>/.../T2/`
3. Resolve conflict manually or adjust task file patterns to reduce overlap
4. Reset the failed task to `"pending"` and restart

### Stuck in_progress Tasks

**Symptom**: Tasks are stuck as `in_progress` after server restart.

**Resolution**: This is automatically repaired at run start. Check `progress.txt` for recovery notes. If the issue persists, manually set task status to `"failed"` or `"pending"`.

### Worker Not Starting

**Symptom**: Parallel mode enabled but only one task runs at a time.

**Check**:
1. `settings.taskExecution.mode` is `"parallel"` in `issue.json`
2. `maxParallelTasks` > 1
3. Multiple tasks are "ready" (check `dependsOn` requirements)

## References

- Design document: `docs/issue-78-design.md`
- Scheduler implementation: `packages/core/src/taskScheduler.ts`
- Worker sandbox: `apps/viewer-server/src/workerSandbox.ts`
- Parallel runner: `apps/viewer-server/src/parallelRunner.ts`
- Merge logic: `apps/viewer-server/src/waveResultMerge.ts`
