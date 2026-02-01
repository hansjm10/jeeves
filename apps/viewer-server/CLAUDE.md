# Viewer Server (apps/viewer-server)

Node.js backend for the Jeeves viewer. Built with Fastify and TypeScript.

## Responsibilities

- REST API for issue management and run control
- Real-time event streaming (SSE and WebSocket)
- Log file tailing and SDK output parsing
- Workflow and prompt file management
- GitHub issue creation integration

## Key Entrypoints

| File | Purpose |
|------|---------|
| `src/bin.ts` | CLI entry point, arg parsing |
| `src/server.ts` | Fastify server setup, route definitions |
| `src/runManager.ts` | Run lifecycle (start/stop/status) |
| `src/eventHub.ts` | Event broadcasting to SSE/WS clients |
| `src/tailers.ts` | Log and SDK output file tailing |
| `src/init.ts` | Issue initialization logic |

## API Endpoints

### State & Issues
- `GET /api/state` - Current state snapshot
- `GET /api/issues` - List all known issues
- `POST /api/issues/select` - Select active issue
- `POST /api/init/issue` - Initialize a new issue

### Run Control
- `GET /api/run` - Current run status
- `POST /api/run` - Start a run
- `POST /api/run/stop` - Stop current run

### Workflows & Prompts
- `GET /api/workflows` - List workflows
- `GET /api/workflows/:name` - Get workflow details
- `PUT /api/workflows/:name` - Update workflow
- `POST /api/workflows` - Create workflow
- `GET /api/prompts` - List prompts
- `GET /api/prompts/*` - Read prompt
- `PUT /api/prompts/*` - Update prompt

### Streaming
- `GET /api/stream` - SSE event stream
- `GET /api/ws` - WebSocket connection

### GitHub Integration
- `POST /api/github/issues/create` - Create GitHub issue

## Security Model

### Localhost-Only by Default

Mutating endpoints (run control, file writes) are restricted to localhost unless `--allow-remote-run` is passed or `JEEVES_VIEWER_ALLOW_REMOTE_RUN=1` is set.

### Origin Validation

- CORS is opt-in via `JEEVES_VIEWER_ALLOWED_ORIGINS`
- Same-origin requests don't require CORS headers
- Origin validation uses strict host/port matching

### Path Traversal Prevention

- Prompt IDs are validated and normalized
- Symlinks are rejected in write paths
- Workflow names are restricted to alphanumeric + underscore/hyphen

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `JEEVES_VIEWER_ALLOW_REMOTE_RUN` | `false` | Allow run control from non-localhost |
| `JEEVES_VIEWER_ALLOWED_ORIGINS` | (none) | Comma-separated allowed CORS origins |
| `JEEVES_VIEWER_POLL_MS` | `150` | Polling interval for file changes |
| `JEEVES_VIEWER_LOG_TAIL_LINES` | `500` | Lines to send on initial log load |
| `JEEVES_VIEWER_ISSUE` | (none) | Auto-select issue on startup |
| `JEEVES_DATA_DIR` | XDG default | Override data directory |

## Development

```bash
# Start server only (no UI)
pnpm dev:viewer-server

# Run tests
pnpm test

# Type check
pnpm typecheck
```

## Conventions

- All JSON responses include `ok: boolean`
- Error responses include `error: string`
- File operations use atomic writes (`textAtomic.ts`, `jsonAtomic.ts`)
- Event names follow kebab-case (`sdk-init`, `sdk-message`, `viewer-logs`)
