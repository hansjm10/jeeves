# Design: Focused Mode for Active Runs

**Issue**: #71
**Status**: Draft - Classification Complete
**Feature Types**: Primary: UI, Secondary: Workflow, Data

---

## 1. Scope

### Problem
When a run is active, the Watch sidebar stays visible even though most controls are not actionable, so logs/SDK/progress panels lose useful space exactly when users are monitoring execution.

### Goals
- [ ] Automatically enter focused mode on run start by hiding the sidebar and expanding Watch content space.
- [ ] Keep focused mode stable through run completion until the user explicitly reopens the sidebar.
- [ ] Provide actionable run controls in context (Stop while running and deterministic completion outcome badge after run end).
- [ ] Persist user run-time sidebar visibility override across refresh/reconnect/session restore.
- [ ] Preserve responsive readability and token-compliant styling for focused mode on tablet/mobile.

### Non-Goals
- Introducing new backend run orchestration behavior, workflow engine logic, or viewer-server contracts.
- Adding new sidebar interaction paradigms (peek/overlay/sliver modes) beyond hide/show focused mode.
- Reworking unrelated Watch page information architecture, routes, or non-focused-mode UX flows.

### Boundaries
- **In scope**: Viewer-side focused-mode behavior in `AppShell`, `Header`, `WatchPage`, `runFocusState`, and related viewer CSS/token usage plus tests for those areas.
- **Out of scope**: New REST/WebSocket APIs, `.jeeves` schema/storage migrations, runner/viewer-server orchestration changes, and deployment/tooling pipeline changes.

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
