# Design: Progress Estimation After Task Decomposition

**Issue**: #80
**Status**: Draft - Classification Complete
**Feature Types**: Primary: Data Model, Secondary: API, UI

---

## 1. Scope

### Problem
Users have no visibility into how long a workflow will take. They watch iterations happen without knowing if completion is 5 or 50 iterations away, making it difficult to plan around Jeeves runs.

### Goals
- [ ] Track and persist historical metrics in `$JEEVES_DATA_DIR/metrics/` (default: `~/.local/share/jeeves/metrics/`):
  - Iterations per phase per issue
  - Task retry counts
  - Design review pass rates
- [ ] After tasks are decomposed (end of `design_plan` / “task_decomposition”), compute and persist an estimate payload matching Issue #80 (`estimatedIterations`, `breakdown`, `tasks`, `historicalAverage`)
- [ ] Expose the estimate + phase breakdown to the viewer (via viewer-server state/streaming)
- [ ] Display estimated vs actual iterations in the viewer UI alongside current progress

### Non-Goals
- Predicting duration in wall-clock time (iteration time varies too much)
- Estimating individual task complexity or difficulty
- Providing confidence intervals or uncertainty bounds
- Auto-adjusting maxIterations based on estimates
- Historical analysis dashboard or trend visualization

### Boundaries
- **In scope**:
  - Maintaining a metrics store under `$JEEVES_DATA_DIR/metrics/` (derived from run archives)
  - Using existing run archives under the issue state directory (`STATE/.runs/…`) as the raw source for metrics backfill/updates
  - Producing an iteration-based estimate (count), not a time-based prediction
  - Persisting the estimate in issue state (`STATE/issue.json`) so it survives refreshes/restarts
  - Displaying the estimate in the viewer UI (Watch page)
- **Out of scope**:
  - ML-based prediction models
  - Per-task iteration estimation
  - Real-time estimate refinement during execution
  - Cross-repository learning (estimates are per-repo)

---

## 2. Workflow
N/A - This feature does not involve workflow or state machine changes.

## 3. Interfaces

This feature is **additive**: it introduces a typed estimate payload that the viewer can read over HTTP and receive live over SSE/WS.

### Endpoints
| Method | Path | Input | Success | Errors |
|--------|------|-------|---------|--------|
| GET | /api/state | No params. | 200: `IssueStateSnapshot` (extended; see below). | 403: origin not allowed (`{ ok:false, error }`) |
| GET | /api/issue/estimate | No params. Uses the **currently selected** issue on the viewer-server. | 200: `{ ok:true, issue_ref:string, estimate: IssueEstimate \| null }` | 400: no issue selected; 404: `issue.json` missing; 403: origin not allowed; 500: I/O/parsing errors (`{ ok:false, error }`) |

#### `IssueStateSnapshot` (extension)
`GET /api/state` and the streaming `state` event add one new optional field:
```ts
type IssueStateSnapshot = {
  issue_ref: string | null;
  paths: { dataDir: string; stateDir: string | null; workDir: string | null; workflowsDir: string; promptsDir: string };
  issue_json: Record<string, unknown> | null;
  run: RunStatus;

  // New (additive)
  estimate?: IssueEstimate | null;
};
```

### CLI Commands (if applicable)
N/A - no new CLI commands in this feature.

### Events (if applicable)
| Event | Trigger | Payload | Consumers |
|-------|---------|---------|-----------|
| `issue-estimate` | Fired when the selected issue’s estimate becomes available or changes (including resets). Also sent once on new SSE/WS connection after the initial `state` snapshot. | `{ issue_ref: string, estimate: IssueEstimate \| null }` | Viewer UI (Watch/progress display), optional future CLI clients consuming SSE |

Notes:
- Transport is the existing `GET /api/stream` (SSE) and `GET /api/ws` (WebSocket). No new streaming endpoints are introduced.
- Event names are kebab-case to match existing conventions (`sdk-init`, `viewer-logs`, `sonar-token-status`).
- “Only when estimate value changes” semantics: viewer-server keeps the last emitted `{ issue_ref, estimate }` and emits a new `issue-estimate` only when a normalized deep-equal comparison differs (normalization: treat missing breakdown keys as `0`, ignore unknown breakdown keys, and treat `undefined` vs `null` as equivalent at the top-level `estimate` field).

### Validation Rules
All validation is **synchronous**.

| Field | Type | Constraints | Error |
|------|------|-------------|-------|
| `issue_ref` | string | required; must match selected issue `owner/repo#N` | `issue_ref is invalid` (400) |
| `estimate.estimatedIterations` | number | required; integer ≥ 0 | Treat estimate as unavailable (`estimate:null`); emit `viewer-error` |
| `estimate.breakdown` | object | required; all 5 keys present; all values integers ≥ 0 | Treat estimate as unavailable (`estimate:null`); emit `viewer-error` |
| `estimate.tasks` | number | required; integer ≥ 0 | Treat estimate as unavailable (`estimate:null`); emit `viewer-error` |
| `estimate.historicalAverage.iterationsPerTask` | number | required; finite number ≥ 0 | Treat estimate as unavailable (`estimate:null`); emit `viewer-error` |
| `estimate.historicalAverage.designPassRate` | number | required; finite number in [0, 1] | Treat estimate as unavailable (`estimate:null`); emit `viewer-error` |

Validation failure behavior:
- **Client input validation** (for endpoints with inputs): respond `400` with `{ ok:false, error:"..." }`.
- **Server-state validation** (invalid/partial estimate persisted to `issue.json`): treat the estimate as unavailable and:
  - return `200` with `estimate: null` from `GET /api/issue/estimate`, and/or
  - emit `viewer-error` with a message indicating the estimate payload is invalid.

### Estimate Contract (`IssueEstimate`)
The payload shape matches Issue #80’s proposal.

```ts
type IssueEstimate = {
  // Total estimated iterations remaining after decomposition.
  // Must equal the sum of breakdown values.
  estimatedIterations: number; // int >= 0

  // Issue #80 breakdown buckets (v1).
  breakdown: {
    design: number; // int >= 0
    implementation: number; // int >= 0
    specCheck: number; // int >= 0
    completenessVerification: number; // int >= 0
    prAndReview: number; // int >= 0
  };

  // Inputs used for estimation.
  tasks: number; // int >= 0 (count of tasks at decomposition time)
  historicalAverage: {
    iterationsPerTask: number; // finite number >= 0
    designPassRate: number; // finite number in [0, 1]
  };
};
```

#### Mapping to Issue #80 example JSON
- `estimatedIterations` is the total estimate (remaining after decomposition).
- `breakdown.*` is the category breakdown for the same remaining window and MUST sum to `estimatedIterations`.
- `tasks` is the number of tasks present in `STATE/tasks.json` when the estimate is computed.
- `historicalAverage.iterationsPerTask` and `historicalAverage.designPassRate` are computed from the metrics store in `$JEEVES_DATA_DIR/metrics/` (see §4).

### UI Interactions (if applicable)
| Action | Request | Loading State | Success | Error |
|--------|---------|---------------|---------|-------|
| Open Watch/progress view | Connect WS `GET /api/ws` (or SSE `GET /api/stream`) and wait for `state` then `issue-estimate` | Show “Estimate: calculating…” when `estimate` is `null` | Render “Estimated total: X iterations” and per-phase breakdown; update whenever a new `issue-estimate` arrives | Show “Estimate unavailable” (non-blocking) and surface details in Logs if `viewer-error` emitted |

### Contract Notes (Breaking/Versioning)
- **Breaking change?** No. All changes are additive:
  - `GET /api/state` / `state` event gain an optional `estimate` field.
  - `GET /api/issue/estimate` and `issue-estimate` are new interfaces.
- **Migration path**: existing clients continue working unchanged; clients may opt into rendering estimates by reading the new field/event.
- **Versioning**: no new API version required for v1. Consumers must treat unknown fields and unknown events as ignorable.

## 4. Data

This feature persists:
1) a metrics store under `$JEEVES_DATA_DIR/metrics/` (required by Issue #80), and
2) an iteration-based estimate in issue state so the viewer can display it across refreshes/restarts.

**Terminology**
- `STATE` = the selected issue state directory, i.e. `$JEEVES_DATA_DIR/issues/<owner>/<repo>/<issueNumber>`
- `METRICS` = `$JEEVES_DATA_DIR/metrics` (default: `~/.local/share/jeeves/metrics`)

### Schema Changes
| Location | Field | Type | Required | Default | Constraints |
|----------|-------|------|----------|---------|-------------|
| `STATE/issue.json` | `estimate` | `IssueEstimate \| null` | no | `null` | If non-null, must satisfy all constraints in §3 |
| `METRICS/<owner>-<repo>.json` | (file) | JSON | yes | — | Must be valid JSON; schema described below |

### Metrics Store (`METRICS/<owner>-<repo>.json`)
Single JSON document per repo, written with atomic JSON writes.

```ts
type RepoMetricsFileV1 = {
  schemaVersion: 1;
  repo: string; // "owner/repo"
  updated_at: string; // ISO-8601

  // Dedup: which run archives have been incorporated into this metrics file.
  processed_run_ids: string[]; // unique

  // Required metrics (Issue #80).
  iterations_per_phase_per_issue: Record<
    string, // issue_ref: "owner/repo#N"
    Record<string, Record<string, number>> // workflow -> (phase -> iteration count)
  >;

  task_retry_counts: Record<
    string, // issue_ref
    Record<
      string, // workflow
      {
        total_retries: number; // int >= 0
        retries_per_task: number; // mean retries per task (finite >= 0)
      }
    >
  >;

  // "Pass rate" = percent of design_review attempts that approve without requiring design_edit.
  design_review_pass_rates: Record<
    string, // workflow
    {
      attempts: number; // int >= 0
      passes: number; // int >= 0
      pass_rate: number; // passes / attempts (finite in [0,1] when attempts>0)
    }
  >;
};
```

### Field Definitions
**`estimate`**
- Purpose: Persist a stable, iteration-count estimate after decomposition so the viewer can show “estimated remaining iterations” without recomputing on every refresh.
- Set by: Viewer-server orchestration after decomposition (end of `design_plan` / “task_decomposition”).
- Read by: `GET /api/state` (as `state.estimate`), `GET /api/issue/estimate`, and the `issue-estimate` stream event.
- Deletion/invalidation:
  - If the issue is reset (phase reset / rerun from scratch): set `estimate` back to `null`.
  - If the workflow selection changes: set `estimate` back to `null` and wait to recompute after the next decomposition.

**`METRICS/<owner>-<repo>.json`**
- Purpose: Persist required historical metrics (Issue #80) derived from run archives, so estimation is fast and deterministic.
- Update trigger: After a successfully completed run is finalized (run archive finalized), incorporate that run’s data into the metrics file.
- Dedup: A run archive is processed at most once using `processed_run_ids`.

### Derivation
Both metrics and the estimate are derived from run archives.

**Eligible historical runs**
- MUST have `STATE/.runs/<run_id>/run.json` with `completed_via_state === true` OR `completed_via_promise === true`
- MUST have `exit_code === 0`
- MUST have at least 1 `STATE/.runs/<run_id>/iterations/*/iteration.json`

**Workflow matching (explicit fields)**
- Resolve the run’s workflow name from `STATE/.runs/<run_id>/iterations/001/iteration.json.workflow`.
- If missing, fall back to `STATE/.runs/<run_id>/final-issue.json.workflow` (or `iterations/*/issue.json.workflow`).
- A historical run is eligible for metrics/estimation only when this resolved workflow name equals the active issue workflow name.

**Metrics extraction (Issue #80 required metrics)**
- Iterations per phase per issue:
  - Count `iteration.json.phase` occurrences per run and store under `iterations_per_phase_per_issue[issue_ref][workflow][phase]`.
- Task retry counts:
  - Use `iterations/*/tasks.json` snapshots and count each time a task transitions from `failed -> pending`.
  - Store `total_retries` and `retries_per_task = total_retries / tasks` (where `tasks` is the task count at decomposition time, if available; otherwise the final task count).
- Design review pass rates:
  - Count each `design_review` iteration as an `attempt`.
  - Count a `pass` when the `design_review` result transitions to `pre_implementation_check` (i.e. `status.designApproved === true` and `status.designNeedsChanges !== true` in the archived issue state).

**Estimate computation (Issue #80 method)**
1. Read `tasks` from `STATE/tasks.json` (task count at decomposition time). If missing, `estimate:null`.
2. Read repo metrics from `METRICS/<owner>-<repo>.json` for the active workflow. If missing or insufficient history, `estimate:null`.
3. Compute `historicalAverage`:
   - `iterationsPerTask`: mean `implement_task_iterations / tasks` across eligible runs for this workflow (finite ≥ 0).
   - `designPassRate`: `passes / attempts` from `design_review_pass_rates[workflow]` (finite in [0,1]).
4. Compute `breakdown`:
   - `design`: expected number of `design_review` attempts remaining, computed as `ceil(1 / max(designPassRate, 0.01))` (clamp to a reasonable max to avoid unbounded estimates).
   - `implementation`: `ceil(tasks * iterationsPerTask)`.
   - `specCheck`: buffer for retries computed as `ceil(tasks * retries_per_task)`.
   - `completenessVerification`: mean iterations for `completeness_verification` (from `iterations_per_phase_per_issue` aggregates).
   - `prAndReview`: mean iterations for `prepare_pr`, `code_review`, and `code_fix` (from `iterations_per_phase_per_issue` aggregates).
5. Set `estimatedIterations = sum(breakdown.*)` and persist to `STATE/issue.json.estimate`.

**Timing**
- Metrics update: when a run is finalized (post-archive), update `METRICS/<owner>-<repo>.json` once per run.
- Estimate update: computed once at the end of `design_plan` / decomposition.

### Migrations
| Change | Existing Data | Migration | Rollback |
|--------|---------------|-----------|----------|
| Add `issue.json.estimate` | Field absent | Treat as `null` (estimate unavailable) until computed | Remove `estimate` field (or set to `null`) |

### Artifacts
| Artifact | Location | Created | Updated | Deleted |
|----------|----------|---------|---------|---------|
| Repo metrics file | `METRICS/<owner>-<repo>.json` | On first run completion (or on-demand backfill) | After each successfully completed run archive finalization | Never automatically (user-managed) |
| `estimate` (stored inside issue state) | `STATE/issue.json` | Immediately after decomposition completes and an estimate is available | When recomputed after a subsequent decomposition for the same issue | Set to `null` on issue reset or workflow change |
| Archived copies including `estimate` | `STATE/.runs/<run_id>/final-issue.json` and `STATE/.runs/<run_id>/iterations/<n>/issue.json` | Automatically by existing run archiving when `estimate` is present in `STATE/issue.json` | N/A | Never (archives are immutable once written) |

### Artifact Lifecycle
| Scenario | Artifact Behavior |
|----------|-------------------|
| Success | `STATE/issue.json` includes a valid `estimate` object; archived copies capture it when runs are archived |
| Failure | If estimate computation or validation fails, persist `estimate: null` (do not write partial/invalid objects) and emit a non-blocking `viewer-error` |
| Crash recovery | Writes to `STATE/issue.json` use atomic JSON writes; on restart, if `estimate` is missing or invalid it is treated as `null` and can be recomputed after the next decomposition (end of `design_plan`) |

## 5. Tasks

### Planning Gates

**Decomposition Gates**
1. **Smallest independently testable unit**: (a) a pure “estimate-from-metrics” function that, given `tasks` and repo metrics aggregates, returns either a valid `IssueEstimate` or `null`, and (b) a deterministic “update-metrics-from-run-archive” function that ingests one finalized `STATE/.runs/<run_id>/` directory into `METRICS/<owner>-<repo>.json` with dedup by `processed_run_ids`.
2. **Dependencies between tasks**: yes — persistence wiring depends on the estimate computation utilities; API/stream exposure depends on the shared contract and runtime validation; viewer UI depends on viewer stream/types.
3. **Parallelizable tasks**: yes — after core computation utilities exist, server persistence wiring (T2) and server API/stream exposure (T3) can proceed in parallel; viewer stream/types (T4) and UI work (T5) can proceed once T3 is in place.

**Task Completeness Gates (applies to all tasks)**
4. **Files**: each task below enumerates exact files to create/modify.
5. **Acceptance criteria**: each task below lists concrete, verifiable outcomes.
6. **Verification**: each task below includes a specific `pnpm test -- <file>` command (plus global `pnpm typecheck/lint/test` in §6).

**Ordering Gates**
7. **Must be done first**: define the `IssueEstimate` contract + metrics store schema + runtime validation + estimate/metrics utilities (T1).
8. **Must be done last**: viewer UI wiring and manual UX verification in `pnpm dev` (T5 + §6 manual checks).
9. **Circular dependencies**: none (tasks form a DAG).

**Infrastructure Gates**
10. **Build/config changes needed**: none expected (additive TS files + tests only).
11. **New dependencies**: none expected.
12. **Env vars/secrets**: none new; uses existing `$JEEVES_DATA_DIR` behavior to locate run archives.

### Goal → Task Mapping (Traceability)
- Track and persist required historical metrics (`$JEEVES_DATA_DIR/metrics/`) → **T1**, **T2**
- Compute and persist an estimate after decomposition (end of `design_plan` / “task_decomposition”) → **T2**
- Expose the estimate + phase breakdown to the viewer → **T3**, **T4**
- Display estimated vs actual iterations in the viewer UI → **T5**

### Task Dependency Graph
```
T1 (no deps)
T2 → depends on T1
T3 → depends on T1
T4 → depends on T3
T5 → depends on T4
```

### Task Breakdown
| ID | Title | Summary | Files | Acceptance Criteria |
|----|-------|---------|-------|---------------------|
| T1 | Metrics + estimate utilities | Implement the metrics file schema (`METRICS/<owner>-<repo>.json`), runtime validation, and deterministic utilities to (a) ingest finalized run archives into metrics and (b) compute `IssueEstimate` from metrics + task count. | `apps/viewer-server/src/metricsStore.ts`, `apps/viewer-server/src/issueEstimate.ts` | Unit tests cover metrics ingestion (iterations/phase, retry counting, design pass rate) and estimate computation matching Issue #80 fields. |
| T2 | Persist metrics + estimate | Update metrics on successful run finalization and compute+atomically write `estimate` into `STATE/issue.json` when transitioning off decomposition (`design_plan`). Clear estimate on workflow change/reset. | `apps/viewer-server/src/runManager.ts` | Metrics are updated once per run (dedup by run_id) and `STATE/issue.json.estimate` is always either a fully valid `IssueEstimate` or `null` (never partial). |
| T3 | Expose estimate over API + stream | Add `GET /api/issue/estimate`, extend `GET /api/state` + `state` event with `estimate`, and emit `issue-estimate` events on connect/change. | `apps/viewer-server/src/server.ts` | `GET /api/issue/estimate` returns validated `{ estimate }`; WS/SSE send `issue-estimate` after initial `state` and on estimate changes. |
| T4 | Viewer stream support | Teach viewer stream layer to consume `issue-estimate` and merge it into client state. | `apps/viewer/src/stream/*`, `apps/viewer/src/api/types.ts` | Reducer/provider tests prove estimate updates without requiring a full `state` refresh. |
| T5 | Watch UI display | Render estimated remaining/total iterations + phase breakdown on Watch page next to actual progress. | `apps/viewer/src/pages/WatchPage.tsx` | UI tests cover `estimate:null`, valid estimate rendering, and phase breakdown formatting. |

### Task Details

**T1: Metrics + estimate utilities**
- Summary: Implement the metrics store required by Issue #80 (`METRICS/<owner>-<repo>.json`) and deterministic utilities to ingest one finalized run archive into metrics and compute an `IssueEstimate` from metrics + task count.
- Files:
  - `apps/viewer-server/src/metricsStore.ts` - `RepoMetricsFileV1` types + validation + `ingestRunArchiveIntoMetrics(...)`
  - `apps/viewer-server/src/metricsStore.test.ts` - unit tests for per-phase counts, retry counting, design pass-rate updates, and run_id dedup
  - `apps/viewer-server/src/issueEstimate.ts` - `IssueEstimate` types + validation + `computeIssueEstimateFromMetrics(...)`
  - `apps/viewer-server/src/issueEstimate.test.ts` - unit tests that the computed payload matches Issue #80 field shape and invariants (sum of breakdown equals `estimatedIterations`, null on insufficient history)
- Acceptance Criteria:
  1. Metrics ingestion uses explicit workflow matching (`iterations/001/iteration.json.workflow`, with fallback) and filters eligible runs via `run.json` completion flags and `exit_code === 0`.
  2. Metrics store includes all Issue #80 required metrics: iterations per phase per issue, task retry counts, and design review pass rates (with dedup by `processed_run_ids`).
  3. Estimation uses Issue #80 fields (`estimatedIterations`, `breakdown`, `tasks`, `historicalAverage`) and returns `null` when required inputs/metrics are missing or insufficient.
- Dependencies: None
- Verification: `pnpm test -- apps/viewer-server/src/metricsStore.test.ts && pnpm test -- apps/viewer-server/src/issueEstimate.test.ts`

**T2: Persist metrics + estimate**
- Summary: Wire metrics ingestion and estimate computation into viewer-server orchestration: update `METRICS/<owner>-<repo>.json` on successful run finalization, and compute+persist `STATE/issue.json.estimate` when transitioning off decomposition (`design_plan`).
- Files:
  - `apps/viewer-server/src/runManager.ts` - ingest finalized runs into metrics; compute+persist estimate; clear estimate on workflow switch/reset
  - `apps/viewer-server/src/runManager.test.ts` - integration test using a temporary `$JEEVES_DATA_DIR` fixture with synthetic `.runs` history + metrics file
- Acceptance Criteria:
  1. Each successfully completed run finalization updates `METRICS/<owner>-<repo>.json` exactly once (dedup by run_id) and never corrupts the file (atomic write).
  2. When transitioning off decomposition (`design_plan`), `STATE/issue.json.estimate` becomes either a fully valid `IssueEstimate` or `null` (never partially written).
  3. If the issue workflow is switched (no override) or the issue is reset to a pre-decomposition phase, `estimate` is set back to `null`.
- Dependencies: T1
- Verification: `pnpm test -- apps/viewer-server/src/runManager.test.ts`

**T3: Expose estimate over API + stream**
- Summary: Make estimates visible to clients via HTTP and streaming, without breaking existing consumers.
- Files:
  - `apps/viewer-server/src/types.ts` - add `IssueEstimate` type and extend `IssueStateSnapshot` with `estimate?: IssueEstimate | null`
  - `apps/viewer-server/src/server.ts` - implement `GET /api/issue/estimate`; include validated `estimate` in `GET /api/state`; emit `issue-estimate` on connect and on changes (including resets)
  - `apps/viewer-server/src/runManager.ts` - ensure `state` events broadcast during runs include `estimate` (and match the server snapshot shape)
  - `apps/viewer-server/src/server.test.ts` - endpoint + streaming contract tests (HTTP + WS + SSE as applicable)
- Acceptance Criteria:
  1. `GET /api/issue/estimate` returns `400` when no issue is selected; returns `200` with `{ ok:true, issue_ref, estimate }` when selected (and `estimate` is validated or `null`).
  2. `GET /api/state` and streamed `state` snapshots include `estimate` as `null` or a valid estimate object.
  3. On new WS/SSE connections, an `issue-estimate` event is sent once after the initial `state` snapshot; subsequent `issue-estimate` events emit only when the estimate value changes.
- Dependencies: T1
- Verification: `pnpm test -- apps/viewer-server/src/server.test.ts`

**T4: Viewer stream support**
- Summary: Extend the viewer client’s stream contract to accept `issue-estimate` events and update local state immediately.
- Files:
  - `apps/viewer/src/api/types.ts` - add `IssueEstimate` type and `IssueEstimateEvent` payload contract
  - `apps/viewer/src/stream/streamTypes.ts` - add an `issue-estimate` action type
  - `apps/viewer/src/stream/ViewerStreamProvider.tsx` - dispatch the new action on `event === 'issue-estimate'`
  - `apps/viewer/src/stream/streamReducer.ts` - merge `estimate` into `state` without clearing `runOverride`
  - `apps/viewer/src/stream/streamReducer.test.ts` - reducer unit tests for estimate updates
- Acceptance Criteria:
  1. Receiving `issue-estimate` updates `stream.state.estimate` (and does not require a full `state` refresh).
  2. Viewer continues to treat unknown events as SDK events (no breaking behavior).
- Dependencies: T3
- Verification: `pnpm test -- apps/viewer/src/stream/streamReducer.test.ts`

**T5: Watch UI display**
- Summary: Display “estimated remaining/total iterations” and a per-phase breakdown on the Watch page, alongside current iteration progress.
- Files:
  - `apps/viewer/src/pages/WatchPage.tsx` - render estimate block in the Watch/progress area; handle `null` (unavailable/calculating) states
  - `apps/viewer/src/pages/WatchPage.css` - styles using existing tokens (no hex colors)
  - `apps/viewer/src/pages/WatchPage.test.ts` - UI tests for estimate rendering and formatting
- Acceptance Criteria:
  1. When `estimate` is `null`, the Watch page shows a non-blocking “Estimate unavailable” (or “calculating…”) state without breaking layout.
  2. When `estimate` is present, the Watch page shows `estimatedIterations`, `tasks`, and the five `breakdown` buckets; it also displays `historicalAverage` values used for the estimate.
  3. UI displays actual progress (current iteration) alongside estimate (e.g., “Actual: i/max, Estimated total: N”).
- Dependencies: T4
- Verification: `pnpm test -- apps/viewer/src/pages/WatchPage.test.ts`

## 6. Validation

### Pre-Implementation Checks
- [ ] All dependencies installed: `pnpm install`
- [ ] Types check: `pnpm typecheck`
- [ ] Existing tests pass: `pnpm test`

### Post-Implementation Checks
- [ ] Types check: `pnpm typecheck`
- [ ] Lint passes: `pnpm lint`
- [ ] All tests pass: `pnpm test`
- [ ] New tests added for:
  - `apps/viewer-server/src/metricsStore.test.ts`
  - `apps/viewer-server/src/issueEstimate.test.ts`
  - `apps/viewer-server/src/server.test.ts` (estimate API + stream)
  - `apps/viewer-server/src/runManager.test.ts` (persistence wiring)
  - `apps/viewer/src/stream/streamReducer.test.ts` (client merge)
  - `apps/viewer/src/pages/WatchPage.test.ts` (UI rendering)

### Manual Verification (Viewer)
- [ ] Start the stack: `pnpm dev`
- [ ] Select an issue that has historical `.runs` archives under `$JEEVES_DATA_DIR/issues/<owner>/<repo>/*/.runs/*`
- [ ] Start a run and observe:
  - After tasks are decomposed (end of `design_plan` / “task_decomposition”), the Watch page shows an estimate (or “unavailable” if insufficient history)
  - Refreshing the page preserves the estimate (read from `STATE/issue.json`)
  - Changing workflow or resetting the issue clears the estimate (back to `null`) and emits a new `issue-estimate` event
