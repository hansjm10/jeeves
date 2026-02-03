# Design Document: Enable Parallel Task Execution for Independent Tasks (Issue #78)

## Document Control
- **Title**: Enable parallel task execution for independent tasks
- **Authors**: Jeeves Agent (Codex CLI)
- **Reviewers**: TBD
- **Status**: Draft
- **Last Updated**: 2026-02-03
- **Related Issues**: https://github.com/hansjm10/jeeves/issues/78
- **Execution Mode**: AI-led

## 1. Summary
Jeeves currently executes decomposed tasks strictly sequentially (`T1 → T2 → T3…`) even when tasks are independent, increasing wall-clock time and iteration counts (as observed in Issue #68). This design adds deterministic dependency tracking (`dependsOn`) and enables bounded parallel execution of unblocked tasks by running each task in an isolated worker worktree/state sandbox, then merging successful results back into the canonical issue branch/state.

## 2. Context & Problem Statement
- **Background**:
  - The default workflow (`workflows/default.yaml`) decomposes tasks into `.jeeves/tasks.json` and then runs a task loop via `implement_task` and `task_spec_check`.
  - Task progression is currently driven by prompts: `prompts/task.spec_check.md` updates `.jeeves/issue.json.status.currentTaskId` and advances to the “next” task, which effectively enforces sequential ordering.
  - Viewer-server orchestration (`apps/viewer-server/src/runManager.ts`) runs exactly one runner subprocess per iteration and phase.
- **Problem**:
  - Independent tasks cannot run concurrently, even when there are no code dependencies.
  - Large task lists (5–15 tasks) can dominate iteration count and wall-clock time because each task requires at least one implementation iteration and one spec-check iteration.
- **Forces**:
  - Concurrency must not introduce filesystem races: multiple writers cannot safely operate in the same git worktree/state directory concurrently.
  - Task results must be merged deterministically into a single issue branch suitable for a final PR.
  - Failure handling must be clear: partial success should not corrupt global state, and failures must be retryable.

## 3. Goals & Non-Goals
- **Goals**:
  1. Respect explicit task dependencies using `dependsOn` in `.jeeves/tasks.json`.
  2. Identify “ready” tasks (no unmet dependencies) and execute up to `maxParallelTasks` concurrently.
  3. Isolate concurrent task execution to avoid state/log races by using per-task worker sandboxes.
  4. Merge successful task results into the canonical issue branch in a deterministic, auditable way.
  5. Provide clear observability for concurrent task runs (task IDs, PIDs, statuses, logs).
- **Non-Goals**:
  - Perfect, always-conflict-free merging of parallel work. Merge conflicts are expected in some cases and will fall back to manual intervention or sequential reruns.
  - Automatic inference of dependencies from code; dependencies remain explicit in the task definition (`dependsOn`).
  - Running parallel tasks that write to the same files safely without merge/conflict risk; the system will be conservative where possible.

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**: Maintainers running Jeeves workflows via the viewer.
- **Agent Roles**:
  - Task Decomposition Agent (`prompts/task.decompose.md`): produces `.jeeves/tasks.json` including `dependsOn`.
  - Implementation Agent (`prompts/task.implement.md`): implements one task per worker sandbox.
  - Spec Check Agent (`prompts/task.spec_check.md`): verifies one task per worker sandbox and records pass/fail and feedback.
  - Viewer-server Orchestrator (code): schedules ready tasks, manages worker sandboxes, and merges results.
- **Affected Packages/Services**:
  - Viewer-server: `apps/viewer-server` (run orchestration, process management, API/status streaming).
  - Runner: `packages/runner` (CLI/args for running phases against explicit state/work directories).
  - Core: `packages/core` (optional: helper paths/types for worker sandboxes).
  - Viewer UI: `apps/viewer` (optional/MVP-scope: surface multiple concurrent task runs).
- **Compatibility Considerations**:
  - `.jeeves/tasks.json` already includes `dependsOn` in the task decomposition prompt; this design makes `dependsOn` operational.
  - Parallel execution should be opt-in (configuration) to preserve existing sequential semantics and reduce rollout risk.

## 5. Current State
- Task loop is sequential and prompt-driven:
  - `.jeeves/tasks.json` contains `tasks[].status` and `tasks[].dependsOn`, but `dependsOn` is not used by scheduling logic.
  - `prompts/task.spec_check.md` advances `.jeeves/issue.json.status.currentTaskId` after a pass.
- Viewer-server runs one subprocess at a time:
  - `apps/viewer-server/src/runManager.ts` has a single `proc` and a single `RunStatus` representing one in-flight runner process.
  - Logs and SDK output are single-stream (`.jeeves/last-run.log`, `.jeeves/sdk-output.json`, `.jeeves/viewer-run.log`).

## 6. Proposed Solution
### 6.1 Architecture Overview
- Add a deterministic task scheduler in viewer-server that:
  - parses `.jeeves/tasks.json`,
  - validates `dependsOn` as a DAG (no missing IDs, no cycles),
  - computes the ready set (`status=pending` and all dependencies `status=passed`),
  - selects up to `maxParallelTasks` to execute concurrently.
- Execute each selected task inside a worker sandbox:
  - a dedicated git worktree on a dedicated branch,
  - a dedicated `.jeeves/` state directory containing copies of `issue.json`, `tasks.json`, and per-task logs/feedback.
- A parallel “wave” spans two canonical workflow iterations to integrate cleanly with the existing `WorkflowEngine` phase loop:
  1. **Canonical `implement_task` iteration**: select ready tasks, reserve them as `status="in_progress"` in canonical `.jeeves/tasks.json`, then run `implement_task` for each task in its worker sandbox (in parallel).
  2. **Canonical `task_spec_check` iteration**: run `task_spec_check` for those same tasks (in parallel), then merge passed branches and update canonical `.jeeves/tasks.json` + `.jeeves/issue.json.status.*` to drive the next workflow transition.
- After all workers in a wave complete:
  - merge successful worker branches into the canonical issue branch,
  - update canonical `.jeeves/tasks.json` statuses and canonical `.jeeves/progress.txt`,
  - persist a wave summary artifact for audit/debug.

### 6.2 Detailed Design
#### 6.2.1 Configuration
- Add an opt-in configuration to `.jeeves/issue.json`:
  - `settings.taskExecution.mode`: `"sequential"` (default) or `"parallel"`.
  - `settings.taskExecution.maxParallelTasks`: integer in `[1..MAX_PARALLEL_TASKS]` (default `1`).
- Add a run-time override in `POST /api/run` body:
  - `max_parallel_tasks?: number` (optional; overrides `settings.taskExecution.maxParallelTasks` for this run only).
  - If omitted, use issue settings; if neither present, default to `1`.
- Define a hard upper bound for deterministic, safe scheduling:
  - `MAX_PARALLEL_TASKS = 8`
  - Rationale: each worker runs two runner phases (implement + spec check) and can be expensive in CPU, filesystem IO, and provider rate/cost; a small fixed cap avoids resource exhaustion and keeps logs/UI usable. Operators can still get most of the benefit with `2–4`.

#### 6.2.2 Task Graph and Readiness
- Treat `.jeeves/tasks.json.tasks` as the source of truth for task definitions.
- Validation rules (hard fail before starting parallel execution):
  1. Task IDs are unique.
  2. `dependsOn` entries reference existing task IDs.
  3. Dependency graph is acyclic (detect cycles via DFS/Kahn’s algorithm).
  4. A task is “ready to implement” iff:
     - `task.status` is `"pending"` or `"failed"` (both are retryable),
     - and for every `depId` in `dependsOn`, the referenced task has `status === "passed"`.
- Selection rules:
  - Prefer stable ordering for determinism (e.g., by task list order, then task ID).
  - Prefer retries first: schedule `"failed"` tasks before `"pending"` tasks when both are ready.
  - Do not schedule tasks whose dependencies are `"failed"` or `"in_progress"`.
  - When a task is selected for an `implement_task` wave, update canonical `.jeeves/tasks.json` immediately to set `task.status = "in_progress"` (reservation) before spawning worker processes.
  - Retry semantics are automatic (aligned with the existing task loop): a task that fails `task_spec_check` becomes `"failed"` and is eligible to be re-scheduled in a later `implement_task` wave without manual operator edits.

#### 6.2.3 Worker Sandbox Layout
For a canonical issue state directory `STATE`, canonical issue worktree `WORK`, and the shared repo clone directory `REPO` (as created by `apps/viewer-server/src/init.ts`), create worker sandboxes under a run-scoped directory:
- Worker state dir: `STATE/.runs/<runId>/workers/<taskId>/`
- Worker worktree dir (MUST NOT be nested under `WORK`): `WORKTREES/<owner>/<repo>/issue-<N>-workers/<runId>/<taskId>/`
  - Where `WORKTREES = <JEEVES_DATA_DIR>/worktrees`.
  - This keeps worker git worktrees as siblings of the canonical worktree (`.../issue-<N>`), avoiding nested-worktree paths that are unsafe/invalid for `git worktree add`.

Worker initialization steps:
1. Create the worker state directory and write:
   - `issue.json`: copy of canonical `.jeeves/issue.json` with:
     - `status.currentTaskId = <taskId>`
     - clear task-loop flags that can be stale (`taskPassed/taskFailed/commitFailed/pushFailed/hasMoreTasks/allTasksComplete`).
   - `tasks.json`: copy of canonical `.jeeves/tasks.json`.
   - Optional: copy canonical `.jeeves/task-feedback/<taskId>.md` into worker `.jeeves/task-feedback.md` for retries.
2. Create a worker git worktree:
   - Branch name: `issue/<N>-<taskId>` (e.g., `issue/78-T1`).
   - Base ref: the current HEAD of the canonical issue branch (ensures workers include prior merged tasks).
   - Exact commands (from the shared repo clone `REPO`):
     - If the worker worktree dir already exists (e.g., from a prior run), remove it first:
       - `git -C <REPO> worktree remove --force <workerWorktreeDir>`
     - Create the worktree on a new branch based on the canonical branch:
       - `git -C <REPO> worktree add -B <workerBranch> <workerWorktreeDir> <canonicalBranch>`
       - Example: `git -C <REPO> worktree add -B issue/78-T1 <...>/issue-78-workers/<runId>/T1 issue/78`
3. Create a `.jeeves` symlink in the worker worktree pointing to the worker state directory (same pattern as `apps/viewer-server/src/init.ts`).

Cleanup behavior:
- “Archival” means retaining the canonical run directory `STATE/.runs/<runId>/...` (including per-worker logs/artifacts) for observability and post-mortems.
- On success:
  - Delete the worker git worktree after a successful merge:
    - `git -C <REPO> worktree remove --force <workerWorktreeDir>`
  - Delete the worker branch after a successful merge (to reduce repo clutter):
    - `git -C <REPO> branch -D <workerBranch>`
  - Retain the worker state directory under `STATE/.runs/<runId>/workers/<taskId>/` (do not delete).
- On failure/timeout:
  - Retain the worker state directory under `STATE/.runs/<runId>/workers/<taskId>/`.
  - Retain the worker git worktree directory and branch by default to support debugging and manual remediation.

#### 6.2.4 Parallel Process Management
- Extend viewer-server orchestration to manage multiple runner subprocesses concurrently while preserving the existing canonical phase loop:
  - Track a map of active worker processes keyed by `taskId`.
  - In canonical `implement_task`: spawn worker `implement_task` processes in parallel for the selected wave.
  - In canonical `task_spec_check`: spawn worker `task_spec_check` processes in parallel for the tasks recorded as the active wave.
- Runner invocation contract (MUST match current `packages/runner/src/cli.ts` behavior):
  - Worker processes MUST omit `--issue` and instead pass explicit `--state-dir` and `--work-dir`.
    - Reason: when `--issue` is provided, the runner derives `stateDir`/`cwd` from the XDG layout and ignores `--state-dir`/`--work-dir`.
  - Exact args per worker phase (invoked via the existing viewer-server `spawnRunner` mechanism):
    - Implement phase:
      - `run-phase --workflow <workflowName> --phase implement_task --provider <provider> --workflows-dir <workflowsDir> --prompts-dir <promptsDir> --state-dir <workerStateDir> --work-dir <workerWorktreeDir>`
    - Spec-check phase:
      - `run-phase --workflow <workflowName> --phase task_spec_check --provider <provider> --workflows-dir <workflowsDir> --prompts-dir <promptsDir> --state-dir <workerStateDir> --work-dir <workerWorktreeDir>`
  - Exact env:
    - `JEEVES_DATA_DIR=<dataDir>` (already set by viewer-server; not relied on for worker dir resolution when `--state-dir/--work-dir` are provided).
    - Optional model override per worker: `JEEVES_MODEL=<model>` (existing viewer-server behavior).
- Logging requirements:
  - Prefix viewer-run log lines with taskId to make interleaving readable:
    - Example: `[WORKER T1][STDOUT] ...`
  - Persist per-worker `last-run.log` and `sdk-output.json` under the worker state dir for drill-down.

Timeouts:
- `max_iterations` retains its current meaning: it is a global cap on the number of canonical workflow iterations (fresh-context subprocesses). In parallel mode, each wave consumes **two** iterations (one `implement_task`, one `task_spec_check`).
- Apply `iteration_timeout_sec` to the entire canonical iteration (wave step), consistent with the current viewer-server run loop behavior:
  - Start the timer when the first worker process is spawned for the iteration.
  - If exceeded, stop the run and terminate remaining workers (same as sequential mode).
- Apply `inactivity_timeout_sec` to the iteration as “no observable progress across any worker”:
  - Observable progress includes any worker stdout/stderr, changes in any worker `last-run.log`, or periodic orchestrator progress writes.
  - If exceeded, stop the run and terminate remaining workers.

#### 6.2.5 Result Aggregation and Merge
After a wave completes:
1. Read each worker’s verdict:
   - `taskPassed === true` → passed
   - `taskFailed === true` → failed
   - Otherwise → treat as failed (unverifiable).
2. Merge passed worker branches into canonical issue branch deterministically:
   - Merge order: stable sort by task ID.
   - Merge strategy: `git merge --no-ff` (one merge commit per task branch; preserves task commit history and makes attribution clear).
   - Passed tasks are merged even if other tasks in the same wave fail; partial successes are preserved.
   - If a merge conflict occurs while merging a passed task:
     - Abort the merge (`git merge --abort`),
     - mark the run as errored and stop (do not attempt to merge any remaining tasks),
     - treat the conflicted task as failed-to-integrate (see canonical status update below),
     - retain all worker worktrees/branches for debugging/remediation.
3. Update canonical `.jeeves/tasks.json` after merges (canonical status is “integrated + verified”):
   - For tasks that failed spec check or timed out: set `task.status = "failed"`.
   - For tasks that passed spec check and merged cleanly: set `task.status = "passed"`.
   - For tasks that passed spec check but hit a merge conflict: set `task.status = "failed"` and record merge-conflict details in the wave summary and `.jeeves/progress.txt`.
4. Persist a wave summary artifact in canonical state:
   - `STATE/.runs/<runId>/waves/<waveId>.json` containing:
     - scheduled task IDs, start/end timestamps,
     - per-task verdict, worker branch, exit codes, timeout flags,
     - merge result and merge order.

Failure propagation:
- Wave execution is non-cancelling by default for determinism and maximum salvage:
  - If one worker fails, other workers in the same wave continue to completion.
- Orchestration errors:
  - If sandbox creation/spawn fails, or a merge conflict occurs while merging a “passed” task, treat the run as errored and stop (do not attempt further waves).
- Retry integration (aligned with the existing task loop):
  - If any worker fails `task_spec_check`, set canonical `issue.json.status.taskFailed = true` (and `taskPassed = false`) so the workflow transitions back to `implement_task` for retries.
  - If all workers in the wave pass and there is remaining work, set `taskPassed = true`, `taskFailed = false`, and `hasMoreTasks = true` so the workflow continues to the next `implement_task` wave.
  - If all tasks are passed, set `allTasksComplete = true` to transition to `completeness_verification`.
- Required ordering of canonical updates after a wave:
  1. Ensure all worker processes have exited (or been marked timed out).
  2. Write the wave summary artifact to `STATE/.runs/<runId>/waves/<waveId>.json`.
  3. Merge passed task branches in deterministic order.
  4. Update canonical `.jeeves/tasks.json` statuses (per rules above).
  5. Persist failure details for retry:
     - If worker `.jeeves/task-feedback.md` exists, copy it into canonical `.jeeves/task-feedback/<taskId>.md`.
     - If the failure reason is merge conflict or timeout, write a synthetic feedback file under `.jeeves/task-feedback/<taskId>.md` describing the reason and pointers to `STATE/.runs/<runId>/...`.
  6. Append a single wave summary entry to canonical `.jeeves/progress.txt` including the run verdict and next steps.

#### 6.2.6 API and Status Contracts
If the viewer UI needs to show concurrent tasks, extend the run status payload (broadcast via websocket/SSE):
- `run.workers`: array of:
  - `taskId: string`
  - `phase: "implement_task" | "task_spec_check"`
  - `pid: number | null`
  - `started_at: string`
  - `ended_at: string | null`
  - `returncode: number | null`
  - `status: "running" | "passed" | "failed" | "timed_out"`

`POST /api/run` additions:
- Request:
  - `max_parallel_tasks?: number`
- Response:
  - unchanged schema, but `run.max_parallel_tasks` is included for observability (optional).
Status codes:
- `200` on successful start.
- `400` for invalid `max_parallel_tasks` (non-integer, < 1, or `> MAX_PARALLEL_TASKS`).
- `409` if a run is already active.
- `500` for orchestration failures (e.g., worker sandbox creation errors).

#### 6.2.7 Canonical Workflow Integration (Parallel Mode)
When `issue.json.settings.taskExecution.mode="parallel"` is enabled, viewer-server remains the canonical workflow owner and keeps the existing `implement_task → task_spec_check → implement_task ...` phase transitions deterministic:
- Viewer-server MUST special-case execution for the canonical task phases:
  - In canonical `implement_task`, do not run the canonical prompt. Instead, run an **implement wave** in worker sandboxes for the selected ready tasks.
  - In canonical `task_spec_check`, do not run the canonical prompt. Instead, run a **spec-check wave** in worker sandboxes for the tasks from the preceding implement wave, then merge/update canonical state.
- Viewer-server MUST still advance `issue.json.phase` using the existing `WorkflowEngine` transition rules after each canonical iteration, relying on the canonical `issue.json.status.*` flags computed by the orchestrator (not by prompts).

Required canonical status fields after a `task_spec_check` wave (to satisfy `workflows/default.yaml` guards):
- If any task failed spec-check (or is unverifiable): set
  - `status.taskPassed = false`
  - `status.taskFailed = true`
  - `status.hasMoreTasks = true`
  - `status.allTasksComplete = false`
- If all wave tasks passed and there exists any task with `status !== "passed"`: set
  - `status.taskPassed = true`
  - `status.taskFailed = false`
  - `status.hasMoreTasks = true`
  - `status.allTasksComplete = false`
- If all tasks are passed: set
  - `status.taskPassed = true`
  - `status.taskFailed = false`
  - `status.hasMoreTasks = false`
  - `status.allTasksComplete = true`

Wave linkage across canonical phases:
- Persist the active wave selection in canonical `issue.json.status.parallel` so the following canonical phase is deterministic:
  - `status.parallel.activeWaveId: string`
  - `status.parallel.activeWaveTaskIds: string[]`
- In canonical `implement_task`: populate `activeWave*` immediately after selecting tasks (before spawning workers).
- In canonical `task_spec_check`: consume `activeWaveTaskIds`, then clear `status.parallel` after the wave is summarized/merged.

### 6.3 Operational Considerations
- **Deployment**:
  - No external services required; feature ships as code changes to viewer-server/runner and (optionally) viewer UI.
  - Keep feature behind opt-in config during rollout.
- **Telemetry & Observability**:
  - Persist wave summaries and worker logs for auditability.
  - Ensure viewer-run.log prefixes include taskId for interleaving clarity.
- **Security & Compliance**:
  - Do not log secrets from environment variables or provider credentials.
  - Worker state dirs may contain model outputs; keep them under the existing `.jeeves` state directory and respect existing data retention expectations.

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(viewer-server): add deterministic task dependency scheduler | Parse/validate `.jeeves/tasks.json`, build DAG, compute ready set | Runtime Implementation Agent | Design approval | Scheduler rejects cycles/missing IDs; ready selection deterministic; unit tests added |
| feat(viewer-server): add worker sandbox creation utilities | Create per-task state/worktree, `.jeeves` link, branch naming | Runtime Implementation Agent | Scheduler utilities | Worker dirs created/cleaned correctly; branch based on canonical HEAD; unit tests where feasible |
| feat(viewer-server): execute tasks in parallel waves | Run implement/spec phases concurrently with max concurrency and timeouts | Runtime Implementation Agent | Sandbox utilities | Up to N workers run; logs are prefixed; timeouts fail deterministically |
| feat(viewer-server): merge worker results into canonical branch | Merge passed branches; update canonical tasks state and wave summaries | Runtime Implementation Agent | Parallel execution | Passed tasks merged in stable order; conflicts abort cleanly; canonical tasks.json updated |
| feat(api/viewer): surface worker status and configuration | API param `max_parallel_tasks` and run status includes workers | Viewer + API Agent | Parallel execution | API validates param; viewer shows active workers and statuses |
| test: cover parallel scheduling and merge failure modes | Add tests for DAG validation, selection, worker lifecycle, merge errors | Test Agent | All above | `pnpm test` passes; new tests cover cycles, timeouts, merge conflicts |

### 7.2 Milestones
- **Phase 1**: Deterministic scheduling + worker sandbox execution (no UI)
  - Gating: unit tests for scheduler; parallel worker logs prefixed; feature behind config.
- **Phase 2**: UI and API surfacing
  - Gating: viewer shows worker list/status; operator can diagnose failures.

### 7.3 Coordination Notes
- **Hand-off Package**:
  - Key files: `apps/viewer-server/src/runManager.ts`, `apps/viewer-server/src/init.ts`, `packages/runner/src/cli.ts`, prompt files under `prompts/`.
  - Artifacts: `.jeeves/tasks.json`, `.jeeves/issue.json`, `.jeeves/progress.txt`.
- **Communication Cadence**:
  - Review checkpoint after Phase 1 to validate concurrency/merge semantics before UI changes.

## 8. Agent Guidance & Guardrails
- **Context Packets**:
  - Read and understand `.jeeves/tasks.json` schema and existing prompts (`prompts/task.decompose.md`, `prompts/task.implement.md`, `prompts/task.spec_check.md`).
  - Inspect `apps/viewer-server/src/runManager.ts` process lifecycle and logging patterns.
- **Prompting & Constraints**:
  - Keep parallel execution opt-in and bounded (`maxParallelTasks`).
  - Prefer deterministic, conservative behavior over “smart” heuristics in scheduling/merging.
- **Safety Rails**:
  - Never run multiple agents in the same worktree/state directory concurrently.
  - Abort safely on merge conflicts; do not attempt auto-resolution.
  - Do not delete worker artifacts on failure unless explicitly configured.
- **Validation Hooks**:
  - `pnpm lint && pnpm typecheck && pnpm test`
  - Manual sanity: start viewer-server, run a small multi-task issue with `max_parallel_tasks=2`, confirm logs and branch merges.

## 9. Alternatives Considered
1. **In-place parallelism in a single worktree**: rejected due to unavoidable filesystem and `.jeeves/*` races.
2. **Prompt-only scheduling (agents pick tasks with locks)**: rejected because it makes orchestration non-deterministic and harder to test.
3. **Parallelizing only evaluation phases**: insufficient; implementation time dominates for many tasks.
4. **Always create a PR per task and merge via GitHub**: higher overhead; requires GitHub API integration and complicates local runs.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - DAG validation:
    - missing dependency ID fails
    - cycle fails with clear message
    - ready-set computation matches expected tasks for mixed statuses
  - Wave selection:
    - stable ordering
    - max concurrency respected
  - Worker lifecycle:
    - worker dirs created, `.jeeves` link present, cleanup on success
  - Merge handling:
    - successful merge updates canonical tasks.json
    - merge conflict aborts and writes progress entry
- **Performance**:
  - Smoke benchmark: run with 2–3 independent tasks and confirm wall-clock reduction vs sequential.
- **Tooling / A11y**:
  - If UI is added: verify Watch page shows worker list and is navigable without relying on color alone.

## 11. Risks & Mitigations
- **Merge conflicts reduce value of parallelism**:
  - Mitigation: default to conservative concurrency; prefer tasks with disjoint `filesAllowed` patterns when selecting a wave (optional enhancement).
- **Complexity in orchestration and debug**:
  - Mitigation: persist wave summaries and keep per-worker artifacts on failure.
- **Stale or conflicting status flags**:
  - Mitigation: worker issue.json initialization must clear task-loop flags; canonical state updates happen only in orchestrator code.
- **Provider cost increases**:
  - Mitigation: cap `maxParallelTasks` at `MAX_PARALLEL_TASKS` (8), and optionally limit parallelism for expensive phases (Open Questions).

## 12. Rollout Plan
- **Milestones**:
  1. Ship behind opt-in config in `.jeeves/issue.json.settings.taskExecution.mode="parallel"`.
  2. Add API override parameter and basic UI surfacing.
  3. Consider making parallel the default once stable.
- **Migration Strategy**:
  - No migration required; existing task lists continue to work. `dependsOn` remains optional.
- **Communication**:
  - Document usage in `docs/` and add a brief note to viewer-server API docs if the API changes ship.

## 13. Open Questions
1. Should the scheduler consider `filesAllowed` overlap heuristics to avoid parallelizing likely-conflicting tasks?
2. Do we want to expose `max_parallel_tasks` in the UI, the API only, or also via environment variables?
3. Do we want phase-specific parallelism caps (e.g., allow higher parallelism for spec-check than implementation) to manage cost?

## 14. Follow-Up Work
- Add a dedicated UI for per-task logs and SDK outputs (drill-down by taskId).
- Add a “dry run” mode that computes the parallel schedule without executing tasks.
- Add optional task metadata for conflict avoidance (e.g., `exclusivePaths`, `parallelSafe`).

## 15. References
- `apps/viewer-server/src/runManager.ts`
- `apps/viewer-server/src/init.ts`
- `packages/runner/src/cli.ts`
- `prompts/task.decompose.md`
- `prompts/task.implement.md`
- `prompts/task.spec_check.md`
- GitHub Issue #78: https://github.com/hansjm10/jeeves/issues/78

## Appendix A — Glossary
- **Canonical state/worktree**: The primary `.jeeves/` state directory and issue worktree used to produce the final PR branch.
- **Worker sandbox**: Per-task isolated state directory + git worktree/branch used to run a task concurrently without races.
- **Wave**: A batch of concurrently executed tasks selected from the ready set (bounded by `maxParallelTasks`).

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2026-02-03 | Jeeves Agent (Codex CLI) | Initial draft |
