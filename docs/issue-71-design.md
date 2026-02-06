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

### Inputs From Sections 1-4 (Traceability)
- **Goals from Section 1**:
  1. Auto-hide the sidebar when a run is active and expand Watch content into that space.
  2. Keep focused mode after run completion until the user explicitly re-opens the sidebar.
  3. Show run-time controls in context (Stop while running + outcome badge after completion).
  4. Persist run-time sidebar override across reloads/sessions.
- **Workflow from Section 2**: N/A (no viewer-server workflow/state-machine changes).
- **Interfaces from Section 3**: N/A (no API, event, or command contract changes).
- **Data from Section 4**:
  - Add browser persistence key `window.localStorage["jeeves.watch.sidebar.runOverride"]`.
  - Allowed values: `"auto"` or `"open"`; absent/invalid values resolve to `"auto"`.
  - Derived runtime field: `ui.sidebarVisibleEffective` from run state + override + live toggle state.

### Goal-to-Task Mapping
| Goal (Section 1) | Covered By Tasks |
|------------------|------------------|
| G1: Auto-hide sidebar during active run and expand content | T1, T2, T4 |
| G2: Remain focused after run ends until explicit reopen | T1, T2 |
| G3: In-context Stop + completion outcome badge | T3, T4 |
| G4: Persist run-time sidebar override across sessions | T1, T2 |

### Planning Gates (Explicit Answers)
1. **Smallest independently testable unit**: a pure helper that parses/persists `jeeves.watch.sidebar.runOverride` and derives effective sidebar visibility from `run.running` + override + user toggle action.
2. **Dependencies between tasks**: yes; AppShell wiring depends on the helper model (T2 depends on T1), and final style/integration pass depends on behavior work (T4 depends on T2/T3).
3. **Parallelizable tasks**: yes; T2 (layout behavior) and T3 (Watch context controls) can be implemented in parallel after T1 is available.
4. **Specific files per task**: listed in the Task Breakdown and Task Details for T1-T4.
5. **Acceptance criteria per task**: listed as concrete, verifiable criteria for each task below.
6. **Verification command per task**: listed for each task (`pnpm test` targets, `pnpm typecheck`, `pnpm lint`, viewer build).
7. **Must be done first**: T1, because it defines the single source of truth for persisted override parsing/defaulting and focus-mode visibility derivation.
8. **Can only be done last**: T4, because it finalizes styling/integration assertions after T2 and T3 behavior is wired.
9. **Circular dependencies**: none; dependency graph is a DAG (`T1 -> T2`, `T1 -> T3`, `T2,T3 -> T4`).
10. **Build/config changes needed**: none expected; existing viewer and workspace build configuration is sufficient.
11. **New dependencies to install**: none.
12. **Environment variables or secrets needed**: none; persistence is browser-local only (`localStorage`), with in-memory fallback when unavailable.

### Task Dependency Graph
```
T1 (no deps)
T2 → depends on T1
T3 → depends on T1
T4 → depends on T2, T3
```

### Task Breakdown
| ID | Title | Summary | Files | Acceptance Criteria |
|----|-------|---------|-------|---------------------|
| T1 | Sidebar focus-state helper | Add pure helpers for run-override parsing/persistence and effective sidebar visibility derivation. | `apps/viewer/src/layout/runFocusState.ts`, `apps/viewer/src/layout/runFocusState.test.ts` | Invalid/missing storage values resolve to `"auto"`; helper derives hidden sidebar for active runs with `"auto"`; post-run focused state persists until explicit reopen. |
| T2 | AppShell focused-mode wiring | Wire AppShell + Header to auto-hide sidebar on active run and keep it hidden post-run until explicit reopen. | `apps/viewer/src/layout/AppShell.tsx`, `apps/viewer/src/layout/Header.tsx`, `apps/viewer/src/layout/AppShell.test.ts` | Active run + `"auto"` hides sidebar and expands main layout; focused state remains after run end; explicit user reopen updates UI and persisted override. |
| T3 | Watch run-context controls | Add Stop action during active runs and completion outcome badge after runs end in the Watch context strip. | `apps/viewer/src/pages/WatchPage.tsx`, `apps/viewer/src/pages/WatchPage.test.ts` | Stop button is visible only while running and calls stop mutation; completion badge appears only after run ends with a completion reason; tests cover visibility and reason formatting. |
| T4 | Focused-mode styling + integration polish | Add/adjust shared + Watch styles for focused layout and run-context action/badge presentation across desktop/mobile. | `apps/viewer/src/styles.css`, `apps/viewer/src/pages/WatchPage.css`, `apps/viewer/src/pages/WatchPage.tsx` | Hidden sidebar consumes no layout width; Watch context controls wrap without overflow on tablet/mobile; style changes use tokens/RGBA overlays only. |

### Task Details

**T1: Sidebar focus-state helper**
- Summary: Introduce pure, testable utilities for `localStorage` run override and effective sidebar visibility derivation.
- Files:
  - `apps/viewer/src/layout/runFocusState.ts` - add constants/types/functions for `runOverride` parsing (`"auto" | "open"`), safe storage read/write, and visibility derivation from run state transitions.
  - `apps/viewer/src/layout/runFocusState.test.ts` - add tests for absent/invalid value defaulting, run-active auto-hide behavior, and post-run sticky focus behavior.
- Acceptance Criteria:
  1. Storage value handling accepts only exact `"auto"` or `"open"` and maps all other values to `"auto"`.
  2. Derived visibility returns hidden sidebar when `run.running === true` and override is `"auto"`.
  3. If a run ends while focused mode is active, helper keeps sidebar hidden until an explicit user reopen action is applied.
  4. Storage read/write failures do not throw; behavior falls back to in-memory default `"auto"`.
- Dependencies: None
- Verification: `pnpm test -- apps/viewer/src/layout/runFocusState.test.ts`

**T2: AppShell focused-mode wiring**
- Summary: Apply the helper model in AppShell/Header so run-driven focused mode is automatic, sticky post-run, and explicitly user-reversible.
- Files:
  - `apps/viewer/src/layout/AppShell.tsx` - use focus-state helper, derive effective run status from stream, hide/show sidebar region, and wire toggle handlers.
  - `apps/viewer/src/layout/Header.tsx` - add focused-mode toggle control with clear labels for open/hide actions.
  - `apps/viewer/src/layout/AppShell.test.ts` - add tests for AppShell-level visibility decisions and explicit reopen behavior.
- Acceptance Criteria:
  1. On transition to running (`run.running=false -> true`) with override `"auto"`, AppShell renders focused layout (sidebar hidden, main region expanded).
  2. On transition to idle (`true -> false`) after auto-focus, sidebar remains hidden until explicit reopen.
  3. Explicit reopen action restores sidebar immediately and persists override state according to T1 helper behavior.
  4. Existing navigation tabs and page content remain mounted/accessible in both sidebar-visible and focused layouts.
- Dependencies: T1
- Verification: `pnpm test -- apps/viewer/src/layout/AppShell.test.ts && pnpm typecheck`

**T3: Watch run-context controls**
- Summary: Move run-time stop affordance and run outcome feedback into the Watch context strip where users monitor execution.
- Files:
  - `apps/viewer/src/pages/WatchPage.tsx` - add context-strip Stop action (running only) and completion outcome badge (ended only), with non-blocking error handling.
  - `apps/viewer/src/pages/WatchPage.test.ts` - extend tests for stop-action visibility, completion badge visibility, and completion-reason formatting.
- Acceptance Criteria:
  1. Context strip shows Stop only when `run.running === true`; button triggers stop mutation with `{ force: false }`.
  2. Stop button reflects pending mutation state (`Stopping…`) and is disabled while request is in flight.
  3. Completion outcome badge is hidden while running and shown after completion when `completion_reason` is present.
  4. Existing run context fields (Issue, Workflow, Phase, PID/Iteration/timestamps) keep current visibility semantics.
- Dependencies: T1
- Verification: `pnpm test -- apps/viewer/src/pages/WatchPage.test.ts`

**T4: Focused-mode styling + integration polish**
- Summary: Finalize the visual/layout behavior for focused mode and context-strip actions across breakpoints.
- Files:
  - `apps/viewer/src/styles.css` - add focused layout/sidebar visibility classes and responsive adjustments for full-width main content.
  - `apps/viewer/src/pages/WatchPage.css` - style context-strip action/badge spacing/wrapping for desktop/tablet/mobile.
  - `apps/viewer/src/pages/WatchPage.tsx` - add semantic class names/hooks needed by CSS polish.
- Acceptance Criteria:
  1. Focused mode removes sidebar width from layout (no reserved blank column).
  2. Watch context strip action(s)/badge(s) remain readable and non-overlapping at `<=900px` and `<=768px`.
  3. All added styles use design tokens and explicit RGBA overlays only (no hex colors outside `tokens.css`, no `color-mix()`).
  4. Viewer build succeeds after style changes.
- Dependencies: T2, T3
- Verification: `pnpm --filter @jeeves/viewer build && pnpm lint`

## 6. Validation

### Pre-Implementation Checks
- [ ] All dependencies installed: `pnpm install`
- [ ] Types check: `pnpm typecheck`
- [ ] Existing tests pass: `pnpm test`

### Post-Implementation Checks
- [ ] Types check: `pnpm typecheck`
- [ ] Lint passes: `pnpm lint`
- [ ] All tests pass: `pnpm test`
- [ ] Viewer build passes: `pnpm --filter @jeeves/viewer build`
- [ ] New tests added for:
  - `apps/viewer/src/layout/runFocusState.test.ts`
  - `apps/viewer/src/layout/AppShell.test.ts`
  - Updated: `apps/viewer/src/pages/WatchPage.test.ts`

### Manual Verification (required)
- [ ] Run `pnpm dev`, open `/watch`, and start a run from sidebar controls.
- [ ] Verify sidebar auto-hides when run becomes active and Watch panels expand to full width.
- [ ] Wait for run completion and verify sidebar remains hidden until explicitly reopened.
- [ ] Reload the page during/after a run and confirm run-time sidebar override persists (`auto` vs `open`) as designed.
- [ ] While running, verify Stop is available in Watch context strip and triggers stop.
- [ ] After completion, verify an outcome badge appears in Watch context strip with completion reason.
