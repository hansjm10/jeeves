# Runner (packages/runner)

SDK integration layer for running agent phases. Bridges workflows/prompts to agent providers.

## Responsibilities

- Execute workflow phases via agent providers
- Stream provider events to output files
- Manage run artifacts (logs, SDK output, progress)
- Support multiple agent backends (Claude SDK, Codex SDK)

## Key Files

| File | Purpose |
|------|---------|
| `src/runner.ts` | Core run logic (`runPhaseOnce`, `runWorkflowOnce`, `runSinglePhaseOnce`) |
| `src/provider.ts` | `AgentProvider` interface definition |
| `src/providers/claudeAgentSdk.ts` | Claude Agent SDK provider |
| `src/providers/codexSdk.ts` | Codex/OpenAI SDK provider |
| `src/outputWriter.ts` | SDK output JSON writer |
| `src/progress.ts` | Progress file management |
| `src/cli.ts` | CLI interface |

## Provider Interface

```typescript
interface AgentProvider {
  readonly name: string;
  run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent>;
}

type ProviderEvent =
  | { type: 'system'; subtype?: 'init' | 'error'; content: string; sessionId?: string }
  | { type: 'user' | 'assistant' | 'result'; content: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown>; id: string }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean; durationMs?: number };
```

## Run Artifacts

Each run produces these files in the state directory:

| File | Purpose |
|------|---------|
| `last-run.log` | Human-readable log of events |
| `sdk-output.json` | Structured JSON of messages, tool calls, stats |
| Progress events (DB) | Handoff notes between iterations (rendered via `renderProgressText`) |

## Output Format (sdk-output.json)

```json
{
  "session_id": "...",
  "started_at": "ISO timestamp",
  "ended_at": "ISO timestamp",
  "messages": [...],
  "tool_calls": [...],
  "stats": { "input_tokens": N, "output_tokens": N },
  "success": true
}
```

## Iteration Pattern

The runner supports the "Ralph Wiggum" iteration pattern:
1. Each iteration is a fresh subprocess with new context
2. Handoff between iterations via DB-backed progress events
3. Agents read progress at start, write updates during run
4. Completion driven by workflow state transitions (orchestrator evaluates issue.json after each iteration)

## Development

```bash
# Run tests
pnpm test

# Type check
pnpm typecheck

# Lint
pnpm lint
```

## MCP Server Configuration

The runner can optionally spawn stdio MCP servers alongside agent providers. Configuration is driven by environment variables.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JEEVES_PRUNER_ENABLED` | Yes (to enable) | — | Must be exactly `"true"` to enable the MCP pruner server. When not set or any other value, the runner does not pass `mcpServers` to providers. |
| `JEEVES_PRUNER_URL` | No | `http://localhost:8000/prune` | Forwarded as `PRUNER_URL` to the MCP pruner server. Empty string disables pruning in the server. |
| `JEEVES_MCP_PRUNER_PATH` | No | Auto-resolved | Explicit path to the mcp-pruner entrypoint JS file. When unset, resolved via `require.resolve('@jeeves/mcp-pruner/dist/index.js')` or workspace fallback at `../../mcp-pruner/dist/index.js`. |

### Server-Side Environment Variables

These are set by the runner in the spawned MCP server process:

| Variable | Default | Description |
|----------|---------|-------------|
| `PRUNER_URL` | `http://localhost:8000/prune` | Full URL of the swe-pruner HTTP endpoint. Empty string disables pruning. |
| `PRUNER_TIMEOUT_MS` | `30000` | Timeout in milliseconds for pruner HTTP calls (range: 100–300000). |
| `MCP_PRUNER_CWD` | Run working directory | Working directory used to resolve relative file paths in the MCP pruner `read` tool. |

### MCP Pruner tools/call Example

When enabled, the MCP pruner server exposes `read`, `bash`, and `grep` tools. Example using `read` with `context_focus_question`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "read",
    "arguments": {
      "file_path": "src/index.ts",
      "context_focus_question": "What are the exported functions?"
    }
  }
}
```

Response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "...pruned or full file contents..."
      }
    ]
  }
}
```

## Conventions

- Providers are async iterables yielding `ProviderEvent`
- All file writes use atomic operations
- Log format: `[TYPE] content` (e.g., `[TOOL] Read {...}`)
- Progress markers: `[started]`, `[phase:name]`, `[ended:success|failure]`
