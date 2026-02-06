# Design: Focused Mode for Active Runs

**Issue**: #71
**Status**: Draft - Classification Complete
**Feature Types**: Primary: UI, Secondary: Data

---

## 1. Scope

### Problem
During active runs, the Watch experience keeps the full sidebar visible even though most controls are disabled, so the logs and SDK panels lose useful horizontal space when users most need it.

### Goals
- [ ] Automatically hide the sidebar when a run becomes active and expand Watch content panels into that space.
- [ ] Keep users in focused mode after the run ends until they explicitly re-open the sidebar.
- [ ] Surface run-time control in context by showing Stop while running and an outcome badge after completion.
- [ ] Persist a user override for sidebar visibility during runs across page reloads/sessions.

### Non-Goals
- Add new sidebar interaction modes (peek overlay, sliver collapse, or partial-width variants).
- Change backend run orchestration, runner behavior, or viewer-server contracts.
- Add new issue context fields beyond existing run/workflow/phase status shown in Watch.

### Boundaries
- **In scope**: Viewer UI state/interaction updates across `Header`, `WatchPage`/run context strip, layout/sidebar presentation, and related Watch styling/tests.
- **Out of scope**: New REST/WebSocket APIs, issue/workflow schema changes, run state machine changes in viewer-server/runner, or deployment/tooling changes.

---

## 2. Workflow
N/A - This feature does not involve workflow or state machine changes.

## 3. Interfaces
N/A - This feature does not add or modify external interfaces.

## 4. Data
[To be completed in design_data phase]

## 5. Tasks
[To be completed in design_plan phase]

## 6. Validation
[To be completed in design_plan phase]
