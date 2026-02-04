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

This section defines **all viewer-server HTTP endpoints**, **streaming events**, and **UI ↔ server interactions** for managing an issue-scoped Sonar token and syncing it into the selected issue’s worktree.

### Conventions (applies to all endpoints below)

**Content-Type**:
- Requests with a body MUST send `Content-Type: application/json`.
- Responses are JSON unless noted.

**Success envelope**:
```json
{ "ok": true, "...": "..." }
```

**Error envelope (consistent across endpoints)**:
```json
{ "ok": false, "error": "human readable message", "code": "optional_machine_code", "field_errors": { "optional": "map" } }
```

**Mutation gating / auth**:
- Mutating endpoints are **localhost-only** unless viewer-server is started with `--allow-remote-run` (matches existing `requireMutatingAllowed` behavior).
- All endpoints are subject to the existing **Origin allowlist/same-origin** gate.

**Selected issue scoping**:
- Endpoints in this section operate on the **currently selected issue** in viewer-server (no `issue_ref` parameter).

**No secret exfiltration**:
- The token value MUST NEVER be returned by any endpoint or streaming event.
- Token values MUST NEVER be logged or included in viewer logs / SSE / WS payloads.

### Endpoints

| Method | Path | Input | Success | Errors |
|--------|------|-------|---------|--------|
| GET | `/api/issue/sonar-token` | none | 200: `SonarTokenStatusResponse` | 400, 403, 500 |
| PUT | `/api/issue/sonar-token` | `PutSonarTokenRequest` | 200: `SonarTokenMutateResponse` | 400, 403, 409, 500, 503 |
| DELETE | `/api/issue/sonar-token` | none | 200: `SonarTokenMutateResponse` | 400, 403, 409, 500, 503 |
| POST | `/api/issue/sonar-token/reconcile` | `ReconcileSonarTokenRequest` | 200: `SonarTokenMutateResponse` | 400, 403, 409, 500, 503 |

#### Types

**Enums**
- `SonarSyncStatus`:
  - `in_sync`: token desired state matches worktree materialization and `.git/info/exclude` is updated.
  - `deferred_worktree_absent`: token is stored issue-scoped, but worktree does not exist; nothing to sync yet.
  - `failed_exclude`: desired sync could not proceed because `.git/info/exclude` update failed.
  - `failed_env_write`: `.env.jeeves` write failed (token desired=present).
  - `failed_env_delete`: `.env.jeeves` delete failed (token desired=absent).
  - `never_attempted`: no reconcile has been attempted since last token change / issue init.

**GET /api/issue/sonar-token → SonarTokenStatusResponse**
```ts
type SonarTokenStatusResponse = {
  ok: true;
  issue_ref: string;
  worktree_present: boolean;
  has_token: boolean;
  sync_status: SonarSyncStatus;
  last_attempt_at: string | null; // ISO-8601
  last_success_at: string | null; // ISO-8601
  last_error: string | null; // sanitized; MUST NOT include token
};
```

Errors:
- `400` `{"ok":false,"error":"No issue selected.","code":"no_issue_selected"}` when no issue is selected.
- `403` `{"ok":false,"error":"Origin not allowed","code":"forbidden"}` when the request Origin is not allowed.
- `500` `{"ok":false,"error":"...","code":"io_error"}` when issue-scoped status cannot be read.

**PUT /api/issue/sonar-token (save/update)**
1) **Path**: `/api/issue/sonar-token`  
2) **Method**: `PUT`  
3) **Input parameters** (`PutSonarTokenRequest`):
```ts
type PutSonarTokenRequest = {
  token: string;         // required
  sync_now?: boolean;    // optional; default true
};
```
4) **Success** (`SonarTokenMutateResponse`, 200):
```ts
type SonarTokenMutateResponse = {
  ok: true;
  updated: true; // always true for PUT
  status: Omit<SonarTokenStatusResponse, "ok">;
  warnings: string[]; // may be empty; MUST NOT include token
};
```
5) **Errors**:
- `400` `{"ok":false,"error":"...","code":"validation_failed","field_errors":{...}}` when:
  - `token` is missing, not a string, empty after trim, exceeds max length, or contains `\0`, `\n`, or `\r`.
  - `sync_now` is provided but is not a boolean.
- `403` `{"ok":false,"error":"...","code":"forbidden"}` when mutation is not allowed from the requester (non-local without `--allow-remote-run`, or Origin not allowed).
- `409` `{"ok":false,"error":"Cannot edit while Jeeves is running.","code":"conflict_running"}` when Jeeves is currently running (token changes are disallowed during an active run).
- `503` `{"ok":false,"error":"...","code":"busy"}` when an existing token-sync operation mutex cannot be acquired within a fixed timeout (prevents concurrent writes).
- `500` `{"ok":false,"error":"...","code":"io_error"}` when issue-scoped state cannot be written (no worktree writes should be attempted in this case).

**DELETE /api/issue/sonar-token (remove)**
1) **Path**: `/api/issue/sonar-token`  
2) **Method**: `DELETE`  
3) **Input parameters**: none (body ignored if provided)  
4) **Success** (`SonarTokenMutateResponse`, 200):
- `updated` MUST be `true` if a token previously existed, else `false` (idempotent remove).
- `status.has_token` MUST be `false` on success.
5) **Errors**:
- `400` `{"ok":false,"error":"No issue selected.","code":"no_issue_selected"}` when no issue is selected.
- `403` forbidden (same as PUT).
- `409` `{"ok":false,"error":"Cannot edit while Jeeves is running.","code":"conflict_running"}` when Jeeves is running.
- `503` busy mutex timeout (same as PUT).
- `500` io_error writing issue-scoped state (do not attempt worktree cleanup if state write fails).

**POST /api/issue/sonar-token/reconcile (retry sync / converge worktree)**
1) **Path**: `/api/issue/sonar-token/reconcile`  
2) **Method**: `POST`  
3) **Input parameters** (`ReconcileSonarTokenRequest`):
```ts
type ReconcileSonarTokenRequest = {
  force?: boolean; // optional; default false; if true, rewrites/removes even if already in desired state
};
```
4) **Success** (`SonarTokenMutateResponse`, 200):
- `updated` MUST be `false` (reconcile does not change the stored token presence; it only attempts to sync side-effects).
- `warnings` may include “worktree not present; deferred” or filesystem failures (sanitized).
5) **Errors**:
- `400` no issue selected; invalid `force` type.
- `403` forbidden (same as PUT).
- `409` conflict_running when Jeeves is running (reconcile is disallowed during an active run).
- `503` busy mutex timeout (same as PUT).
- `500` io_error reading issue-scoped state, or unrecoverable corruption/unreadable state.

### CLI Commands (if applicable)

No new CLI commands are introduced for this feature. The viewer UI + viewer-server API are the supported interfaces.

### Events (streaming, if applicable)

All events are delivered over:
- **SSE**: `GET /api/stream` (`event: <name>` + JSON `data: ...`)
- **WebSocket**: `GET /api/ws` (JSON `{ event: string, data: unknown }`)

| Event | Trigger | Payload | Consumers |
|-------|---------|---------|-----------|
| `sonar-token-status` | After any successful PUT/DELETE/RECONCILE completes, and after automatic reconcile on issue init/select (if implemented). | `SonarTokenStatusEvent` | Viewer UI Sonar settings panel (and any future settings dashboards). |

**sonar-token-status → SonarTokenStatusEvent**
```ts
type SonarTokenStatusEvent = {
  issue_ref: string;
  worktree_present: boolean;
  has_token: boolean;
  sync_status: SonarSyncStatus;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null; // sanitized
};
```

### Validation Rules

| Field | Type | Constraints | Error |
|------|------|-------------|-------|
| `token` | string | required for PUT; trimmed; length `1..1024`; MUST NOT contain `\0`, `\n`, `\r` | 400 `code=validation_failed`, `field_errors.token` |
| `sync_now` | boolean | optional; default `true` | 400 `field_errors.sync_now` |
| `force` | boolean | optional; default `false` | 400 `field_errors.force` |

**When validation fails**:
- Response: `400` with the standard error envelope.
- Validation is **synchronous** (string/type checks only). No remote Sonar verification is performed.

### UI Interactions (viewer)

| Action | Request | Loading State | Success | Error |
|--------|---------|---------------|---------|-------|
| Open Sonar token settings panel | `GET /api/issue/sonar-token` | Show spinner; disable form | Render “token present/absent” + sync status; never show token value | Inline error state with retry button |
| Save/update token | `PUT /api/issue/sonar-token` | Disable inputs/buttons; show “Saving…” | Show “Saved” toast; if `warnings.length>0`, show non-fatal warning banner (no token); refresh status | Show error toast + inline message; remain on form with token field cleared |
| Remove token | `DELETE /api/issue/sonar-token` | Disable controls; show “Removing…” | Show “Removed” toast; if warnings, show banner; refresh status | Show error toast; remain on panel with prior status |
| Retry sync | `POST /api/issue/sonar-token/reconcile` | Disable controls; show “Syncing…” | Update sync status; if warnings, show banner | Show error toast; preserve prior status |
| Close panel / change issue | none (local UI action) | Cancel in-flight fetch via AbortController (client-side) | UI returns to closed/next issue state | n/a |

### Worktree Filesystem Contracts (internal but externally observable)

These side-effects are part of the feature contract because they impact how users run tooling inside the worktree.

**Env file materialization**
- **Path**: `<worktreeRoot>/.env.jeeves`
- **Format** (exact):
  - When `has_token=true`: file MUST contain exactly one variable assignment line (plus trailing newline): `SONAR_TOKEN=<token>\n`.
  - When `has_token=false`: file MUST be removed if it exists.
- **Permissions**:
  - Write with restrictive permissions (target `0600` where supported).
- **Atomicity**:
  - Writes MUST be atomic: write to `<worktreeRoot>/.env.jeeves.tmp` then rename to `.env.jeeves`.
  - On startup/reconcile, `.env.jeeves.tmp` MUST be cleaned up if present.

**Git ignore behavior**
- **Path**: `<worktreeRoot>/.git/info/exclude`
- **Entries** (must be present, deduped):
  - `.env.jeeves`
  - `.env.jeeves.tmp`

### Contract Gates

13) **Breaking change?** No. This design adds new endpoints and one new streaming event only.  
14) **Migration path?** Not applicable (no existing consumer contract is being removed or changed).  
15) **Versioning?** No version bump required. If future breaking changes are needed, introduce new endpoints (e.g. `/api/v2/...`) rather than changing payload shapes in-place.

## 4. Data

This feature introduces **issue-scoped secret storage** for a Sonar authentication token plus **non-secret sync metadata** for safely materializing that token into a worktree.

### Schema Changes
| Location | Field | Type | Required | Default | Constraints |
|----------|-------|------|----------|---------|-------------|
| `.jeeves/issue.json` | `status.sonarToken` | object | no | `{}` | if present, MUST be an object |
| `.jeeves/issue.json` | `status.sonarToken.sync_status` | string | no | `"never_attempted"` | enum: `in_sync`, `deferred_worktree_absent`, `failed_exclude`, `failed_env_write`, `failed_env_delete`, `never_attempted` |
| `.jeeves/issue.json` | `status.sonarToken.last_attempt_at` | string \| null | no | `null` | ISO-8601 UTC string ending in `Z` |
| `.jeeves/issue.json` | `status.sonarToken.last_success_at` | string \| null | no | `null` | ISO-8601 UTC string ending in `Z` |
| `.jeeves/issue.json` | `status.sonarToken.last_error` | string \| null | no | `null` | sanitized; max 2048 chars; MUST NOT include token; MUST NOT include `\0`, `\n`, `\r` |
| `.jeeves/.secrets/sonar-token.json` | `schemaVersion` | number | yes | `1` | literal `1` |
| `.jeeves/.secrets/sonar-token.json` | `token` | string | yes | n/a | trimmed; length `1..1024`; MUST NOT include `\0`, `\n`, `\r` |
| `.jeeves/.secrets/sonar-token.json` | `updated_at` | string | yes | n/a | ISO-8601 UTC string ending in `Z` |

**Secret storage invariant**:
- The token value MUST NOT be stored anywhere in `.jeeves/issue.json` (because `.jeeves/issue.json` is streamed to the viewer via `issue_json` in `IssueStateSnapshot`).

### Field Definitions

**`status.sonarToken.sync_status`**
- Purpose: Persist the last-known worktree reconciliation outcome for the selected issue without storing any secrets.
- Type: `SonarSyncStatus` (string enum)
- Set by: Viewer-server token operations (PUT/DELETE/RECONCILE) after attempting reconciliation.
- Read by: `GET /api/issue/sonar-token` and `sonar-token-status` event emission.
- Default when absent: `"never_attempted"`.
- Constraints:
  - Allowed values: `in_sync`, `deferred_worktree_absent`, `failed_exclude`, `failed_env_write`, `failed_env_delete`, `never_attempted`.
  - MUST be updated in the same request that performs reconciliation attempts.
- Relationships:
  - References: none (pure status).
  - Deletion behavior: when issue state is deleted, this field disappears with it; no cascading effects required.
  - If the worktree is deleted/missing: next status read MUST report `worktree_present=false` and set `sync_status` to `deferred_worktree_absent` when `has_token=true`, else `in_sync` when `has_token=false`.
  - Ordering dependencies: updated only after secret persistence and any worktree side-effects are attempted.
- Migration notes:
  - Not breaking: existing issue states will not have this field.
  - Existing records: treat missing as `"never_attempted"`.
  - Migration script: not required.
  - Rollback: remove this field; interpret as default.
- Derivation:
  - Not derived from other stored fields; set on write as the result of the reconcile attempt.
  - If worktree state changes externally, `sync_status` may become stale until the next reconcile (manual or on init/select).

**`status.sonarToken.last_attempt_at` / `status.sonarToken.last_success_at`**
- Purpose: Provide stable UX and diagnostics across restarts for when reconcile was last tried and last succeeded.
- Type: `string | null` (ISO-8601 UTC timestamp)
- Required: optional.
- Default when absent: `null`.
- Constraints:
  - MUST be a `Date.toISOString()`-formatted UTC timestamp (e.g., `2026-02-04T17:58:44.956Z`) when present.
  - `last_success_at` MUST be `<= last_attempt_at` when both are present.
- Relationships: none.
- Migration notes: missing fields treated as `null`; no script required; rollback by deleting the fields.
- Derivation:
  - Computed on write:
    - `last_attempt_at` is set each time a reconcile is attempted.
    - `last_success_at` is set only when reconciliation fully succeeds (`sync_status=in_sync`).

**`status.sonarToken.last_error`**
- Purpose: Persist a sanitized, non-secret error string for the last reconcile attempt (for UI display and debugging).
- Type: `string | null`
- Required: optional.
- Default when absent: `null`.
- Constraints:
  - Max length: 2048 characters (truncate beyond this).
  - MUST NOT contain the token value, request bodies, or file contents.
  - MUST NOT contain `\0`, `\n`, or `\r` (replace with spaces before persisting if needed).
- Relationships: none.
- Migration notes: missing treated as `null`; rollback by deleting the field.
- Derivation:
  - Computed on write from caught errors (sanitized) during reconcile attempts.
  - If subsequent attempts succeed, this SHOULD be cleared (`null`) to avoid stale error banners.

**`.jeeves/.secrets/sonar-token.json`**
- Purpose: Store the Sonar token value issue-scoped, outside the git worktree, without ever streaming it to the viewer.
- Location: `<issueStateDir>/.secrets/sonar-token.json` (reachable as `.jeeves/.secrets/sonar-token.json` from within the worktree due to the `.jeeves` symlink).
- Type: JSON object with exact fields below.
- Required: only exists when a token is configured; absence means `has_token=false`.
- Fields:
  - `schemaVersion`: `1` (number literal)
  - `token`: `string` (trimmed, length `1..1024`, MUST NOT include `\0`, `\n`, `\r`)
  - `updated_at`: `string` (ISO-8601 UTC ending in `Z`)
- Constraints:
  - The file MUST be written atomically (write temp + rename).
  - The file MUST be written with restrictive permissions (target `0600` where supported).
- Relationships:
  - References: implicitly tied to the current issue’s state directory; no foreign keys.
  - Deletion behavior:
    - On `DELETE /api/issue/sonar-token`, the file MUST be removed if present (idempotent).
    - If the issue state directory is deleted, the token is deleted with it.
  - Ordering dependencies:
    - On PUT, secret file write MUST succeed before attempting any worktree materialization (because worktree writes depend on the token).
- Migration notes:
  - Not breaking: existing issues will not have the file; treat as no token.
  - Migration script: not required.
  - Rollback: delete `.jeeves/.secrets/sonar-token.json` and ignore `.jeeves/issue.json.status.sonarToken.*` fields.
- Derivation:
  - `has_token` is derived from file existence (and successful JSON parse) at request time; it is not persisted elsewhere.

### Migrations
| Change | Existing Data | Migration | Rollback |
|--------|---------------|-----------|----------|
| Add non-secret reconcile metadata under `status.sonarToken.*` | Fields absent | Treat absent as defaults (`sync_status="never_attempted"`, timestamps/error `null`) until first write | Remove the fields |
| Add `.jeeves/.secrets/sonar-token.json` secret file | File absent | No-op until token is saved; on first PUT create file atomically with `0600` perms | Delete the file |

### Artifacts
| Artifact | Location | Created | Updated | Deleted |
|----------|----------|---------|---------|---------|
| Issue-scoped token secret | `.jeeves/.secrets/sonar-token.json` | On successful PUT (if absent) | On successful PUT (rewrite) | On successful DELETE (idempotent) |
| Non-secret sync metadata | `.jeeves/issue.json` (`status.sonarToken.*`) | On first PUT/DELETE/RECONCILE that records status | After each reconcile attempt | When issue state is deleted (never explicitly) |
| Worktree env file | `<worktreeRoot>/.env.jeeves` | When `has_token=true` and worktree present | Rewritten on PUT/RECONCILE when `has_token=true` | Removed when `has_token=false` and worktree present |
| Worktree env temp file | `<worktreeRoot>/.env.jeeves.tmp` | During atomic writes | Rewritten per attempt | Removed after rename; cleaned on startup/reconcile if leftover |
| Git ignore entries | `<worktreeRoot>/.git/info/exclude` | On first reconcile attempt with worktree present | Appended/deduped idempotently | Never (lines may remain even after token removal) |

### Artifact Lifecycle
| Scenario | Artifact Behavior |
|----------|-------------------|
| Success | Secret file reflects desired token state; `.env.jeeves` converges to desired (present/absent); `.git/info/exclude` includes `.env.jeeves` and `.env.jeeves.tmp`; `status.sonarToken.*` updated with `sync_status=in_sync` and timestamps. |
| Failure | If issue-scoped secret persistence fails, do not attempt worktree writes; return `500` and do not mutate worktree. If worktree writes fail after secret persistence, keep the secret file and record `sync_status=failed_*`, `last_error` (sanitized), and timestamps; return `200` with `warnings[]`. |
| Crash recovery | All file writes are atomic (temp + rename). On startup/reconcile, remove any leftover `<worktreeRoot>/.env.jeeves.tmp`, re-ensure `.git/info/exclude` lines (deduped), and retry reconcile to converge worktree state; `has_token` is derived from the secret file. |

## 5. Tasks
[To be completed in design_plan phase]

## 6. Validation
[To be completed in design_plan phase]
