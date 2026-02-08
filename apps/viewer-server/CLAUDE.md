# Viewer Server (apps/viewer-server)

Node.js backend for the Jeeves viewer. Built with Fastify and TypeScript.

## Responsibilities

- REST API for issue management and run control
- Real-time event streaming (SSE and WebSocket)
- Log file tailing and SDK output parsing
- Workflow and prompt file management
- GitHub issue creation integration
- Provider-aware issue ingest (GitHub + Azure DevOps)
- Azure DevOps credential lifecycle management

## Key Entrypoints

| File | Purpose |
|------|---------|
| `src/bin.ts` | CLI entry point, arg parsing |
| `src/server.ts` | Fastify server setup, route definitions |
| `src/runManager.ts` | Run lifecycle (start/stop/status) |
| `src/eventHub.ts` | Event broadcasting to SSE/WS clients |
| `src/tailers.ts` | Log and SDK output file tailing |
| `src/init.ts` | Issue initialization logic |
| `src/azureDevopsTypes.ts` | Azure/provider type definitions, request validation, status types |
| `src/azureDevopsSecret.ts` | Issue-scoped Azure secret persistence (atomic temp+rename writes) |
| `src/azureDevopsReconcile.ts` | Worktree `.env.jeeves` and `.git/info/exclude` reconciliation |
| `src/providerOperationJournal.ts` | Crash-safe operation lock/journal for provider mutations |
| `src/providerIssueAdapter.ts` | GitHub/Azure CLI adapters for issue/work-item create+lookup |
| `src/providerPrAdapter.ts` | GitHub/Azure CLI adapters for PR list+create |
| `src/providerIssueState.ts` | Provider metadata read/write helpers for issue.json |

## API Documentation

For comprehensive API documentation including request/response schemas, streaming formats, and security model details, see:
- **[`docs/viewer-server-api.md`](../../docs/viewer-server-api.md)** - Full HTTP and streaming API reference

The route definitions are implemented in `src/server.ts`.

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

### GitHub Integration (Legacy)
- `POST /api/github/issues/create` - Create GitHub issue (delegates to provider-aware flow internally)

### Azure DevOps Credentials
- `GET /api/issue/azure-devops` - Credential and sync status
- `PUT /api/issue/azure-devops` - Full credential upsert (organization, project, PAT)
- `PATCH /api/issue/azure-devops` - Partial credential update
- `DELETE /api/issue/azure-devops` - Remove credentials
- `POST /api/issue/azure-devops/reconcile` - Force worktree reconciliation

### Provider-Aware Ingest
- `POST /api/issues/create` - Create issue/work-item (GitHub or Azure DevOps)
- `POST /api/issues/init-from-existing` - Init from existing issue/work-item

### Streaming Events
- `azure-devops-status` - Azure credential/sync status changes (emitted after mutate/reconcile)
- `issue-ingest-status` - Issue ingest lifecycle events (emitted after create/init-from-existing)
- `sonar-token-status` - Sonar token sync status changes

## Security Model

### Localhost-Only by Default

Mutating endpoints (run control, file writes) are restricted to localhost unless `--allow-remote-run` is passed or `JEEVES_VIEWER_ALLOW_REMOTE_RUN=1` is set.

**Note:** ALL Azure DevOps credential endpoints (including GET) require localhost access because credential status is considered sensitive.

### Origin Validation

- CORS is opt-in via `JEEVES_VIEWER_ALLOWED_ORIGINS`
- Same-origin requests don't require CORS headers
- Origin validation uses strict host/port matching

### Path Traversal Prevention

- Prompt IDs are validated and normalized
- Symlinks are rejected in write paths
- Workflow names are restricted to alphanumeric + underscore/hyphen

### PAT Safety

- PAT values are never included in API responses, streaming events, or server logs
- Secret files are stored with `0600` permissions in `.jeeves/.secrets/`
- Error messages from provider operations are sanitized before returning to clients

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
- Error responses include `error: string` and `code: string`
- File operations use atomic writes (`textAtomic.ts`, `jsonAtomic.ts`)
- Event names follow kebab-case (`sdk-init`, `sdk-message`, `viewer-logs`, `azure-devops-status`, `issue-ingest-status`)
- Azure credential endpoints follow the sonar token pattern: per-issue mutex, `buildStatus` helper, `updateStatusInIssueJson` helper, `emitStatus` helper, auto-reconcile on startup/select/init
- Azure reconcile uses line-level env var management (`upsertEnvVar`/`removeEnvVar`) because `.env.jeeves` is shared with sonar token
- Provider CLI adapters accept a `spawnImpl` parameter for testability (same pattern as `issueExpand.ts`)
- `ProviderAdapterError` carries `status` (HTTP code) and `code` (error code string) for all provider adapter failures
