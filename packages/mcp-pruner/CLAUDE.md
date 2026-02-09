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
| `MCP_PRUNER_BASH_PATH` | (unset) | Optional absolute path to a bash-compatible shell binary used by the `bash` tool. On Windows, set this to `bash.exe` when PATH discovery is insufficient. |
| `MCP_PRUNER_GREP_PATH` | (unset) | Optional absolute path to a `grep` executable used by the `grep` tool. On Windows, set this to `grep.exe` when PATH discovery is insufficient. |

## Windows Notes

- Native Windows is supported.
- For best parity with Unix command behavior, install Git for Windows so `bash`/`grep` are available.
- If binaries are not discoverable on PATH, set `MCP_PRUNER_BASH_PATH` and/or `MCP_PRUNER_GREP_PATH`.
- `grep` has a built-in Node fallback path when external `grep` is unavailable.

## Tools

### read

Read file contents with optional context-focused pruning.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | Yes | Absolute or relative path to the file. Relative paths resolve against `MCP_PRUNER_CWD`. |
| `start_line` | number | No | 1-based inclusive start line for focused reads (must be paired with `end_line`). |
| `end_line` | number | No | 1-based inclusive end line for focused reads (must be paired with `start_line`). |
| `around_line` | number | No | 1-based anchor line for around/radius reads (mutually exclusive with `start_line`/`end_line`). |
| `radius` | number | No | Context radius used with `around_line` (default `20`). |
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
| `pattern` | string | Cond. | Single pattern to search for (regex). Exactly one of `pattern` or `patterns` is required. |
| `patterns` | string[] | Cond. | Batch patterns searched in one call. Exactly one of `pattern` or `patterns` is required. |
| `path` | string | No | File/directory path to search (defaults to `.`). |
| `context_lines` | number | No | Context lines around matches (`0-50`, default `0`). |
| `max_matches` | number | No | Max output lines before truncation (`1-1000`, default `200`). |
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
