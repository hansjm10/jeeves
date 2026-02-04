# Design: Sonar Token Settings Sync

**Issue**: #95
**Status**: Draft - Classification Complete
**Feature Types**: Primary: API, Secondary: Data Model, Workflow

---

## 1. Scope

### Problem
Running SonarQube/SonarCloud tooling from a Jeeves worktree currently requires manual token setup each time, and there is no issue-scoped place in the viewer to manage it or keep it synced into the worktree safely.

### Goals
- [ ] Provide a viewer UI to add/edit/remove a Sonar authentication token for the currently selected issue/worktree.
- [ ] Persist the token in issue-scoped local state (outside the git worktree) without leaking it via UI rendering, logs, or streaming payloads.
- [ ] Materialize the token into the corresponding worktree as an env file (e.g., `.env.jeeves`) on worktree create/refresh and on token updates/removal, and ensure it is git-ignored without modifying tracked files.

### Non-Goals
- Running SonarQube/SonarCloud scans automatically or adding broader Sonar workflow automation.
- Storing secrets in tracked repo files (e.g., committing `.env` files or editing the repo’s `.gitignore`).
- Providing cross-issue/global token sharing, remote sync, or multi-user secret management.
- Implementing OS keychain integration or encryption-at-rest beyond existing local state storage.

### Boundaries
- **In scope**: Viewer settings flow, viewer-server endpoints/contracts, issue-scoped secret persistence, worktree env materialization, git ignore via `.git/info/exclude` (or equivalent), and a basic automated test for save + write/remove behavior.
- **Out of scope**: Changes to external Sonar tooling behavior, updating existing helper scripts to auto-source env files, or introducing a general-purpose secrets system beyond the Sonar token use case.

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

