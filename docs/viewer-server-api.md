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
- `POST /api/issues/select`: select an existing issue state. Body: `{ "issue_ref": "owner/repo#N" }`.
- `POST /api/init/issue`: initialize issue state + worktree, then select it. Body: `{ "repo": "owner/repo", "issue": 123, "branch"?, "workflow"?, "phase"?, "design_doc"?, "force"? }`.
- `POST /api/run`: start a run (and optionally select an issue first). Body: `{ "issue_ref"?, "provider"?, "workflow"?, "max_iterations"?, "inactivity_timeout_sec"?, "iteration_timeout_sec"? }`.
- `POST /api/run/stop`: stop the current run. Body: `{ "force"?: boolean }`.
- `POST /api/issue/status`: update current issue phase. Body: `{ "phase": "design_draft" }`.
- `GET /api/workflow`: returns workflow metadata (phases, current phase, ordering).

Streaming endpoints:
- `GET /api/stream`: Server-Sent Events (SSE).
- `GET /api/ws`: WebSocket that streams the same events as SSE.

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
