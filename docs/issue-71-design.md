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

This feature adds viewer-only browser persistence for run-time sidebar override. It does **not** change `.jeeves/issue.json`, workflow files, or viewer-server API schemas.

### Schema Changes
| Location | Field | Type | Required | Default | Constraints |
|----------|-------|------|----------|---------|-------------|
| `window.localStorage` | `jeeves.watch.sidebar.runOverride` | `string` | no | `"auto"` when absent | enum: `"auto"` \| `"open"`; case-sensitive exact match; invalid/unknown values MUST be treated as `"auto"` |

### Field Definitions
**`jeeves.watch.sidebar.runOverride`**
- Purpose: Persist whether the user overrides run-time focused mode to keep the sidebar visible while a run is active.
- Set by: Viewer UI toggle actions when `run.running === true`.
- Read by: `AppShell` sidebar visibility logic on initial load and on run state transitions.
- Relationships:
  - References runtime run state (`stream.state.run.running`) only; no persisted foreign key.
  - If run state is unavailable, treat as idle and ignore run override until run state resumes.
  - Ordering dependency: apply latest run state snapshot before deriving effective sidebar visibility.

### Migrations
| Change | Existing Data | Migration | Rollback |
|--------|---------------|-----------|----------|
| Add `localStorage["jeeves.watch.sidebar.runOverride"]` | Key absent in all existing clients | No script. Read-path migration: absent/invalid value resolves to `"auto"` | Stop reading key and remove it from localStorage |

### Derivations
| Derived Field | Source Data | Computed | Source Change Handling |
|---------------|-------------|----------|------------------------|
| `ui.sidebarVisibleEffective` (not persisted) | `run.running`, `jeeves.watch.sidebar.runOverride`, current UI toggle state | On read (render/effect) | Recompute immediately on each run-state update and user toggle event |

### Artifacts
| Artifact | Location | Created | Updated | Deleted |
|----------|----------|---------|---------|---------|
| Run override preference | `window.localStorage["jeeves.watch.sidebar.runOverride"]` | First explicit run-time sidebar override write | Each explicit run-time sidebar override change | Manual storage clear/reset (or feature rollback cleanup) |

### Artifact Lifecycle
| Scenario | Artifact Behavior |
|----------|-------------------|
| Success | Key persists and is reused on reload/session restart. |
| Failure | If localStorage write/read fails (quota/privacy mode), UI falls back to in-memory behavior for that session; no persisted mutation is required for correctness. |
| Crash recovery | Last successful `setItem` value remains; partial writes are not observable (single-key atomic browser write semantics). |

### Data Gates (Explicit Answers)
1. Field name/path: `window.localStorage["jeeves.watch.sidebar.runOverride"]`.
2. Type: `string`.
3. Required/optional: optional.
4. Default when absent: `"auto"`.
5. Constraints: enum `"auto"` or `"open"`; case-sensitive; invalid values treated as `"auto"`.
6. References: runtime `run.running` state only.
7. If referenced data deleted/unavailable: treat run as idle; keep persisted override unchanged.
8. Ordering dependencies: run snapshot is applied before computing effective sidebar visibility.
9. Breaking change: no.
10. Existing records without field: interpreted as default `"auto"`.
11. Migration script needed: no (read-time defaulting handles migration).
12. Rollback: stop consuming key and optionally remove key from localStorage.
13. Derived field: `ui.sidebarVisibleEffective` derived from run state + override + live toggle state.
14. Computation timing: on read during render/effects; recomputed on state changes.
15. Source change behavior: any run/toggle change re-derives visibility immediately.
16. Artifact created: run override localStorage key.
17. Artifact storage: browser localStorage.
18. Artifact lifecycle events: create on first override write, update on each override change, delete on storage clear/reset/rollback cleanup.
19. Success/failure/crash behavior: success persists key, failure falls back to in-memory behavior, crash preserves last committed value.

## 5. Tasks
[To be completed in design_plan phase]

## 6. Validation
[To be completed in design_plan phase]
