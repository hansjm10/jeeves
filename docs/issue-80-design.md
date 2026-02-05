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
[To be completed in design_workflow phase]

## 3. Interfaces
[To be completed in design_api phase]

## 4. Data
[To be completed in design_data phase]

## 5. Tasks
[To be completed in design_plan phase]

## 6. Validation
[To be completed in design_plan phase]
