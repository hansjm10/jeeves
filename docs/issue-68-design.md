# Issue 68 Design Document: Unified Watch Page

**Issue:** [#68 - viewer: unify SDK/logs into a single Watch page](https://github.com/hansjm10/jeeves/issues/68)
**Status:** Implemented
**Last Updated:** 2026-02-02

---

## 1. Overview

This design document describes the implementation of a unified Watch page that combines SDK events, logs, and viewer logs into a single monitoring surface. The implementation replaces separate `/sdk`, `/logs`, and `/viewer-logs` pages with a unified `/watch` route that serves as the primary live-monitoring interface.

---

## 2. Problem Statement

The viewer previously had three separate pages for watching a run:
- `/sdk` — SDK events + tool timeline
- `/logs` — agent logs (workflow progress)
- `/viewer-logs` — viewer/server/client logs

This fragmentation made it difficult to:
- Monitor model + tool activity alongside workflow progress
- Understand the current workflow phase and iteration
- Maintain context while bouncing between tabs

---

## 3. Implemented Solution

### 3.1 New Unified Watch Page

**Route:** `/watch`

The Watch page is the new default landing page and provides:
- A **Run Context Strip** showing issue, workflow, phase, and iteration status
- A **Segmented View Toggle** with four modes: Combined, SDK, Logs, Viewer Logs
- **State-preserving panel layout** using CSS grid (no unmount/remount on view switch)

### 3.2 View Modes

| Mode | Description | Layout |
|------|-------------|--------|
| `combined` (default) | SDK + Logs side-by-side | Two-column grid |
| `sdk` | SDK events only | Single column |
| `logs` | Live logs only | Single column |
| `viewer-logs` | Viewer logs only | Single column |

### 3.3 URL-Driven View Selection

View selection is controlled via the `?view=` query parameter:
- Valid values: `combined`, `sdk`, `logs`, `viewer-logs`
- Invalid values are normalized to `combined` via `history.replaceState()`
- Other query parameters are preserved during normalization
- Back/forward navigation updates the view correctly

### 3.4 Legacy Route Redirects

| Legacy Route | Redirects To |
|--------------|--------------|
| `/sdk` | `/watch?view=sdk` |
| `/logs` | `/watch?view=logs` |
| `/viewer-logs` | `/watch?view=viewer-logs` |
| `/` (root) | `/watch` |
| `/*` (catch-all) | `/watch` |

---

## 4. Stream Run/State Semantics

### 4.1 Live Run Updates

The viewer client handles websocket `run` events to provide real-time iteration updates:

1. **Run events** (`{ type: 'run', data: { run: RunStatus } }`):
   - Stored in `runOverride` field on stream state
   - Updates `state.run` directly for UI consumers reading `stream.state?.run`
   - Updates `effectiveRun` for convenience

2. **State snapshots** (`{ type: 'state', data: IssueStateSnapshot }`):
   - Clears `runOverride` (snapshot supersedes prior run updates)
   - Updates `effectiveRun` to reflect the snapshot's run status

### 4.2 Precedence Rules

| Sequence | Behavior |
|----------|----------|
| `run` → `state` | Snapshot clears runOverride; snapshot.run is authoritative |
| `state` → `run` | Run update sets runOverride AND updates state.run |
| Multiple `run` | Last run update wins |

This ensures UI components reading `stream.state?.run` receive live updates while maintaining consistency with full state snapshots.

---

## 5. LogPanel UX

### 5.1 Follow-Tail Behavior

- **Initial state:** follow-tail enabled (auto-scroll to bottom)
- **Scroll detection:** if user scrolls more than 50px from bottom, follow-tail pauses
- **Resume control:** button appears when paused; clicking resumes follow-tail

### 5.2 Search Semantics

- **Query matching:** case-insensitive substring per line
- **Whitespace-only query:** shows all lines
- **No matches:** explicit "No matches found" empty state
- **Count display:** shows "X of Y shown" when filtering; "Y lines" when not filtering

### 5.3 Copy Behavior

| Action | Behavior |
|--------|----------|
| **Copy visible** | All filtered lines joined by `\n` with trailing `\n` when non-empty |
| **Copy selection** | Copies current text selection |
| **Disabled state** | Copy visible disabled when filtered lines is empty |
| **Failure handling** | Clipboard failures display error UI without throwing |

---

## 6. Run Context Strip

Located at the top of the Watch page, displays:

| Field | Source | Display |
|-------|--------|---------|
| Issue | `stream.state?.issue_ref` | Always shown |
| Workflow | `useWorkflowQuery()` | Always shown |
| Phase | `useWorkflowQuery()` | Always shown |
| Iteration | `stream.state?.run.current_iteration / max_iterations` | Only when running |

---

## 7. Decisions and Deviations

### 7.1 Decisions Made

1. **Route name:** `/watch` chosen over `/run` for clarity
2. **Default view:** `combined` provides the primary monitoring experience
3. **Panel preservation:** CSS grid sizing (0 vs 1fr) keeps panels mounted across view switches
4. **No SDK sub-view persistence:** Switching views doesn't persist SDK's internal tree/timeline mode

### 7.2 Deviations from Issue Text

| Issue Text | Implementation | Rationale |
|------------|----------------|-----------|
| "Replace top-level tabs `sdk`, `logs`, `viewer-logs`" | Tabs removed; routes redirect to Watch | Full replacement as specified |
| "Run context strip shows... `workflow` and `phase` (from `issue_json`)" | Uses `useWorkflowQuery()` instead of `issue_json` | Existing query provides workflow/phase; simpler integration |
| "Parse structured signals from logs" | Not implemented | Listed as stretch goal in issue |
| "Add timestamps for log lines" | Not implemented | Listed as stretch goal in issue |
| "Virtualize log rendering" | Not implemented | Listed as stretch goal in issue |

### 7.3 Partial Implementation Notes

- **Workflow/phase updates:** Currently sourced from `useWorkflowQuery()` which may not auto-refresh on websocket `state` events. Task T7 addresses this gap.

---

## 8. Test Plan

### 8.1 Stream Reducer Tests (`streamReducer.test.ts`)

| Test | Criterion |
|------|-----------|
| `stores run update in runOverride before first state snapshot` | Run events work without prior state |
| `run -> state: snapshot clears runOverride (snapshot wins)` | State supersedes run |
| `state -> run: run update sets runOverride and updates state.run` | Run updates work after state |
| `multiple run updates: last run wins` | Latest run is authoritative |
| `run -> state -> run: second run update re-establishes override` | Complex ordering handled |

### 8.2 LogPanel Tests (`LogPanel.test.ts`)

**Search/Filter Tests:**
- `returns all lines when query is empty`
- `returns all lines when query is whitespace-only`
- `matches case-insensitive (lowercase query matches uppercase)`
- `matches case-insensitive (uppercase query matches lowercase)`
- `matches substring within line`
- `returns empty array when no matches (empty state)`
- `trims query before matching`
- `handles special regex characters in query`

**Copy Formatting Tests:**
- `returns empty string when lines array is empty`
- `joins single line with trailing newline`
- `joins multiple lines with \n and adds trailing \n`
- `preserves empty lines in content`

**Clipboard Failure Tests:**
- `returns true on successful copy`
- `returns false on clipboard failure without throwing`
- `handles DOMException clipboard failures`
- `copyToClipboard failure returns false, enabling error state display`
- `copy selection uses same copyToClipboard as copy visible`

**Follow-Tail Tests:**
- `initial followTail state should be true`
- `scrolling up pauses follow-tail (threshold logic)`
- `Resume restores follow-tail`

**Count Display Tests:**
- `shows total count when not filtering`
- `shows "X of Y shown" when filtering`
- `shows "0 of Y shown" when no matches`

**Copy Disabled State Tests:**
- `copy is disabled when filtered lines is empty`
- `copy is enabled when filtered lines has content`

### 8.3 Router Tests (`router.test.ts`)

**Route Matching:**
- `/watch route matches`
- `/workflows route matches`
- `/create-issue route matches`
- `/prompts route matches`
- `/prompts/subpath route matches`

**Redirects:**
- `/ route matches index route` (redirects to /watch)
- `/sdk route matches (redirect)`
- `/logs route matches (redirect)`
- `/viewer-logs route matches (redirect)`
- `unknown route matches catch-all`

**Configuration:**
- `route config has expected structure`
- `watch route comes before legacy redirects`

---

## 9. Files Modified

### Core Implementation

| File | Changes |
|------|---------|
| `apps/viewer/src/pages/WatchPage.tsx` | New: Watch page with context strip, view toggle, panel layout |
| `apps/viewer/src/app/router.tsx` | Root redirect to /watch; legacy route redirects |
| `apps/viewer/src/layout/AppShell.tsx` | Tab links updated (watch replaces sdk/logs/viewer-logs) |
| `apps/viewer/src/stream/streamReducer.ts` | Extended with runOverride/effectiveRun for live run updates |
| `apps/viewer/src/stream/ViewerStreamProvider.tsx` | Handles websocket `run` events |
| `apps/viewer/src/ui/LogPanel.tsx` | Follow-tail, search, copy, error handling |

### Tests

| File | Coverage |
|------|----------|
| `apps/viewer/src/stream/streamReducer.test.ts` | Run/state ordering precedence |
| `apps/viewer/src/ui/LogPanel.test.ts` | Follow-tail, search, copy, clipboard failures |
| `apps/viewer/src/app/router.test.ts` | Route matching, redirects, configuration |

---

## 10. Implementation Checklist

- [x] `/watch` route exists and defaults to Combined view
- [x] Run context strip displays issue, workflow, phase, iteration
- [x] View selection is URL-driven via `?view=` with normalization
- [x] Switching views preserves pane state (no unmount/remount)
- [x] LogPanel follow-tail pauses on scroll-up with Resume control
- [x] LogPanel search: case-insensitive substring, empty state for no matches
- [x] LogPanel copy: trailing newline, disabled when empty, clipboard error handling
- [x] Legacy routes redirect to Watch with view mapping
- [x] Root route redirects to /watch
- [x] Stream reducer handles run/state precedence
- [x] Tests pass: lint, typecheck, vitest
- [x] No hex colors outside tokens.css
