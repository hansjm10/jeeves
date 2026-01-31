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
- `POST /api/github/issues/create`: create a GitHub issue via `gh` (optional init/select/auto-run).
- `POST /api/issues/select`: select an existing issue state. Body: `{ "issue_ref": "owner/repo#N" }`.
- `POST /api/init/issue`: initialize issue state + worktree, then select it. Body: `{ "repo": "owner/repo", "issue": 123, "branch"?, "workflow"?, "phase"?, "design_doc"?, "force"? }`.
- `POST /api/run`: start a run (and optionally select an issue first). Body: `{ "issue_ref"?, "provider"?: "claude" | "codex" | "fake", "workflow"?, "max_iterations"?, "inactivity_timeout_sec"?, "iteration_timeout_sec"? }`.
- `POST /api/run/stop`: stop the current run. Body: `{ "force"?: boolean }`.
- `POST /api/issue/status`: update current issue phase. Body: `{ "phase": "design_draft" }`.
- `GET /api/workflow`: returns workflow metadata (phases, current phase, ordering).

Streaming endpoints:
- `GET /api/stream`: Server-Sent Events (SSE).
- `GET /api/ws`: WebSocket that streams the same events as SSE.

### `POST /api/github/issues/create`

Create a new GitHub issue in a repository using the local GitHub CLI (`gh`) on the viewer-server host.

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

  "init": {                 // optional; when omitted this endpoint is create-only
    "branch": "issue/123",
    "workflow": "default",
    "phase": "design_draft",
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
- `sdk-tool-complete`: `{ tool_use_id: string, name?: unknown, duration_ms: number, is_error: boolean }`
- `sdk-complete`: `{ status: "success" | "error", summary: unknown }`

Diagnostics:
- `viewer-error`: `{ source: "poller", message: string, stack?: string }`
