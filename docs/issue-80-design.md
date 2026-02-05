# Design: Progress Estimation After Task Decomposition

**Issue**: #80
**Status**: Draft - Classification Complete
**Feature Types**: Primary: Data Model, Secondary: API, UI

---

## 1. Scope

### Problem
Users have no visibility into how long a workflow will take. They watch iterations happen without knowing if completion is 5 or 50 iterations away, making it difficult to plan around Jeeves runs.

### Goals
- [ ] Derive historical iteration counts per workflow phase from completed run archives
- [ ] Compute and persist an estimated iteration count after `task_decomposition` completes
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
  - Using existing run archives under the issue state directory (`STATE/.runs/…`) as the historical data source
  - Producing an iteration-based estimate (count), not a time-based prediction
  - Persisting the estimate in issue state so it survives refreshes/restarts
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
| GET | /api/issue/estimate | No params. Uses the **currently selected** issue on the viewer-server. | 200: `{ ok:true, issue_ref:string, estimate: IterationEstimate \| null }` | 400: no issue selected; 404: `issue.json` missing; 403: origin not allowed; 500: I/O/parsing errors (`{ ok:false, error }`) |

#### `IssueStateSnapshot` (extension)
`GET /api/state` and the streaming `state` event add one new optional field:
```ts
type IssueStateSnapshot = {
  issue_ref: string | null;
  paths: { dataDir: string; stateDir: string | null; workDir: string | null; workflowsDir: string; promptsDir: string };
  issue_json: Record<string, unknown> | null;
  run: RunStatus;

  // New (additive)
  estimate?: IterationEstimate | null;
};
```

### CLI Commands (if applicable)
N/A - no new CLI commands in this feature.

### Events (if applicable)
| Event | Trigger | Payload | Consumers |
|-------|---------|---------|-----------|
| `issue-estimate` | Fired when the selected issue’s estimate becomes available or changes (including resets). Also sent once on new SSE/WS connection after the initial `state` snapshot. | `{ issue_ref: string, estimate: IterationEstimate \| null }` | Viewer UI (Watch/progress display), optional future CLI clients consuming SSE |

Notes:
- Transport is the existing `GET /api/stream` (SSE) and `GET /api/ws` (WebSocket). No new streaming endpoints are introduced.
- Event names are kebab-case to match existing conventions (`sdk-init`, `viewer-logs`, `sonar-token-status`).

### Validation Rules
All validation is **synchronous**.

| Field | Type | Constraints | Error |
|------|------|-------------|-------|
| `issue_ref` | string | required; must match selected issue `owner/repo#N` | `issue_ref is invalid` (400) |
| `estimate.computed_at` | string | required when `estimate` is non-null; ISO-8601 timestamp | Treat estimate as unavailable (`estimate:null`); emit `viewer-error` |
| `estimate.computed_at_iteration` | number | required; integer ≥ 1 | Treat estimate as unavailable (`estimate:null`); emit `viewer-error` |
| `estimate.estimated_remaining_iterations` | number | required; integer ≥ 0 | Treat estimate as unavailable (`estimate:null`); emit `viewer-error` |
| `estimate.estimated_total_iterations` | number | required; integer ≥ `computed_at_iteration` | Treat estimate as unavailable (`estimate:null`); emit `viewer-error` |
| `estimate.phase_breakdown_remaining[]` | array | required; each entry has `phase` (non-empty string) and `iterations` (int ≥ 0) | Treat estimate as unavailable (`estimate:null`); emit `viewer-error` |

Validation failure behavior:
- **Client input validation** (for endpoints with inputs): respond `400` with `{ ok:false, error:"..." }`.
- **Server-state validation** (invalid/partial estimate persisted to `issue.json`): treat the estimate as unavailable and:
  - return `200` with `estimate: null` from `GET /api/issue/estimate`, and/or
  - emit `viewer-error` with a message indicating the estimate payload is invalid.

### Estimate Contract (`IterationEstimate`)
This contract is intentionally iteration-based (not wall-clock time).

```ts
type IterationEstimate = {
  // When the estimate was computed and what iteration it was computed at.
  computed_at: string; // ISO-8601
  computed_at_iteration: number; // int >= 1

  // Remaining work after computed_at_iteration.
  estimated_remaining_iterations: number; // int >= 0
  estimated_total_iterations: number; // int >= computed_at_iteration

  // Phase-level breakdown of remaining iterations (future work only).
  phase_breakdown_remaining: Array<{
    phase: string; // workflow phase id (e.g. "implement", "review", ...)
    iterations: number; // int >= 0
    sample_size: number; // int >= 0 (how many completed historical runs contributed for this phase)
    method: 'median'; // v1: median of historical per-phase iteration counts
  }>;

  // Provenance (v1; used for debugging/UX copy, not for statistical guarantees).
  basis: {
    source: 'run_archives'; // v1: derived from STATE/.runs/*
    total_sample_size: number; // int >= 0
  };
};
```

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

This feature persists an iteration-based estimate in issue state so the viewer can display it across refreshes/restarts.

**Terminology**
- `STATE` = the selected issue state directory, i.e. `$JEEVES_DATA_DIR/issues/<owner>/<repo>/<issueNumber>`

### Schema Changes
| Location | Field | Type | Required | Default | Constraints |
|----------|-------|------|----------|---------|-------------|
| `STATE/issue.json` | `estimate` | `IterationEstimate \| null` | no | `null` | If non-null, must satisfy all constraints below |
| `STATE/issue.json` | `estimate.computed_at` | `string` | yes* | — (invalid ⇒ treat `estimate` as `null`) | ISO-8601 timestamp; required when `estimate` is non-null |
| `STATE/issue.json` | `estimate.computed_at_iteration` | `number` | yes* | — (invalid ⇒ treat `estimate` as `null`) | integer ≥ 1; required when `estimate` is non-null |
| `STATE/issue.json` | `estimate.estimated_remaining_iterations` | `number` | yes* | — (invalid ⇒ treat `estimate` as `null`) | integer ≥ 0; required when `estimate` is non-null |
| `STATE/issue.json` | `estimate.estimated_total_iterations` | `number` | yes* | — (invalid ⇒ treat `estimate` as `null`) | integer ≥ `estimate.computed_at_iteration`; required when `estimate` is non-null |
| `STATE/issue.json` | `estimate.phase_breakdown_remaining` | `{ phase, iterations, sample_size, method }[]` | yes* | — (invalid ⇒ treat `estimate` as `null`) | required when `estimate` is non-null; each entry constrained below |
| `STATE/issue.json` | `estimate.phase_breakdown_remaining[].phase` | `string` | yes* | — (invalid ⇒ treat `estimate` as `null`) | non-empty; must be a phase id in the current workflow; must be a “remaining” phase (after `task_decomposition`) |
| `STATE/issue.json` | `estimate.phase_breakdown_remaining[].iterations` | `number` | yes* | — (invalid ⇒ treat `estimate` as `null`) | integer ≥ 0 |
| `STATE/issue.json` | `estimate.phase_breakdown_remaining[].sample_size` | `number` | yes* | — (invalid ⇒ treat `estimate` as `null`) | integer ≥ 0 |
| `STATE/issue.json` | `estimate.phase_breakdown_remaining[].method` | `'median'` | yes* | — (invalid ⇒ treat `estimate` as `null`) | enum: `'median'` |
| `STATE/issue.json` | `estimate.basis.source` | `'run_archives'` | yes* | — (invalid ⇒ treat `estimate` as `null`) | enum: `'run_archives'` |
| `STATE/issue.json` | `estimate.basis.total_sample_size` | `number` | yes* | — (invalid ⇒ treat `estimate` as `null`) | integer ≥ 0 |

\* “Required” means required when `estimate` is non-null.

### Field Definitions
**`estimate`**
- Purpose: Persist a stable, iteration-count estimate after `task_decomposition` so the viewer can show “estimated remaining/total iterations” without recomputing on every refresh.
- Set by: Viewer-server orchestration after `task_decomposition` completes (i.e. once tasks are decomposed and the workflow advances past `task_decomposition`).
- Read by: `GET /api/state` (as `state.estimate`), `GET /api/issue/estimate`, and the `issue-estimate` stream event (viewer Watch UI).
- References/relationships: `estimate.phase_breakdown_remaining[].phase` must correspond to phase ids in the currently selected workflow; no foreign keys.
- Deletion/invalidation:
  - If the issue is reset (phase reset / rerun from scratch): set `estimate` back to `null`.
  - If the workflow selection changes (and therefore phase ids/order can change): set `estimate` back to `null` and wait to recompute after the next `task_decomposition`.
- Ordering dependency: The estimate is computed only after tasks are available (post-`task_decomposition`) and before subsequent phases execute, so the UI can show the estimate early in the run.

### Derivation (How the Estimate is Computed)
The `estimate` payload is **derived** data:
- Source: historical run archives in `$JEEVES_DATA_DIR/issues/<owner>/<repo>/*/.runs/*/iterations/*/iteration.json` for the same `<owner>/<repo>` and the same workflow name as the active issue.
- Eligible historical runs:
  - MUST have a `run.json` with `completed_via_state === true` OR `completed_via_promise === true`
  - MUST have `exit_code === 0`
  - MUST have at least 1 `iterations/*/iteration.json`
- Per-phase sample extraction:
  - For each eligible run, count iterations per phase by grouping `iteration.json.phase` values.
  - For each remaining phase (workflow phases strictly after `task_decomposition`), collect the per-run counts into a sample list.
  - Compute `phase_breakdown_remaining[].iterations` as the **median** of that sample list and set `sample_size` to the sample list length.
- Availability rules:
  - If there is no eligible history for the repo+workflow, persist `estimate: null`.
  - If any remaining phase has `sample_size === 0`, persist `estimate: null` (avoid presenting a misleading “0 iteration” guess).
- Timing:
  - Computed on write (once) at the moment `task_decomposition` completes.
  - Not automatically recomputed when new run archives appear; recomputation occurs only on the next `task_decomposition` for that issue (or if the estimate is explicitly reset to `null` and recomputed).
- If referenced history is deleted:
  - If historical `.runs` archives are later deleted, the persisted `estimate` remains readable (it is a cached snapshot), but any future recomputation may produce `estimate: null` due to insufficient samples.

### Migrations
| Change | Existing Data | Migration | Rollback |
|--------|---------------|-----------|----------|
| Add `issue.json.estimate` | Field absent | Treat as `null` (estimate unavailable) until computed | Remove `estimate` field (or set to `null`) |

### Artifacts
| Artifact | Location | Created | Updated | Deleted |
|----------|----------|---------|---------|---------|
| `estimate` (stored inside issue state) | `STATE/issue.json` | Immediately after `task_decomposition` completes and an estimate is available | When recomputed after a subsequent `task_decomposition` for the same issue | Set to `null` on issue reset or workflow change |
| Archived copies including `estimate` | `STATE/.runs/<run_id>/final-issue.json` and `STATE/.runs/<run_id>/iterations/<n>/issue.json` | Automatically by existing run archiving when `estimate` is present in `STATE/issue.json` | N/A | Never (archives are immutable once written) |

### Artifact Lifecycle
| Scenario | Artifact Behavior |
|----------|-------------------|
| Success | `STATE/issue.json` includes a valid `estimate` object; archived copies capture it when runs are archived |
| Failure | If estimate computation or validation fails, persist `estimate: null` (do not write partial/invalid objects) and emit a non-blocking `viewer-error` |
| Crash recovery | Writes to `STATE/issue.json` use atomic JSON writes; on restart, if `estimate` is missing or invalid it is treated as `null` and can be recomputed after the next `task_decomposition` |

## 5. Tasks

### Planning Gates

**Decomposition Gates**
1. **Smallest independently testable unit**: a pure “estimate-from-archives” function that, given a repo+workflow and a set of historical run archives, returns either a valid `IterationEstimate` or `null` (deterministic median math; explicit insufficient-history behavior).
2. **Dependencies between tasks**: yes — persistence wiring depends on the estimate computation utilities; API/stream exposure depends on the shared contract and runtime validation; viewer UI depends on viewer stream/types.
3. **Parallelizable tasks**: yes — after core computation utilities exist, server persistence wiring (T2) and server API/stream exposure (T3) can proceed in parallel; viewer stream/types (T4) and UI work (T5) can proceed once T3 is in place.

**Task Completeness Gates (applies to all tasks)**
4. **Files**: each task below enumerates exact files to create/modify.
5. **Acceptance criteria**: each task below lists concrete, verifiable outcomes.
6. **Verification**: each task below includes a specific `pnpm test -- <file>` command (plus global `pnpm typecheck/lint/test` in §6).

**Ordering Gates**
7. **Must be done first**: define the `IterationEstimate` contract + runtime validation + estimate computation utilities (T1).
8. **Must be done last**: viewer UI wiring and manual UX verification in `pnpm dev` (T5 + §6 manual checks).
9. **Circular dependencies**: none (tasks form a DAG).

**Infrastructure Gates**
10. **Build/config changes needed**: none expected (additive TS files + tests only).
11. **New dependencies**: none expected.
12. **Env vars/secrets**: none new; uses existing `$JEEVES_DATA_DIR` behavior to locate run archives.

### Goal → Task Mapping (Traceability)
- Derive historical iteration counts per workflow phase → **T1**, **T2**
- Compute and persist an estimate after `task_decomposition` completes → **T2**
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
| T1 | Estimate computation utilities | Implement `IterationEstimate` contract, runtime validation, and “compute from run archives” logic (median per-phase). | `apps/viewer-server/src/iterationEstimate.ts` | Unit tests verify eligible-run filtering, median math, and `null` behavior on insufficient history. |
| T2 | Persist estimate post-decomposition | Compute and atomically write `estimate` into `STATE/issue.json` when transitioning off `task_decomposition`; reset to `null` on workflow change/reset. | `apps/viewer-server/src/runManager.ts` | After a successful `task_decomposition` iteration, `STATE/issue.json.estimate` is present (or explicitly `null`) and never partial/invalid. |
| T3 | Expose estimate over API + stream | Add `GET /api/issue/estimate`, extend `GET /api/state` + `state` event with `estimate`, and emit `issue-estimate` events on connect/change. | `apps/viewer-server/src/server.ts` | `GET /api/issue/estimate` returns validated `{ estimate }`; WS/SSE send `issue-estimate` after initial `state` and on estimate changes. |
| T4 | Viewer stream support | Teach viewer stream layer to consume `issue-estimate` and merge it into client state. | `apps/viewer/src/stream/*`, `apps/viewer/src/api/types.ts` | Reducer/provider tests prove estimate updates without requiring a full `state` refresh. |
| T5 | Watch UI display | Render estimated remaining/total iterations + phase breakdown on Watch page next to actual progress. | `apps/viewer/src/pages/WatchPage.tsx` | UI tests cover `estimate:null`, valid estimate rendering, and phase breakdown formatting. |

### Task Details

**T1: Estimate computation utilities**
- Summary: Add a runtime-validated `IterationEstimate` contract and a deterministic computation that derives an estimate from historical run archives (`STATE/.runs/*/iterations/*/iteration.json` + `STATE/.runs/*/run.json`).
- Files:
  - `apps/viewer-server/src/iterationEstimate.ts` - define types + validation helpers + `computeIterationEstimateFromArchives(...)`
  - `apps/viewer-server/src/iterationEstimate.test.ts` - unit tests for eligibility filtering, sample extraction, median, and insufficient-history behavior
- Acceptance Criteria:
  1. Eligible historical runs are filtered by `run.json` (`exit_code === 0` and `completed_via_state || completed_via_promise`) and by workflow name match.
  2. Per remaining phase, median is computed over per-run counts **only when the phase appears in that run**; if any remaining phase has zero samples, the function returns `null`.
  3. Output includes `basis.source='run_archives'`, `basis.total_sample_size` (eligible run count), and `method:'median'` on each breakdown entry.
- Dependencies: None
- Verification: `pnpm test -- apps/viewer-server/src/iterationEstimate.test.ts`

**T2: Persist estimate post-decomposition**
- Summary: Wire estimate computation into viewer-server orchestration: after a successful `task_decomposition` iteration, write `estimate` into `STATE/issue.json` (or `null` when unavailable) using existing atomic JSON write behavior.
- Files:
  - `apps/viewer-server/src/runManager.ts` - detect `currentPhase === 'task_decomposition'` success and phase transition; compute+persist estimate; clear estimate on workflow switch/reset
  - `apps/viewer-server/src/runManager.test.ts` - integration test using a temporary `$JEEVES_DATA_DIR` fixture with synthetic `.runs` history
- Acceptance Criteria:
  1. When transitioning off `task_decomposition`, `STATE/issue.json.estimate` becomes either a fully valid `IterationEstimate` or `null` (never partially written).
  2. `estimate.computed_at_iteration` equals the iteration that executed `task_decomposition`; `estimated_total_iterations` equals `computed_at_iteration + estimated_remaining_iterations`.
  3. If the issue workflow is switched (no override) or the issue is reset to a pre-decomposition phase, `estimate` is set back to `null`.
- Dependencies: T1
- Verification: `pnpm test -- apps/viewer-server/src/runManager.test.ts`

**T3: Expose estimate over API + stream**
- Summary: Make estimates visible to clients via HTTP and streaming, without breaking existing consumers.
- Files:
  - `apps/viewer-server/src/types.ts` - add `IterationEstimate` type and extend `IssueStateSnapshot` with `estimate?: IterationEstimate | null`
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
  - `apps/viewer/src/api/types.ts` - add `IterationEstimate` type and `IssueEstimateEvent` payload contract
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
  2. When `estimate` is present, the Watch page shows `estimated_total_iterations`, `estimated_remaining_iterations`, and lists `phase_breakdown_remaining` with `iterations` and `sample_size`.
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
  - `apps/viewer-server/src/iterationEstimate.test.ts`
  - `apps/viewer-server/src/server.test.ts` (estimate API + stream)
  - `apps/viewer-server/src/runManager.test.ts` (persistence wiring)
  - `apps/viewer/src/stream/streamReducer.test.ts` (client merge)
  - `apps/viewer/src/pages/WatchPage.test.ts` (UI rendering)

### Manual Verification (Viewer)
- [ ] Start the stack: `pnpm dev`
- [ ] Select an issue that has historical `.runs` archives under `$JEEVES_DATA_DIR/issues/<owner>/<repo>/*/.runs/*`
- [ ] Start a run and observe:
  - After `task_decomposition` completes, the Watch page shows an estimate (or “unavailable” if insufficient history)
  - Refreshing the page preserves the estimate (read from `STATE/issue.json`)
  - Changing workflow or resetting the issue clears the estimate (back to `null`) and emits a new `issue-estimate` event
