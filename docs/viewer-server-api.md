# Viewer Server API (TypeScript)

The TypeScript viewer server (`@jeeves/viewer-server`) provides run control and real-time streaming of state/logs/SDK events.

## Start

From the repo root:

```bash
pnpm exec jeeves-viewer-server --host 127.0.0.1 --port 8080
```

CLI flags:
- `--host` (default: `127.0.0.1`)
- `--port` (default: `8080`)
- `--issue owner/repo#N` (optional)
- `--allow-remote-run` (optional; allows mutating endpoints from non-local IPs)

Environment variables:
- `JEEVES_VIEWER_ALLOW_REMOTE_RUN=1`: same effect as `--allow-remote-run`
- `JEEVES_VIEWER_ALLOWED_ORIGINS`: comma-separated browser Origin allowlist (exact origins), e.g. `http://127.0.0.1:5173`
- `JEEVES_VIEWER_POLL_MS`: polling interval for tailing logs/SDK output (default: `150`)
- `JEEVES_VIEWER_LOG_TAIL_LINES`: initial snapshot lines for `last-run.log` (default: `500`)
- `JEEVES_VIEWER_VIEWER_LOG_TAIL_LINES`: initial snapshot lines for `viewer-run.log` (default: `500`)

## Security model (local-only by default)

- **Mutating endpoints** (POST routes) are blocked from non-local IPs unless `--allow-remote-run` / `JEEVES_VIEWER_ALLOW_REMOTE_RUN=1` is set.
- **Host binding note**: allowing remote clients typically requires binding to a non-loopback host (for example `--host 0.0.0.0`) in addition to enabling `--allow-remote-run`.
- **Reverse proxy note**: mutating-endpoint gating uses the TCP peer address (`req.socket.remoteAddress`) and does **not** consult `X-Forwarded-For`. If you put this behind a proxy, your effective trust boundary may change; prefer binding to `127.0.0.1` unless you add an explicit auth boundary in front.
- **Browser-origin policy**: if an `Origin` header is present, requests are allowed only when the Origin is:
  - same-host+port as the request `Host` header (http/https schemes), or
  - explicitly listed in `JEEVES_VIEWER_ALLOWED_ORIGINS`.
- This Origin policy applies to JSON endpoints, `GET /api/stream` (SSE), and `GET /api/ws` (WebSocket).

## HTTP API

JSON endpoints:
- `GET /api/state`: returns current issue selection, paths, issue.json (if present), and run status.
- `GET /api/run`: returns run status.
- `GET /api/issues`: returns all known issue states under the data directory.
- `GET /api/prompts`: returns prompt template IDs under the prompts directory.
- `GET /api/prompts/<id>`: returns prompt contents (supports nested paths like `fixtures/trivial.md`).
- `PUT /api/prompts/<id>`: writes prompt contents. Body: `{ "content": "..." }`.
- `POST /api/github/issues/create`: create a GitHub issue via `gh` (legacy; delegates internally to provider-aware flow).
- `POST /api/issues/create`: provider-aware issue/work-item create (GitHub or Azure DevOps).
- `POST /api/issues/init-from-existing`: provider-aware init from existing issue/work-item.
- `POST /api/issues/select`: select an existing issue state. Body: `{ "issue_ref": "owner/repo#N" }`.
- `POST /api/init/issue`: initialize issue state + worktree, then select it. Body: `{ "repo": "owner/repo", "issue": 123, "branch"?, "workflow"?, "phase"?, "design_doc"?, "force"? }`.
- `POST /api/run`: start a run (and optionally select an issue first). Body: `{ "issue_ref"?, "provider"?: "claude" | "codex" | "fake", "workflow"?, "max_iterations"?, "inactivity_timeout_sec"?, "iteration_timeout_sec"? }`. See [`POST /api/run`](#post-apirun) below.
- `POST /api/run/stop`: stop the current run. Body: `{ "force"?: boolean }`.
- `POST /api/issue/status`: update current issue phase. Body: `{ "phase": "design_research" }`.
- `GET /api/issue/task-execution`: get current issue task execution settings (parallel/sequential).
- `POST /api/issue/task-execution`: update current issue task execution settings. Body: `{ "mode": "sequential" | "parallel", "maxParallelTasks"?: number }`.
- `GET /api/workflow`: returns workflow metadata (phases, current phase, ordering).
- `GET /api/issue/azure-devops`: Azure DevOps credential and sync status.
- `PUT /api/issue/azure-devops`: full Azure DevOps credential upsert.
- `PATCH /api/issue/azure-devops`: partial Azure DevOps credential update.
- `DELETE /api/issue/azure-devops`: remove Azure DevOps credentials.
- `POST /api/issue/azure-devops/reconcile`: force Azure DevOps worktree reconciliation.
- `GET /api/project-files`: repo-scoped project files status + managed file list for selected issue.
- `PUT /api/project-files`: add/update one managed project file mapping + content.
- `DELETE /api/project-files/:id`: remove one managed project file mapping.
- `POST /api/project-files/reconcile`: force project files worktree reconciliation.

Streaming endpoints:
- `GET /api/stream`: Server-Sent Events (SSE).
- `GET /api/ws`: WebSocket that streams the same events as SSE.

### `POST /api/github/issues/create` (Legacy)

Create a new GitHub issue in a repository using the local GitHub CLI (`gh`) on the viewer-server host.

> **Legacy compatibility note:** This endpoint preserves its original response envelope for backward compatibility. Internally, it now persists provider metadata (`issue.source`, `status.issueIngest`) and emits an `issue-ingest-status` event, the same as the provider-aware `POST /api/issues/create` endpoint. New integrations should use `POST /api/issues/create` with `provider: "github"` instead.

Prerequisites:
- `gh` must be installed on the viewer-server host.
- `gh` must be authenticated on the viewer-server host: run `gh auth login`.

GitHub host support:
- GitHub.com only (`owner/repo` repos on github.com). GitHub Enterprise hosts are not supported.

Request body:
```jsonc
{
  "repo": "owner/repo",     // required
  "title": "Issue title",   // required
  "body": "Issue body",     // required

  "labels": ["bug"],        // optional; array of strings
  "assignees": ["octocat"], // optional; array of strings
  "milestone": "v1.0",      // optional; string

  "init": {                 // optional; when omitted this endpoint is create-only
    "branch": "issue/123",
    "workflow": "default",
    "phase": "design_classify",
    "design_doc": "docs/issue-123-design.md",
    "force": false
  },
  "auto_select": true,      // optional; default true when init is provided
  "auto_run": {             // optional; requires init and auto_select !== false
    "provider": "codex",
    "workflow": "default",
    "max_iterations": 10,
    "inactivity_timeout_sec": 600,
    "iteration_timeout_sec": 3600
  }
}
```

Optional create fields:
- `labels`: array of strings
- `assignees`: array of strings
- `milestone`: string

Success response (always includes run status):
```jsonc
{
  "ok": true,
  "created": true,
  "issue_url": "https://github.com/owner/repo/issues/123",
  "issue_ref": "owner/repo#123", // present when parseable
  "init": {                                             // present only when init is requested
    "ok": true,
    "result": {
      "issue_ref": "owner/repo#123",
      "state_dir": "...",
      "work_dir": "...",
      "repo_dir": "...",
      "branch": "issue/123"
    }
  },
  "auto_run": { "ok": true, "run_started": true },       // present only when auto_run is requested
  "run": { /* RunManager.getStatus() */ }
}
```

Error responses:
```jsonc
{
  "ok": false,
  "error": "Human-readable error message.",
  "run": { /* RunManager.getStatus() */ }
}
```

Common `gh` error status mapping:
- Missing `gh` / not in PATH: `500`
- Not authenticated (`gh auth login` required): `401`
- Repo not found or access denied: `403`
- Other `gh` failures: `500`

GitHub host limitation (v1):
- If issue creation succeeds but `gh` returns an `issue_url` that is not a `github.com/.../issues/<n>` URL, the endpoint returns `200` with `ok: true` and `init: { ok: false, error: "Only github.com issue URLs are supported in v1." }` (when init was requested).

### `POST /api/run`

Start a new run. Optionally select an issue first.

Request body:
```jsonc
{
  "issue_ref": "owner/repo#123",  // optional; select issue before starting
  "provider": "claude",           // optional; "claude" | "codex" | "fake"
  "workflow": "default",          // optional; workflow name
  "max_iterations": 10,           // optional; default 10
  "max_parallel_tasks": 4,        // optional; integer 1..8 (only used when issue task execution mode is "parallel")
  "inactivity_timeout_sec": 600,  // optional
  "iteration_timeout_sec": 3600   // optional
}
```

**`max_iterations` behavior:**
- **Default**: 10 iterations when omitted or not a finite number
- **Minimum**: Values ≤ 0 are clamped to 1
- **Float handling**: Truncated to integer (e.g., `2.5` → 2 effective iterations)

For UI and CLI usage examples, see [README.md](README.md#overriding-max-iterations).

Success response:
```jsonc
{
  "ok": true,
  "run": { /* RunStatus */ }
}
```

Error response:
```jsonc
{
  "ok": false,
  "error": "Human-readable error message.",
  "run": { /* RunStatus */ }
}
```

### `GET /api/issue/azure-devops`

Get the Azure DevOps credential and sync status for the currently selected issue.

**Security**: ALL Azure DevOps credential endpoints (including GET) require localhost access. Remote clients receive `403` with `code: "forbidden"`.

Prerequisites:
- An issue must be selected.

Success response (`200`):
```jsonc
{
  "ok": true,
  "issue_ref": "owner/repo#123",
  "worktree_present": true,
  "configured": true,
  "organization": "https://dev.azure.com/myorg",
  "project": "MyProject",
  "has_pat": true,
  "pat_last_updated_at": "2026-02-06T12:00:00.000Z",
  "pat_env_var_name": "AZURE_DEVOPS_EXT_PAT",
  "sync_status": "in_sync",
  "last_attempt_at": "2026-02-06T12:00:00.000Z",
  "last_success_at": "2026-02-06T12:00:00.000Z",
  "last_error": null
}
```

**`sync_status` values:**
| Value | Meaning |
|-------|---------|
| `in_sync` | Worktree `.env.jeeves` and `.git/info/exclude` are up to date |
| `deferred_worktree_absent` | No worktree exists yet; reconcile will run when one is created |
| `failed_exclude` | Failed to update `.git/info/exclude` |
| `failed_env_write` | Failed to write PAT to `.env.jeeves` |
| `failed_env_delete` | Failed to remove PAT from `.env.jeeves` |
| `failed_secret_read` | Failed to read the secret file |
| `never_attempted` | No reconcile has been attempted |

Error responses:

| Status | Code | Cause |
|--------|------|-------|
| `400` | `no_issue_selected` | No issue is currently selected |
| `403` | `forbidden` | Request from non-localhost |
| `500` | `io_error` | File system error reading secret or status |

### `PUT /api/issue/azure-devops`

Create or fully replace Azure DevOps credentials for the current issue.

Prerequisites:
- An issue must be selected.
- Jeeves must not be running (returns `409`).

Request body:
```jsonc
{
  "organization": "https://dev.azure.com/myorg",  // required; 3-200 chars
  "project": "MyProject",                         // required; 1-128 chars
  "pat": "azure-pat-value",                        // required; 1-1024 chars
  "sync_now": true                                 // optional; default true
}
```

**Organization format**: Must be a valid Azure DevOps organization slug (letters, digits, `.`, `_`, `-`). Bare slugs are auto-prefixed to `https://dev.azure.com/<slug>`.

Success response (`200`):
```jsonc
{
  "ok": true,
  "updated": true,
  "status": { /* AzureDevopsStatus (see GET response) */ },
  "warnings": []
}
```

Error responses:

| Status | Code | Cause |
|--------|------|-------|
| `400` | `validation_failed` | Invalid fields; includes `field_errors` |
| `403` | `forbidden` | Request from non-localhost |
| `409` | `conflict_running` | Jeeves is currently running |
| `500` | `io_error` | File system error |
| `503` | `busy` | Another credential mutation is in progress |

Validation error example (`400`):
```jsonc
{
  "ok": false,
  "error": "Validation failed",
  "code": "validation_failed",
  "field_errors": {
    "organization": "organization must be between 3 and 200 characters",
    "pat": "pat is required"
  }
}
```

### `PATCH /api/issue/azure-devops`

Partially update Azure DevOps credentials. At least one field must be provided.

Request body:
```jsonc
{
  "organization": "https://dev.azure.com/neworg",  // optional
  "project": "NewProject",                         // optional
  "pat": "new-pat-value",                           // optional; conflicts with clear_pat
  "clear_pat": true,                                // optional; deletes secret; conflicts with pat
  "sync_now": false                                 // optional; default false
}
```

**Conflict rule**: Cannot provide both `pat` and `clear_pat: true` in the same request.

Success response: Same shape as PUT (`200` with `updated`, `status`, `warnings`).

Error responses: Same as PUT, plus:

| Status | Code | Cause |
|--------|------|-------|
| `400` | `validation_failed` | No fields provided, or `pat`+`clear_pat` conflict |

### `DELETE /api/issue/azure-devops`

Remove Azure DevOps credentials for the current issue. Idempotent.

Prerequisites:
- An issue must be selected.
- Jeeves must not be running.

Request body: empty or `{}`.

Success response (`200`):
```jsonc
{
  "ok": true,
  "status": { /* AzureDevopsStatus with configured=false, has_pat=false */ },
  "warnings": []
}
```

Error responses:

| Status | Code | Cause |
|--------|------|-------|
| `400` | `no_issue_selected` | No issue is currently selected |
| `403` | `forbidden` | Request from non-localhost |
| `409` | `conflict_running` | Jeeves is currently running |
| `500` | `io_error` | File system error |
| `503` | `busy` | Another credential mutation is in progress |

### `POST /api/issue/azure-devops/reconcile`

Force reconciliation of Azure DevOps credentials into the worktree (`.env.jeeves` and `.git/info/exclude`).

Prerequisites:
- An issue must be selected.

Request body: empty or `{}`.

Success response (`200`):
```jsonc
{
  "ok": true,
  "status": { /* AzureDevopsStatus with updated sync_status */ },
  "warnings": []
}
```

Error responses:

| Status | Code | Cause |
|--------|------|-------|
| `400` | `no_issue_selected` | No issue is currently selected |
| `403` | `forbidden` | Request from non-localhost |
| `500` | `io_error` | File system error |
| `503` | `busy` | Another credential mutation is in progress |

### `GET /api/project-files`

Get repo-scoped managed project files status for the currently selected issue.

**Security**: localhost-only (same as other credential/project file endpoints).

Prerequisites:
- An issue must be selected.

Success response (`200`):
```jsonc
{
  "ok": true,
  "issue_ref": "owner/repo#123",
  "worktree_present": true,
  "file_count": 2,
  "files": [
    {
      "id": "a1b2c3...",
      "display_name": "connections.local.config",
      "target_path": "connections.local.config",
      "size_bytes": 231,
      "sha256": "3c9f...",
      "updated_at": "2026-02-07T12:00:00.000Z"
    }
  ],
  "sync_status": "in_sync",
  "last_attempt_at": "2026-02-07T12:00:00.000Z",
  "last_success_at": "2026-02-07T12:00:00.000Z",
  "last_error": null
}
```

`sync_status` values:
- `in_sync`
- `deferred_worktree_absent`
- `failed_conflict`
- `failed_link_create`
- `failed_source_missing`
- `failed_exclude`
- `never_attempted`

### `PUT /api/project-files`

Add or update one managed project file mapping for the selected repo.

Request body:
```jsonc
{
  "id": "optional-existing-id",          // optional; update existing file by id
  "display_name": "connections.local.config", // optional
  "target_path": "connections.local.config",  // required; worktree-relative
  "content_base64": "BASE64...",         // required; max 1 MiB decoded
  "sync_now": true                       // optional; default true
}
```

Response (`200`): `{ ok: true, updated: true, status, warnings, file }`.

### `DELETE /api/project-files/:id`

Remove one managed project file mapping by id and reconcile the current worktree.

Response (`200`): `{ ok: true, updated: boolean, status, warnings }`.

### `POST /api/project-files/reconcile`

Force reconcile managed project files into the current worktree.

Request body: optional `{ "force": true }`.

Response (`200`): `{ ok: true, updated: false, status, warnings }`.

### `POST /api/issues/create`

Create a new issue (GitHub) or work item (Azure DevOps) using the appropriate provider CLI, with optional init/select/auto-run.

**Security**: Localhost-only. Returns `403` with `code: "forbidden"` for non-local requests.

Prerequisites:
- **GitHub**: `gh` CLI installed and authenticated.
- **Azure DevOps**: `az` CLI installed and authenticated. Azure credentials (organization, project, PAT) should be configured via the Azure DevOps credential endpoints.

Request body:
```jsonc
{
  "provider": "github",              // required; "github" or "azure_devops"
  "repo": "owner/repo",              // required; 3-200 chars
  "title": "Issue title",            // required; 1-256 chars
  "body": "Issue description",       // required; 1-20000 chars

  "labels": ["bug"],                 // optional; max 20 items, each max 64 chars
  "assignees": ["octocat"],          // optional; max 20 items, each max 64 chars
  "milestone": "v1.0",               // optional; max 128 chars

  "azure": {                         // optional; Azure-specific fields (required for azure_devops)
    "organization": "https://dev.azure.com/myorg",  // optional; overrides configured value
    "project": "MyProject",                          // optional; overrides configured value
    "work_item_type": "User Story",                  // required for azure_devops; "User Story" | "Bug" | "Task"
    "parent_id": 100,                                // optional; positive integer
    "area_path": "MyProject\\Area",                  // optional; max 256 chars
    "iteration_path": "MyProject\\Sprint 1",         // optional; max 256 chars
    "tags": ["frontend", "priority"]                 // optional; max 50 items, each max 64 chars
  },

  "init": {                          // optional; init issue state + worktree after create
    "branch": "issue/123",
    "workflow": "default",
    "phase": "design_classify",
    "design_doc": "docs/issue-123-design.md",
    "force": false
  },
  "auto_select": true,               // optional; default true when init is provided
  "auto_run": {                      // optional; requires init + auto_select
    "provider": "claude",
    "workflow": "default",
    "max_iterations": 10,
    "inactivity_timeout_sec": 600,
    "iteration_timeout_sec": 3600
  }
}
```

Success response (`200`):
```jsonc
{
  "ok": true,
  "provider": "github",
  "mode": "create",
  "outcome": "success",                // "success" or "partial"
  "remote": {
    "id": "123",
    "url": "https://github.com/owner/repo/issues/123",
    "title": "Issue title",
    "kind": "issue"                     // "issue" (GitHub) or "work_item" (Azure)
  },
  "hierarchy": {                        // present when Azure hierarchy is fetched
    "parent": { "id": "100", "title": "Parent Epic", "url": "https://..." },
    "children": []
  },
  "init": { "ok": true, "issue_ref": "owner/repo#123", "branch": "issue/123" },
  "auto_select": { "requested": true, "ok": true },
  "auto_run": { "requested": true, "ok": true },
  "warnings": [],
  "run": { /* RunStatus */ }
}
```

**Outcome semantics:**
- `success`: All requested operations completed.
- `partial`: Remote item was created but a downstream step (init, auto_select, auto_run) failed. The `warnings` array describes what failed. Remote references are preserved in the response.

Error responses:

| Status | Code | Cause |
|--------|------|-------|
| `400` | `unsupported_provider` | Invalid provider value |
| `400` | `validation_failed` | Invalid fields; includes `field_errors` |
| `403` | `forbidden` | Request from non-localhost |
| `401` | `provider_auth_required` | CLI not authenticated |
| `403` | `provider_permission_denied` | Insufficient permissions |
| `404` | `remote_not_found` | Repository or project not found |
| `422` | `remote_validation_failed` | Remote rejected the request |
| `500` | `io_error` | File system or internal error |
| `500` | `missing_cli` | Required CLI (`gh` or `az`) not installed |
| `504` | `provider_timeout` | CLI command timed out |

**Side effects:**
- Persists `issue.source` and `status.issueIngest` in issue.json
- Emits `issue-ingest-status` streaming event

### `POST /api/issues/init-from-existing`

Initialize a Jeeves issue from an existing GitHub issue or Azure DevOps work item.

**Security**: Localhost-only.

Request body:
```jsonc
{
  "provider": "azure_devops",         // required; "github" or "azure_devops"
  "repo": "owner/repo",               // required; 3-200 chars

  "existing": {                        // required; exactly one of id or url
    "id": 456,                         // number or string; the issue/work-item ID
    "url": "https://..."               // alternative; absolute https:// URL
  },

  "azure": {                           // optional; Azure-specific overrides
    "organization": "https://dev.azure.com/myorg",
    "project": "MyProject"
  },

  "init": {                            // optional; same as POST /api/issues/create
    "branch": "issue/456",
    "workflow": "default",
    "phase": "design_classify",
    "design_doc": "docs/issue-456-design.md",
    "force": false
  },
  "auto_select": true,
  "auto_run": {
    "provider": "claude",
    "max_iterations": 10
  }
}
```

**`existing` field**: Exactly one of `id` or `url` must be provided. Providing both or neither returns `400`.

Success response: Same shape as `POST /api/issues/create` with `mode: "init_existing"`.

Error responses: Same as `POST /api/issues/create`.

**Side effects**: Same as `POST /api/issues/create`.

## Streaming formats

SSE (`/api/stream`):
- HTTP `Content-Type: text/event-stream`
- Messages:
  - `event: <eventName>`
  - `data: <json>`

WebSocket (`/api/ws`):
- Each message is a JSON string:
  - `{ "event": "<eventName>", "data": <json> }`

## Event names and payloads

Core:
- `state`: snapshot of current selection + run status (same structure as `GET /api/state`).
- `logs`: `{ lines: string[], reset?: boolean }`
- `viewer-logs`: `{ lines: string[], reset?: boolean }`

SDK stream (from `sdk-output.json` snapshots):
- `sdk-init`: `{ session_id: string, started_at?: unknown, status: "running" | "complete" }`
- `sdk-message`: `{ message: unknown, index: number, total: number }` (initial snapshot) or `{ message: unknown, index: number, total: number }` (incremental)
- `sdk-tool-start`: `{ tool_use_id: string, name?: unknown, input: unknown }`
- `sdk-tool-complete`: `{ tool_use_id: string, name?: unknown, duration_ms: number, is_error: boolean, response_text?: string, response_truncated?: boolean }`
- `sdk-complete`: `{ status: "success" | "error", summary: unknown }`

Provider status:
- `azure-devops-status`: Emitted after any Azure DevOps credential mutation (PUT, PATCH, DELETE) or reconciliation. Payload:
  ```jsonc
  {
    "issue_ref": "owner/repo#123",
    "worktree_present": true,
    "configured": true,
    "organization": "https://dev.azure.com/myorg",
    "project": "MyProject",
    "has_pat": true,
    "pat_last_updated_at": "2026-02-06T12:00:00.000Z",
    "pat_env_var_name": "AZURE_DEVOPS_EXT_PAT",
    "sync_status": "in_sync",
    "last_attempt_at": "2026-02-06T12:00:00.000Z",
    "last_success_at": "2026-02-06T12:00:00.000Z",
    "last_error": null,
    "operation": "put"               // "put" | "patch" | "delete" | "reconcile" | "auto_reconcile"
  }
  ```
- `issue-ingest-status`: Emitted after a provider-aware issue create or init-from-existing operation. Payload:
  ```jsonc
  {
    "issue_ref": "owner/repo#123",   // null if issue not yet selected
    "provider": "github",            // "github" or "azure_devops"
    "mode": "create",                // "create" or "init_existing"
    "outcome": "success",            // "success" | "partial" | "error"
    "remote_id": "123",              // string or omitted
    "remote_url": "https://...",     // string or omitted
    "warnings": [],
    "auto_select": { "requested": true, "ok": true },
    "auto_run": { "requested": false, "ok": false },
    "error": { "code": "...", "message": "..." },  // present only when outcome is "error"
    "occurred_at": "2026-02-06T12:00:00.000Z"
  }
  ```
- `sonar-token-status`: Emitted after sonar token mutations or reconciliation. Same pattern as `azure-devops-status`.

Diagnostics:
- `viewer-error`: `{ source: "poller", message: string, stack?: string }`

### `POST /api/github/issues/expand`

Generate an expanded issue title and body from a short summary using AI. This endpoint calls the `jeeves-runner expand-issue` subcommand internally.

**Security**: This endpoint is gated by localhost-only access by default. Remote clients receive `403` unless `--allow-remote-run` is enabled.

Request body:
```jsonc
{
  "summary": "Add dark mode toggle to settings",  // required; 5-2000 characters
  "issue_type": "feature",                        // optional; "feature" | "bug" | "refactor"
  "provider": "claude",                           // optional; overrides workflow default
  "model": "claude-3-opus"                        // optional; overrides workflow default
}
```

**Field details:**
- `summary` (required): A short description of the issue (5-2000 characters).
- `issue_type` (optional): One of `feature`, `bug`, or `refactor`. Affects the generated content structure.
- `provider` (optional): AI provider to use. If omitted, uses the `default_provider` from the `default` workflow configuration.
- `model` (optional): Model to use. If omitted, uses the `default_model` from the `default` workflow configuration (if set).

Success response:
```jsonc
{
  "ok": true,
  "title": "Add dark mode toggle to application settings",
  "body": "## Summary\n...",
  "provider": "claude",
  "model": "claude-3-opus"  // omitted when unset
}
```

**Note:** The `model` field is omitted from the response when no model is configured (either via request override or workflow default).

Error responses:

Validation errors (`400`):
```jsonc
{
  "ok": false,
  "error": "summary is required"
}
```
```jsonc
{
  "ok": false,
  "error": "summary must be at least 5 characters"
}
```
```jsonc
{
  "ok": false,
  "error": "summary must be at most 2000 characters"
}
```
```jsonc
{
  "ok": false,
  "error": "issue_type must be one of: feature, bug, refactor"
}
```

Gating error (`403`):
```jsonc
{
  "ok": false,
  "error": "This endpoint is only allowed from localhost. Restart with --allow-remote-run to enable it."
}
```

Execution error (`500`):
```jsonc
{
  "ok": false,
  "error": "Failed to parse runner output"
}
```

Timeout error (`504`):
```jsonc
{
  "ok": false,
  "error": "Request timed out"
}
```

**Error status summary:**
| Status | Cause |
|--------|-------|
| `400` | Invalid or missing `summary`, invalid `issue_type` |
| `403` | Request from non-localhost without `--allow-remote-run` |
| `500` | Runner subprocess failed or returned invalid output |
| `504` | Runner subprocess exceeded 60-second timeout |
