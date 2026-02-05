# MCP Pruner (packages/mcp-pruner)

Stdio MCP server that exposes `read`, `bash`, and `grep` tools with optional context-focused pruning via an external swe-pruner HTTP endpoint.

## Environment Variables

### Runner-Side (set by the runner when spawning the MCP server)

| Variable | Required | Description |
|----------|----------|-------------|
| `JEEVES_PRUNER_ENABLED` | Yes | Must be exactly `"true"` to enable the MCP pruner server. |
| `JEEVES_PRUNER_URL` | No | Forwarded as `PRUNER_URL` to the server. Defaults to `http://localhost:8000/prune` when unset. Empty string disables pruning. |
| `JEEVES_MCP_PRUNER_PATH` | No | Explicit path to the mcp-pruner entrypoint JS file. Overrides automatic resolution via `require.resolve` or workspace fallback. |

### Server-Side (read by the MCP server at runtime)

| Variable | Default | Description |
|----------|---------|-------------|
| `PRUNER_URL` | `http://localhost:8000/prune` | Full URL of the swe-pruner HTTP endpoint. Empty string disables pruning. |
| `PRUNER_TIMEOUT_MS` | `30000` | Timeout in milliseconds for pruner HTTP calls (range: 100–300000). |
| `MCP_PRUNER_CWD` | `process.cwd()` | Working directory used to resolve relative `file_path` values in the `read` tool. |

## Tools

### read

Read file contents with optional context-focused pruning.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | Yes | Absolute or relative path to the file. Relative paths resolve against `MCP_PRUNER_CWD`. |
| `context_focus_question` | string | No | When provided and pruning is enabled, prunes output to focus on this question. |

### bash

Execute a shell command with optional context-focused pruning.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | Shell command to run. |
| `context_focus_question` | string | No | When provided and pruning is enabled, prunes output to focus on this question. |

### grep

Search files with grep and optional context-focused pruning.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | Yes | Pattern to search for (regex). |
| `path` | string | No | File/directory path to search (defaults to `.`). |
| `context_focus_question` | string | No | When provided and pruning is enabled, prunes output to focus on this question. |

## Example: tools/call with read and context_focus_question

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
