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

This feature introduces a **two-level workflow** that must stay consistent:
1) a viewer UI state machine for editing token settings, and
2) a viewer-server “sync operation” state machine that persists issue-scoped state and reconciles the worktree.

### State Gates (explicit answers)
1. **All states/phases involved (exhaustive)**:
   - UI: `ui.closed`, `ui.loading`, `ui.ready_worktree_absent_token_absent`, `ui.ready_worktree_absent_token_present`, `ui.ready_worktree_present_token_absent`, `ui.ready_worktree_present_token_present`, `ui.saving`, `ui.removing`, `ui.error`
   - Sync op: `op.idle`, `op.validate`, `op.persist_issue_state`, `op.ensure_git_exclude`, `op.reconcile_worktree`, `op.record_sync_result`, `op.done_success`, `op.done_error`
2. **Initial state**:
   - UI: `ui.closed` (entered on app load, route change away, or issue deselect)
   - Sync op: `op.idle` (entered on viewer-server boot and after each operation completes)
3. **Terminal states**:
   - Sync op: `op.done_success`, `op.done_error` (terminal because the request/reconcile attempt is complete; the machine returns to `op.idle` for the next attempt)
   - UI: no true terminal state; `ui.closed` is the quiescent “not in use” state.
4. **Next states for each non-terminal state**:
   - UI:
     - `ui.closed` → `ui.loading`
     - `ui.loading` → `ui.ready_*` or `ui.error` or `ui.closed`
     - `ui.ready_*` → `ui.saving` or `ui.removing` or `ui.loading` or `ui.closed`
     - `ui.saving` → `ui.ready_*` or `ui.error` or `ui.closed`
     - `ui.removing` → `ui.ready_*` or `ui.error` or `ui.closed`
     - `ui.error` → `ui.loading` or a `ui.ready_*` state or `ui.closed`
   - Sync op:
     - `op.idle` → `op.validate`
     - `op.validate` → `op.persist_issue_state` or `op.ensure_git_exclude` or `op.done_error`
     - `op.persist_issue_state` → `op.ensure_git_exclude` or `op.record_sync_result` or `op.done_error`
     - `op.ensure_git_exclude` → `op.reconcile_worktree` or `op.record_sync_result`
     - `op.reconcile_worktree` → `op.record_sync_result`
     - `op.record_sync_result` → `op.done_success` or `op.done_error`

### States
| State | Description | Entry Condition |
|-------|-------------|-----------------|
| ui.closed | Sonar token settings UI is not active; no in-flight requests. | Viewer route/panel not open, app load, or issue deselect. |
| ui.loading | Fetch token presence + sync status for the selected issue; determine whether a worktree exists. | Open settings panel, issue selection change, explicit refresh/retry. |
| ui.ready_worktree_absent_token_absent | Worktree missing; no token stored for the issue. UI offers add token; sync is not possible yet. | `ui.loading` success and `worktreePresent=false`, `hasToken=false`. |
| ui.ready_worktree_absent_token_present | Worktree missing; token stored for the issue. UI offers update/remove token; sync will be deferred until worktree exists. | `ui.loading` success and `worktreePresent=false`, `hasToken=true`. |
| ui.ready_worktree_present_token_absent | Worktree present; no token stored. UI offers add token; `.env.jeeves` should be absent. | `ui.loading` success and `worktreePresent=true`, `hasToken=false`. |
| ui.ready_worktree_present_token_present | Worktree present; token stored. UI offers update/remove; `.env.jeeves` should be present and git-ignored. | `ui.loading` success and `worktreePresent=true`, `hasToken=true`. |
| ui.saving | User submitted a token; UI waits for server to persist and reconcile. | Save/update action from any `ui.ready_*` state. |
| ui.removing | User requested token removal; UI waits for server to persist and reconcile. | Remove action from any `ui.ready_*` token-present state. |
| ui.error | UI displays an error message; user can retry or dismiss. Holds last stable ready snapshot. | Any non-cancelled request failure or server-declared failure. |
| op.idle | No operation running for an issue/worktree. | Viewer-server boot; after `op.done_*`. |
| op.validate | Validate request and resolve issue/worktree context. | Any trigger event (UI save/remove; worktree create/refresh; viewer-server startup reconcile). |
| op.persist_issue_state | Write issue-scoped Sonar token state (and desired sync intent) outside the worktree. | `SAVE_TOKEN_REQUEST` or `REMOVE_TOKEN_REQUEST` after `op.validate`. |
| op.ensure_git_exclude | Ensure `.env.jeeves` is ignored via worktree-local exclude (no tracked file modifications). | Worktree present and after `op.persist_issue_state` or directly after `op.validate` for reconcile. |
| op.reconcile_worktree | Converge worktree artifacts to desired state: write/update/delete `.env.jeeves` atomically and set permissions. | After `op.ensure_git_exclude` with worktree present. |
| op.record_sync_result | Persist sync result metadata (applied/pending/failed) without logging secrets. | After reconcile attempt (or skipped due to missing worktree). |
| op.done_success | Operation finished; response returned or reconcile completed. | `op.record_sync_result` when no fatal error occurred. |
| op.done_error | Operation finished with a fatal error (no reliable persistence). | Any fatal failure before issue state can be written, or corrupted state detected. |

### Transitions
| From | Event/Condition | To | Side Effects |
|------|-----------------|-----|--------------|
| ui.closed | User opens Sonar token settings for a selected issue | ui.loading | Start `GET token_status` request; clear UI error. |
| ui.closed | Issue deselected / route change away | ui.closed | Cancel/ignore any late responses (UI only). |
| ui.loading | `GET token_status` success: `worktreePresent=false`, `hasToken=false` | ui.ready_worktree_absent_token_absent | Render token form; show “sync deferred” note. |
| ui.loading | `GET token_status` success: `worktreePresent=false`, `hasToken=true` | ui.ready_worktree_absent_token_present | Render masked token status + actions. |
| ui.loading | `GET token_status` success: `worktreePresent=true`, `hasToken=false` | ui.ready_worktree_present_token_absent | Render token form; show current sync status. |
| ui.loading | `GET token_status` success: `worktreePresent=true`, `hasToken=true` | ui.ready_worktree_present_token_present | Render masked token status + actions. |
| ui.loading | `GET token_status` fails (network/server/timeout) and settings still open | ui.error | Record error message (no token); keep last stable ready snapshot if any. |
| ui.loading | User closes panel while request in-flight | ui.closed | Cancel/ignore late response; no further side effects. |
| ui.ready_worktree_absent_token_absent | User saves token | ui.saving | Start `PUT token` request (body includes token); UI must not log token. |
| ui.ready_worktree_absent_token_present | User updates token | ui.saving | Start `PUT token` request (body includes token); UI must not log token. |
| ui.ready_worktree_present_token_absent | User saves token | ui.saving | Start `PUT token` request (body includes token). |
| ui.ready_worktree_present_token_present | User updates token | ui.saving | Start `PUT token` request (body includes token). |
| ui.ready_worktree_absent_token_present | User removes token | ui.removing | Start `DELETE token` request. |
| ui.ready_worktree_present_token_present | User removes token | ui.removing | Start `DELETE token` request. |
| ui.ready_* | Issue selection changes while open | ui.loading | Abort/ignore any in-flight save/remove; refetch for new issue. |
| ui.ready_* | User closes panel | ui.closed | Cancel UI timers; no server side effects. |
| ui.saving | `PUT token` success + `worktreePresent=false` | ui.ready_worktree_absent_token_present | Show saved state; indicate sync is pending until worktree exists. |
| ui.saving | `PUT token` success + `worktreePresent=true` | ui.ready_worktree_present_token_present | Show saved state; show `syncStatus` (applied/failed). |
| ui.saving | `PUT token` fails and panel still open | ui.error | Record error; do not display token; allow retry. |
| ui.saving | User closes panel while request in-flight | ui.closed | Ignore late response; operation may still complete server-side. |
| ui.removing | `DELETE token` success + `worktreePresent=false` | ui.ready_worktree_absent_token_absent | Show removed state; sync is trivially satisfied. |
| ui.removing | `DELETE token` success + `worktreePresent=true` | ui.ready_worktree_present_token_absent | Show removed state; show `syncStatus` (applied/failed). |
| ui.removing | `DELETE token` fails and panel still open | ui.error | Record error; allow retry. |
| ui.removing | User closes panel while request in-flight | ui.closed | Ignore late response; operation may still complete server-side. |
| ui.error | User clicks retry | ui.loading | Re-run `GET token_status`. |
| ui.error | User dismisses error and last stable state exists | (last stable ui.ready_*) | No server side effects. |
| ui.error | User closes panel | ui.closed | No server side effects. |
| op.idle | Trigger: `SAVE_TOKEN_REQUEST(token)` | op.validate | Acquire per-issue/worktree mutex; start operation log entry without token value. |
| op.idle | Trigger: `REMOVE_TOKEN_REQUEST` | op.validate | Acquire mutex; start operation log entry. |
| op.idle | Trigger: `RECONCILE_REQUEST` (viewer-server startup, worktree create/refresh, or explicit “resync”) | op.validate | Acquire mutex; start reconcile attempt. |
| op.validate | Request invalid (missing issue, bad token shape, oversized token) | op.done_error | Return 4xx; write sanitized error to request log; no token persisted. |
| op.validate | `SAVE_TOKEN_REQUEST` or `REMOVE_TOKEN_REQUEST` valid | op.persist_issue_state | Compute `desiredState` (present/absent); set `desiredEnvFilePath=<worktree>/.env.jeeves` if worktree known. |
| op.validate | `RECONCILE_REQUEST` and worktree present | op.ensure_git_exclude | Load issue state to determine desired presence; do not read/write token unless needed for writing env. |
| op.validate | `RECONCILE_REQUEST` and worktree absent | op.record_sync_result | Record `syncStatus=pending_no_worktree`; return success (no-op). |
| op.persist_issue_state | Persist fails (permissions, IO, JSON parse/serialize) | op.done_error | Return 5xx; do not attempt worktree writes; record sanitized error. |
| op.persist_issue_state | Worktree absent | op.record_sync_result | Record `syncStatus=pending_no_worktree`; return success for persistence. |
| op.persist_issue_state | Worktree present | op.ensure_git_exclude | Continue to worktree reconciliation. |
| op.ensure_git_exclude | Exclude update succeeds | op.reconcile_worktree | Write/ensure `.git/info/exclude` contains `.env.jeeves` (idempotent). |
| op.ensure_git_exclude | Exclude update fails (permissions/IO) | op.record_sync_result | Record `syncStatus=failed_exclude`; continue without writing env file. |
| op.reconcile_worktree | Desired=present | op.record_sync_result | Atomically write `.env.jeeves` with `SONAR_TOKEN=…`; `chmod 0600`; never log contents. |
| op.reconcile_worktree | Desired=absent | op.record_sync_result | Remove `.env.jeeves` if present; ignore missing-file errors. |
| op.reconcile_worktree | Env write/delete fails (permissions/IO/disk full) | op.record_sync_result | Record `syncStatus=failed_env`; ensure no partial file by using temp+rename; never log token. |
| op.record_sync_result | Fatal state corruption detected (issue state unreadable) | op.done_error | Return 5xx; log sanitized error; do not proceed. |
| op.record_sync_result | Non-fatal sync failure recorded (exclude/env) | op.done_success | Return success-with-warning; persist `lastError` (sanitized) and `lastAttemptAt`. |
| op.record_sync_result | Sync applied or pending recorded | op.done_success | Persist `lastAppliedAt` when applied; clear `lastError` on success. |
| op.done_success | Operation completes | op.idle | Release mutex; no further side effects. |
| op.done_error | Operation completes | op.idle | Release mutex; no further side effects. |

### Transition Gates (explicit answers)
5. **What condition triggers each transition?** Fully enumerated in the Transitions table (event/condition column).
6. **What side effects occur?** Fully enumerated in the Transitions table (side effects column). Key writes are:
   - Issue-scoped state write (token + sync metadata) outside the worktree.
   - Worktree writes: `.git/info/exclude` update; `.env.jeeves` write/delete with `0600` permissions.
7. **Reversibility**:
   - UI transitions are reversible only via explicit user actions (close, retry, save/remove).
   - Sync op transitions are not reversed within an operation; to reverse the effect, a new operation is issued (`SAVE_TOKEN_REQUEST` vs `REMOVE_TOKEN_REQUEST`).

### Error Handling
| State | Error | Recovery State | Actions |
|-------|-------|----------------|---------|
| ui.loading | Request timeout / network error / 5xx | ui.error | Show sanitized message; allow retry; keep last stable ready snapshot if any. |
| ui.saving | 4xx validation error | ui.error | Show “invalid token” message; do not echo token; user can correct and retry. |
| ui.saving | 5xx persistence failure | ui.error | Show “could not save” message; token not persisted; allow retry. |
| ui.saving | Success-with-warning: `syncStatus=failed_*` | ui.ready_worktree_present_token_present | Return to ready; display “saved but not synced” warning (no token value). |
| ui.removing | 5xx persistence failure | ui.error | Show “could not remove” message; allow retry. |
| ui.removing | Success-with-warning: `syncStatus=failed_*` | ui.ready_worktree_present_token_absent | Return to ready; display “removed but cleanup incomplete” warning. |
| op.validate | Invalid token format/size | op.done_error | Reject request; log error code only; no writes. |
| op.persist_issue_state | IO/permission failure writing issue state | op.done_error | Abort; log sanitized error; do not attempt worktree writes. |
| op.ensure_git_exclude | IO/permission failure updating exclude | op.done_success | Record `failed_exclude`; do not write env file; return warning. |
| op.reconcile_worktree | IO/permission/disk failure writing/deleting env | op.done_success | Record `failed_env`; ensure atomic write; return warning. |
| op.record_sync_result | Issue state unreadable/corrupted | op.done_error | Abort; log sanitized error; require manual intervention (e.g., delete/repair issue state). |
| any op state | Mutex acquisition timeout (stuck operation) | op.done_error | Fail request; log “concurrency” error; no further writes in this attempt. |

**Per-state error inventory (explicit answers to “for each state, what errors can occur?”)**:
- `ui.closed`: none.
- `ui.loading`: timeout/network/5xx → `ui.error`.
- `ui.ready_worktree_absent_token_absent`: none (errors only occur once a request is initiated).
- `ui.ready_worktree_absent_token_present`: none (errors only occur once a request is initiated).
- `ui.ready_worktree_present_token_absent`: none (errors only occur once a request is initiated).
- `ui.ready_worktree_present_token_present`: none (errors only occur once a request is initiated).
- `ui.saving`: validation failure or persistence failure → `ui.error`; sync warning → `ui.ready_worktree_present_token_present`.
- `ui.removing`: persistence failure → `ui.error`; sync warning → `ui.ready_worktree_present_token_absent`.
- `ui.error`: none (user can retry/dismiss/close).
- `op.idle`: none.
- `op.validate`: invalid input → `op.done_error`; mutex timeout → `op.done_error`.
- `op.persist_issue_state`: IO/permission failure → `op.done_error`.
- `op.ensure_git_exclude`: IO/permission failure → `op.done_success` with warning recorded.
- `op.reconcile_worktree`: IO/permission/disk failure → `op.done_success` with warning recorded.
- `op.record_sync_result`: corrupted/unreadable issue state → `op.done_error`.
- `op.done_success`: none.
- `op.done_error`: none.

### Global vs Per-State Error Handling (explicit answers)
10. **What gets logged/recorded?**
   - UI: only sanitized error strings; never token values; no logging of request bodies.
   - Viewer-server: structured logs with error codes and paths, never token values; issue state stores only sanitized `lastError` and timestamps.
11. **Global handler?**
   - Viewer-server uses a global request error boundary (Fastify error handler) plus per-operation try/catch to ensure `op.*` always records a sanitized result and releases the mutex.

### Crash Recovery
- **Detection**: On viewer-server startup and on each `RECONCILE_REQUEST`, compare desired state (issue-scoped token present/absent) to observed worktree state (existence of `.env.jeeves`) and/or detect `lastError` or `syncStatus=failed_*` in issue state.
- **Recovery state**: Resume by enqueueing a `RECONCILE_REQUEST` which enters `op.validate` (UI remains in `ui.loading`/`ui.ready_*` depending on user navigation).
- **Cleanup**:
  - Delete any leftover temp file used for atomic writes (e.g., `.env.jeeves.tmp`) if present.
  - Re-apply `.git/info/exclude` idempotently (dedupe entries).
  - Re-run env reconcile (write/delete) idempotently.

### Recovery Gates (explicit answers)
12. **Crash mid-state recovery**: Use atomic write+rename so `.env.jeeves` is either old or new; never partially written. If crash occurs, the next reconcile attempt converges to desired.
13. **State we recover into**: `op.validate` via `RECONCILE_REQUEST`.
14. **How recovery is detected**: mismatch between desired vs observed, or presence of `lastError` / `failed_*` status, or leftover temp files.
15. **Cleanup before resuming**: remove temp artifacts; ensure `.git/info/exclude` is correct; then reconcile env file.

### Subprocesses (if applicable)
No subprocesses are required for this feature; reconciliation uses in-process filesystem operations.

| Subprocess | Receives | Can Write | Failure Handling |
|------------|----------|-----------|------------------|
| none | n/a | n/a | n/a |

## 3. Interfaces
[To be completed in design_api phase]

## 4. Data
[To be completed in design_data phase]

## 5. Tasks
[To be completed in design_plan phase]

## 6. Validation
[To be completed in design_plan phase]
