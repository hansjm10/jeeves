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
[To be completed in design_data phase]

## 5. Tasks
[To be completed in design_plan phase]

## 6. Validation
[To be completed in design_plan phase]
