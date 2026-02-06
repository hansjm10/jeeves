# Design: Focused Mode for Active Runs

**Issue**: #71
**Status**: Draft - Classification Complete
**Feature Types**: Primary: UI, Secondary: Data

---

## 1. Scope

### Problem
During active runs, the Watch experience keeps the full sidebar visible even though most controls are disabled, so the logs and SDK panels lose useful horizontal space when users most need it.

### Goals
- [ ] (G1) Automatically hide the sidebar when a run becomes active and expand Watch content panels into that space.
- [ ] (G2) Keep users in focused mode after the run ends until they explicitly re-open the sidebar.
- [ ] (G3) Surface run-time control in context by showing Stop while running and deterministic completion outcome semantics (`Complete` vs `Error`) after completion.
- [ ] (G4) Persist a user override for sidebar visibility during runs across page reloads/sessions.
- [ ] (G5) When a run starts with override `"auto"`, animate sidebar hide/content expansion inside a 150-200ms envelope.

### Issue Acceptance Criteria Mapping
| Issue acceptance criterion | Design coverage |
|----------------------------|-----------------|
| Run start hides sidebar with a 150-200ms transition | G1, G5; Section 2 transitions `TR1`/`TR2`; Section 5 tasks `T2`/`T4`; Section 6 timing checks |
| Focused mode stays after run completion until explicit reopen | G2; Section 2 transition `TR4` + `TR6`; Section 5 tasks `T1`/`T2`; Section 6 transition tests |
| Edge-case transitions are deterministic (animation in-flight, refresh mid-run, websocket reconnection, manual-hide/run-restart transitions) | Section 2 transitions `TR7`-`TR9` and Edge Cases `EC1`-`EC4`; Section 5 tasks `T1`/`T2`; Section 6 scenario checks |
| Run context keeps stop controls in Watch and persists run override | G3, G4; Sections 4 and 5 tasks `T1`/`T3`; Section 6 automated + manual checks |
| Completion outcome badge semantics are deterministic (`Complete` vs `Error`) | G3; Section 5 task `T3` acceptance criteria + semantic mapping; Section 6 badge-semantic assertions |

### Non-Goals
- Add new sidebar interaction modes (peek overlay, sliver collapse, or partial-width variants).
- Change backend run orchestration, runner behavior, or viewer-server contracts.
- Add new issue context fields beyond existing run/workflow/phase status shown in Watch.

### Boundaries
- **In scope**: Viewer UI state/interaction updates across `Header`, `WatchPage`/run context strip, layout/sidebar presentation, and related Watch styling/tests.
- **Out of scope**: New REST/WebSocket APIs, issue/workflow schema changes, run state machine changes in viewer-server/runner, or deployment/tooling changes.

---

## 2. Workflow
No backend workflow/state-machine contracts change for this issue. This section defines the required viewer-side UI transition model.

### UI States
| State | Conditions | Sidebar | Notes |
|-------|------------|---------|-------|
| `W0 IdleVisible` | `run.running === false` and not in sticky-focused carry-over | Visible | Default idle presentation. |
| `W1 RunStartHiding` | `run.running === true`, override is `"auto"`, hide transition in progress | Transitioning to hidden | Transition duration target: 150-200ms. |
| `W2 RunningFocusedHidden` | `run.running === true`, override is `"auto"`, hide transition complete | Hidden | Active run focused mode. |
| `W3 RunningOverrideOpen` | `run.running === true`, override is `"open"` | Visible | Explicit user override while run is active. |
| `W4 IdleStickyHidden` | `run.running === false` and run ended from focused hidden mode | Hidden | Stays hidden until explicit reopen action. |

### Transitions
| ID | From -> To | Trigger | Required behavior |
|----|------------|---------|-------------------|
| `TR1` | `W0 -> W1` | Run starts (`false -> true`) and override is `"auto"` | Start sidebar hide + content expansion transition; target duration must be between 150ms and 200ms. |
| `TR2` | `W1 -> W2` | Hide transition completes (`transitionend` or fallback timer) | Commit hidden focused state for active run. |
| `TR3` | `W1` or `W2` -> `W3` | User explicitly reopens sidebar while run is active | Cancel/override hide transition immediately and persist override `"open"`. |
| `TR4` | `W2 -> W4` | Run completes (`true -> false`) after focused hidden mode | Keep sidebar hidden; do not auto-reopen. |
| `TR5` | `W3 -> W0` | Run completes while override is `"open"` | Keep sidebar visible and remain in visible idle presentation. |
| `TR6` | `W4 -> W0` | User explicitly reopens sidebar after run completion | Show sidebar immediately and clear sticky hidden state. |
| `TR7` | `W1 -> W1` | Duplicate run-start signal while hide transition is already in progress | No restart; keep single in-flight hide transition. |
| `TR8` | `W3 -> W2` | User explicitly hides sidebar while run is active | Enter focused hidden state directly (no `W1` replay animation) and clear persisted override from `"open"` to `"auto"`. |
| `TR9` | `W4 -> W2` | New run starts while idle sticky hidden | Sidebar is already hidden, so transition directly to `W2` with no run-start animation. |

### Edge Cases (Required)
- **EC1: Animation in-flight**
  - Duplicate run-start updates during `W1` MUST be treated as no-op (`TR7`) to avoid repeated restarts/flicker.
  - Explicit reopen during `W1` MUST transition directly to `W3` (`TR3`) and cancel the in-flight hide behavior.
  - If run completion is observed during `W1`, finish hide once and land in `W4` (hidden), not visible idle.
  - Explicit hide while running in `W3` MUST transition directly to `W2` (`TR8`) and persist override `"auto"` (clearing `"open"`).
- **EC2: Refresh mid-run**
  - On initial hydrate when `run.running === true` and override is `"auto"`, initialize to `W2` (hidden) immediately with no replayed run-start animation.
  - On initial hydrate when `run.running === true` and override is `"open"`, initialize to `W3` (visible).
- **EC3: WebSocket reconnection**
  - During transient stream disconnect, preserve last known UI state; do not infer idle from missing updates.
  - On reconnect snapshot: if run is active, enter `W2` or `W3` by override; if run is idle after being active, transition once to `W4` or `W0` based on previous visibility mode.
- **EC4: Run restart from sticky hidden idle**
  - If a new run starts from `W4`, transition directly to `W2` (`TR9`) with no 150-200ms run-start animation replay.

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
  - If run state is temporarily unavailable during stream reconnect, preserve last known UI state until reconnect snapshot is applied.
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
7. If referenced data deleted/unavailable: during transient disconnect keep last known UI state; once a reconnect snapshot is available, reconcile from snapshot and keep persisted override unchanged.
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
  1. (G1) Auto-hide the sidebar when a run is active and expand Watch content into that space.
  2. (G2) Keep focused mode after run completion until the user explicitly re-opens the sidebar.
  3. (G3) Show run-time controls in context (Stop while running + deterministic completion badge semantics).
  4. (G4) Persist run-time sidebar override across reloads/sessions.
  5. (G5) Apply a 150-200ms run-start hide/expand animation when override is `"auto"`.
- **Workflow from Section 2**:
  - UI states `W0`-`W4`, transitions `TR1`-`TR9`, and required edge cases `EC1`-`EC4`.
  - No backend viewer-server workflow/state-machine contract changes.
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
| G3: In-context Stop + deterministic outcome badge semantics (`Complete` vs `Error`) | T3, T4 |
| G4: Persist run-time sidebar override across sessions | T1, T2 |
| G5: Run-start animation timing target (150-200ms) | T2, T4 |

### Completion Outcome Semantic Mapping
| Condition (run ended and `completion_reason` is present) | Badge label |
|-----------------------------------------------------------|-------------|
| `run.last_error` is non-empty OR normalized `completion_reason === "error"` | `Error` |
| Otherwise | `Complete` |

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
| T1 | Sidebar focus-state helper | Add pure helpers for run-override parsing/persistence and transition-safe sidebar visibility derivation. | `apps/viewer/src/layout/runFocusState.ts`, `apps/viewer/src/layout/runFocusState.test.ts` | Invalid/missing storage values resolve to `"auto"`; helper models `W0`-`W4` transitions including `TR8`/`TR9` and edge cases (`EC1`-`EC4`); post-run focused state persists until explicit reopen. |
| T2 | AppShell focused-mode wiring | Wire AppShell + Header to run the 150-200ms run-start hide transition and required transition overrides. | `apps/viewer/src/layout/AppShell.tsx`, `apps/viewer/src/layout/Header.tsx`, `apps/viewer/src/layout/AppShell.test.ts` | `W0 -> W1 -> W2` uses 150-200ms timing; explicit reopen sets override `"open"`; explicit hide in `W3` clears override to `"auto"` and enters `W2` directly; run start from `W4` enters `W2` without animation. |
| T3 | Watch run-context controls | Add Stop action during active runs and completion outcome badge after runs end in the Watch context strip. | `apps/viewer/src/pages/WatchPage.tsx`, `apps/viewer/src/pages/WatchPage.test.ts` | Stop button is visible only while running and calls stop mutation; completion badge maps deterministically to `Complete` vs `Error` (not only presence of `completion_reason`); tests cover semantic mapping and reason formatting. |
| T4 | Focused-mode styling + integration polish | Add/adjust shared + Watch styles for focused layout, animation timing token wiring, and run-context action/badge presentation across desktop/mobile. | `apps/viewer/src/styles/tokens.css`, `apps/viewer/src/styles.css`, `apps/viewer/src/pages/WatchPage.css`, `apps/viewer/src/pages/WatchPage.tsx` | Sidebar hide transition token is set within 150-200ms and applied to focused-mode classes; hidden sidebar consumes no layout width; Watch context controls wrap without overflow on tablet/mobile; style changes use tokens/RGBA overlays only. |

### Task Details

**T1: Sidebar focus-state helper**
- Summary: Introduce pure, testable utilities for `localStorage` run override and transition-safe effective sidebar visibility derivation.
- Files:
  - `apps/viewer/src/layout/runFocusState.ts` - add constants/types/functions for `runOverride` parsing (`"auto" | "open"`), safe storage read/write, and viewer-side state transitions (`W0`-`W4`) including reconnect handling.
  - `apps/viewer/src/layout/runFocusState.test.ts` - add tests for absent/invalid value defaulting, run-active auto-hide behavior, post-run sticky focus behavior, and edge cases `EC1`-`EC4`.
- Acceptance Criteria:
  1. Storage value handling accepts only exact `"auto"` or `"open"` and maps all other values to `"auto"`.
  2. Transition reducer/derivation enters `W1`/`W2` when run starts in `"auto"` and resolves duplicate run-start while `W1` as no-op.
  3. User hide while running in `W3` transitions directly to `W2` (no `W1` replay) and clears persisted override from `"open"` to `"auto"`.
  4. If run ends from focused mode, helper enters/stays in `W4` until explicit reopen action; if run starts from `W4`, helper enters `W2` with no run-start animation.
  5. Refresh-mid-run initialization enters `W2` for `"auto"` and `W3` for `"open"` without requiring a synthetic run-start transition.
  6. WebSocket disconnect/reconnect preserves last known state until reconnect snapshot is applied.
  7. Storage read/write failures do not throw; behavior falls back to in-memory default `"auto"`.
- Dependencies: None
- Verification: `pnpm test -- apps/viewer/src/layout/runFocusState.test.ts`

**T2: AppShell focused-mode wiring**
- Summary: Apply the helper model in AppShell/Header so run-driven focused mode is automatic, animated at run start, sticky post-run, and explicitly user-reversible.
- Files:
  - `apps/viewer/src/layout/AppShell.tsx` - use focus-state helper, derive effective run status from stream, trigger/cancel run-start hide animation, and wire toggle handlers.
  - `apps/viewer/src/layout/Header.tsx` - add focused-mode toggle control with clear labels for open/hide actions and explicit reopen during active run.
  - `apps/viewer/src/layout/AppShell.test.ts` - add tests for run-start transition timing envelope, visibility decisions, explicit reopen during in-flight animation, hide-from-`W3` behavior, and run-start-from-`W4` behavior.
- Acceptance Criteria:
  1. On transition to running (`run.running=false -> true`) with override `"auto"`, AppShell starts hide transition and reaches hidden focused layout within 150-200ms.
  2. Explicit reopen during `W1` or `W2` restores sidebar immediately and persists override `"open"`.
  3. Explicit hide while running in `W3` enters `W2` directly (no `W1` replay animation) and clears persisted override to `"auto"`.
  4. If a new run starts from `W4`, AppShell enters `W2` directly without replaying the 150-200ms run-start animation.
  5. On transition to idle (`true -> false`) from focused hidden mode, sidebar remains hidden until explicit reopen.
  6. On stream reconnect, AppShell reapplies snapshot once without flickering through visible idle state.
  7. Existing navigation tabs and page content remain mounted/accessible in both sidebar-visible and focused layouts.
- Dependencies: T1
- Verification: `pnpm test -- apps/viewer/src/layout/AppShell.test.ts && pnpm typecheck`

**T3: Watch run-context controls**
- Summary: Move run-time stop affordance and run outcome feedback into the Watch context strip where users monitor execution.
- Files:
  - `apps/viewer/src/pages/WatchPage.tsx` - add context-strip Stop action (running only) and completion outcome badge (ended only), with non-blocking error handling.
  - `apps/viewer/src/pages/WatchPage.test.ts` - extend tests for stop-action visibility, completion badge visibility, completion badge semantic mapping, and completion-reason formatting.
- Acceptance Criteria:
  1. Context strip shows Stop only when `run.running === true`; button triggers stop mutation with `{ force: false }`.
  2. Stop button reflects pending mutation state (`Stopping…`) and is disabled while request is in flight.
  3. Completion outcome badge is hidden while running and shown only after completion when `completion_reason` is present.
  4. When shown, badge semantics are deterministic: render `Error` if `run.last_error` is non-empty or normalized `completion_reason === "error"`, otherwise render `Complete`.
  5. Existing run context fields (Issue, Workflow, Phase, PID/Iteration/timestamps) keep current visibility semantics.
- Dependencies: T1
- Verification: `pnpm test -- apps/viewer/src/pages/WatchPage.test.ts`

**T4: Focused-mode styling + integration polish**
- Summary: Finalize the visual/layout behavior for focused mode, animation timing token wiring, and context-strip actions across breakpoints.
- Files:
  - `apps/viewer/src/styles/tokens.css` - define/adjust a sidebar-hide transition duration token constrained to 150-200ms.
  - `apps/viewer/src/styles.css` - add focused layout/sidebar visibility classes, apply the transition token, and responsive adjustments for full-width main content.
  - `apps/viewer/src/pages/WatchPage.css` - style context-strip action/badge spacing/wrapping for desktop/tablet/mobile.
  - `apps/viewer/src/pages/WatchPage.tsx` - add semantic class names/hooks needed by CSS polish.
- Acceptance Criteria:
  1. Sidebar hide transition duration token value is within 150-200ms and is used by focused-mode hide classes.
  2. Focused mode removes sidebar width from layout (no reserved blank column).
  3. Watch context strip action(s)/badge(s) remain readable and non-overlapping at `<=900px` and `<=768px`.
  4. All added styles use design tokens and explicit RGBA overlays only (no hex colors outside `tokens.css`, no `color-mix()`).
  5. Viewer build succeeds after style changes.
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
- [ ] Automated scenario assertions added and passing:
  - Run-start hide transition timing check validates configured duration is between 150ms and 200ms.
  - Animation in-flight check validates duplicate run-start is no-op and explicit reopen cancels hide behavior.
  - Running-override-hide check validates `W3 -> W2` transition clears persisted override from `"open"` to `"auto"` and does not re-enter `W1`.
  - Sticky-hidden-restart check validates run start from `W4` transitions directly to `W2` without replaying run-start animation.
  - Refresh mid-run check validates first paint initializes hidden (`"auto"`) or visible (`"open"`) without replaying run-start transition.
  - WebSocket reconnect check validates no visible-idle flicker before reconnect snapshot reconciliation.
  - Completion outcome semantic check validates badge label mapping: `Error` for `last_error` present or `completion_reason === "error"`; otherwise `Complete` when completion reason exists.

### Manual Verification (required)
- [ ] Run `pnpm dev`, open `/watch`, and start a run from sidebar controls.
- [ ] Verify sidebar auto-hides when run becomes active and Watch panels expand to full width with a transition duration between 150ms and 200ms (DevTools animation/transition inspector).
- [ ] Wait for run completion and verify sidebar remains hidden until explicitly reopened.
- [ ] While run-start hide animation is in-flight, trigger explicit reopen and verify sidebar returns visible immediately without flicker.
- [ ] Reload the page during/after a run and confirm run-time sidebar override persists (`auto` vs `open`) as designed.
- [ ] Reload during an active run and verify the initial render matches expected state (`auto` => hidden, `open` => visible) without replaying run-start animation.
- [ ] Simulate websocket disconnect/reconnect during active run and verify UI preserves current state during disconnect, then reconciles once from reconnect snapshot.
- [ ] While running, verify Stop is available in Watch context strip and triggers stop.
- [ ] While running with sidebar explicitly open, trigger hide and verify transition goes directly to hidden state, persisted override is reset to `"auto"`, and no run-start animation replay occurs.
- [ ] From idle sticky-hidden state (`W4`), start a new run and verify state enters hidden running (`W2`) without replaying the 150-200ms run-start animation.
- [ ] After completion, verify outcome badge semantics: show `Complete` for non-error completion and `Error` for error completion (`last_error` present or reason `error`).
