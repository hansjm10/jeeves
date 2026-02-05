# Design: Context-Pruning MCP Server Integration

**Issue**: #98
**Status**: Draft - Classification Complete
**Feature Types**: Primary: API, Secondary: Workflow, Infrastructure

---

## 1. Scope

### Problem
Jeeves agents currently have to ingest full file reads and command outputs, which wastes tokens and cost when only a small subset of that context is relevant to the task.

### Goals
- [ ] Provide a standalone MCP server (`@jeeves/mcp-pruner`) exposing familiar tools (at minimum: `read`, `bash`, `grep`) that optionally accept a `context_focus_question` to request pruned output.
- [ ] When `context_focus_question` is provided, prune tool output via a configurable `swe-pruner` HTTP endpoint, with safe fallback to unpruned output on errors/timeouts.
- [ ] Integrate the MCP server into the Jeeves runtime so spawned agents (Claude Agent SDK and Codex) can use these MCP tools during runs, with an explicit enable/disable switch.

### Non-Goals
- Automatically pruning all tool output by default (pruning remains opt-in per tool call).
- Implementing or deploying `swe-pruner` itself, or guaranteeing a pruner service is always available.
- Adding new UI controls in the viewer to manage pruning settings (can be added later if needed).
- Expanding beyond the core file/shell tool set into a general-purpose MCP tool suite.

### Boundaries
- **In scope**: New `packages/mcp-pruner` package, MCP tool schemas/contracts for `read`/`bash`/`grep` with optional pruning, runner/provider wiring so both Claude and Codex runs can access the MCP server, and basic developer documentation/config via environment variables.
- **Out of scope**: Swe-pruner service lifecycle management, persistent per-issue pruning settings, viewer UI/UX work, and broader security hardening beyond existing “trusted local automation” assumptions.
- **Transport choice (issue-prescribed)**: Implement the MCP server using `@modelcontextprotocol/sdk` with `StdioServerTransport` (stdio). Providers spawn the MCP server via `{ command, args, env }` config.
- **Configuration names (final)**:
  - Runner env: `JEEVES_PRUNER_ENABLED`, `JEEVES_PRUNER_URL`, `JEEVES_MCP_PRUNER_PATH`.
  - Server env: `PRUNER_URL`, `PRUNER_TIMEOUT_MS`, `MCP_PRUNER_CWD`.
  - CLI entry: `mcp-pruner` (provided by `@jeeves/mcp-pruner`).

---

## 2. Workflow

This feature adds a new MCP server (`@jeeves/mcp-pruner`) and an opt-in “prune this tool output” path. There are two cooperating state machines:

1. **Runner lifecycle** (per Jeeves run): builds MCP server config (`mcpServers`) and passes it into the agent provider, which spawns the server via stdio.
2. **Tool-request pipeline** (per MCP request): executes `read`/`bash`/`grep`, optionally calls the HTTP pruner, and returns a response with safe fallback to unpruned output.

### Gate Answers (Explicit)
- **All states/phases**: The full state set is the union of `run:*` and `req:*` rows in the **States** table below (exhaustive).
- **Initial state**:
  - Runner: `run:init` entered when a provider phase begins.
  - Request: `req:received` entered when an MCP request is accepted by the server.
- **Terminal states**:
  - Runner: `run:shutdown` (end-of-phase cleanup; no further transitions).
  - Request: `req:invalid_request`, `req:tool_error`, `req:responded`, `req:internal_error` (request is complete; caller must retry with a new request if desired).
- **Next states for each non-terminal**: Enumerated exhaustively by the **Transitions** table (each non-terminal state only transitions to the listed `To` states).
- **Transition triggers & side effects**: Each transition’s condition and side effects are fully specified in the **Transitions** table (process management, logging events, response metadata).
- **Reversibility**: Transitions are **not reversible** within a run/request. “Undo” happens only by starting a new run (runner lifecycle) or issuing a new request (tool pipeline).
- **Global vs per-state errors**: Per-state errors are listed in **Error Handling**; for states not called out explicitly, the only error path is the global per-request handler (`req:* -> req:internal_error`).
- **Crash recovery**: Fully specified under **Crash Recovery** (detection signals, recovery state selection, and cleanup steps).
- **Subprocess contract**: Inputs, writable surface, and failure handling for each subprocess are specified in **Subprocesses**. Subprocess results are collected as `(stdout, stderr, exit_code, duration_ms)` and then optionally transformed by pruning; the final response always includes the raw/pruned payload plus pruning metadata.

### States
| State | Description | Entry Condition |
|-------|-------------|-----------------|
| `run:init` | Runner loads config and decides whether to enable the MCP pruner server for this run. | A workflow run begins (provider about to start a phase). |
| `run:mcp_pruner_disabled` | MCP pruner server is not configured for this run; agents use provider-native tools only. | `JEEVES_PRUNER_ENABLED=false`, or runner cannot build a valid `mcpServers` config. |
| `run:mcp_pruner_starting` | Provider starts `@jeeves/mcp-pruner` as a stdio MCP server using runner-provided `{ command, args, env }` config. | `run:init` decides MCP pruner is enabled and injects `mcpServers`. |
| `run:mcp_pruner_running` | MCP pruner server is available to the agent (provider successfully spawned/connected). | Provider successfully initializes MCP servers for the run. |
| `run:mcp_pruner_degraded` | MCP pruner was enabled but is now unavailable; it is disabled for the remainder of this run. | Provider reports MCP server failure (spawn/connect failure or unexpected exit). |
| `run:shutdown` | Runner ends the provider phase and releases resources. | The provider phase ends (success, failure, or cancel). |
| `req:received` | MCP server accepts an incoming tool request and assigns `request_id`. | A client connects and submits an MCP request. |
| `req:validating` | MCP server validates tool name and arguments, applies defaults, and normalizes inputs. | `req:received` begins processing. |
| `req:invalid_request` | MCP server rejects the request with a client error; no tool execution occurs. **Terminal (per-request).** | Validation fails (schema/type/range/path rules). |
| `req:executing_tool` | MCP server executes the underlying operation (`read` file, run `bash`, or run `grep`). | `req:validating` succeeds. |
| `req:tool_error` | Underlying tool operation fails; MCP server returns a tool error. **Terminal (per-request).** | Tool execution fails (e.g., ENOENT, non-zero exit, timeout). |
| `req:raw_output_ready` | Raw (unpruned) tool output is available in memory along with exit code/metadata. | `req:executing_tool` completes successfully. |
| `req:prune_check` | MCP server decides whether pruning will be attempted. | `req:raw_output_ready` completes. |
| `req:calling_pruner` | MCP server calls the configured HTTP pruner endpoint with raw output + `context_focus_question`. | `req:prune_check` determines pruning is eligible. |
| `req:pruner_error_fallback` | Pruner call failed; MCP server falls back to returning raw output. | Pruner times out, returns non-2xx, or returns an invalid payload. |
| `req:respond_raw` | MCP server formats and returns raw output (optionally with pruning metadata stating it was skipped/failed). | Pruning is not attempted or pruning failed. |
| `req:respond_pruned` | MCP server formats and returns pruned output (with metadata indicating pruning applied). | Pruner returns a valid pruned result. |
| `req:responded` | MCP response has been successfully written and the request is complete. **Terminal (per-request).** | `req:respond_raw` or `req:respond_pruned` finishes writing. |
| `req:internal_error` | Unexpected server error; MCP server returns an internal error response. **Terminal (per-request).** | An unhandled exception occurs at any request state. |

### Transitions
| From | Event/Condition | To | Side Effects |
|------|-----------------|-----|--------------|
| `run:init` | `JEEVES_PRUNER_ENABLED=false` | `run:mcp_pruner_disabled` | Log `mcp_pruner.disabled` (reason=`config_disabled`). |
| `run:init` | `JEEVES_PRUNER_ENABLED=true` and MCP config resolves | `run:mcp_pruner_starting` | Build `mcpServers` config and pass it to the provider (provider owns spawn/connect). |
| `run:mcp_pruner_starting` | Provider successfully initializes MCP servers | `run:mcp_pruner_running` | Log `mcp_pruner.ready` (server configured). |
| `run:mcp_pruner_starting` | Provider fails to spawn/connect MCP server | `run:mcp_pruner_disabled` | Log `mcp_pruner.start_failed` with error; continue run without MCP. |
| `run:mcp_pruner_running` | Provider reports MCP server failure during run | `run:mcp_pruner_degraded` | Log `mcp_pruner.degraded`; continue run without MCP. |
| `run:mcp_pruner_running` | Provider phase ends (success/fail/cancel) | `run:shutdown` | No explicit server shutdown required by runner (provider owns child process lifecycle). |
| `run:mcp_pruner_disabled` | Provider phase ends | `run:shutdown` | No-op aside from logging `mcp_pruner.not_running`. |
| `run:mcp_pruner_degraded` | Provider phase ends | `run:shutdown` | Ensure any remaining child pid is terminated; log `mcp_pruner.shutdown_after_degraded`. |
| `req:received` | Request accepted | `req:validating` | Assign `request_id`; log `tool.request_received` (tool, request_id). |
| `req:validating` | Arguments invalid for tool schema | `req:invalid_request` | Return MCP client error; log `tool.request_invalid` (validation_errors). |
| `req:validating` | Arguments valid | `req:executing_tool` | Normalize args (defaults); log `tool.exec_start` (tool, request_id). |
| `req:executing_tool` | Underlying operation fails (ENOENT, exit!=0, timeout) | `req:tool_error` | Return tool error; log `tool.exec_failed` (error/exit_code/duration_ms). |
| `req:executing_tool` | Underlying operation succeeds | `req:raw_output_ready` | Capture raw output + metadata; log `tool.exec_ok` (duration_ms, bytes). |
| `req:raw_output_ready` | Raw output captured | `req:prune_check` | Compute `raw_bytes` and pruning eligibility inputs. |
| `req:prune_check` | No `context_focus_question` provided | `req:respond_raw` | Set `pruning.attempted=false` and `pruning.reason="no_focus_question"`. |
| `req:prune_check` | Pruning disabled or pruner URL disabled (`PRUNER_URL` empty) | `req:respond_raw` | Set `pruning.attempted=false` and `pruning.reason="disabled_or_unconfigured"`. |
| `req:prune_check` | Raw output is empty | `req:respond_raw` | Set `pruning.attempted=false` and `pruning.reason="output_empty"`. |
| `req:prune_check` | `context_focus_question` present and pruning eligible | `req:calling_pruner` | Start pruner timeout timer; log `pruner.call_start` (endpoint, request_id). |
| `req:calling_pruner` | HTTP 200 + valid pruned payload | `req:respond_pruned` | Set `pruning.attempted=true` and `pruning.applied=true`; log `pruner.call_ok` (duration_ms, pruned_bytes). |
| `req:calling_pruner` | Timeout, network error, non-2xx, or invalid payload | `req:pruner_error_fallback` | Set `pruning.attempted=true`, `pruning.applied=false`, `pruning.fallback=true`, `pruning.reason="pruner_error"`, and `pruning.error.code`; log `pruner.call_failed` (reason, duration_ms). |
| `req:pruner_error_fallback` | Fallback chosen | `req:respond_raw` | Return raw output with the pruning metadata set above (include error message). |
| `req:respond_raw` | Response serialized and written | `req:responded` | Return raw output + pruning metadata; log `tool.respond_ok` (mode=`raw`). |
| `req:respond_pruned` | Response serialized and written | `req:responded` | Return pruned output + pruning metadata; log `tool.respond_ok` (mode=`pruned`). |
| `req:*` | Unhandled exception anywhere in pipeline | `req:internal_error` | Return MCP internal error; log `tool.internal_error` with stack/request_id/tool. |

### Error Handling
| State | Error | Recovery State | Actions |
|-------|-------|----------------|---------|
| `run:init` | Invalid env/config values (e.g., non-integer timeouts) | `run:mcp_pruner_disabled` | Log `mcp_pruner.config_invalid`; continue run without MCP pruner. |
| `run:mcp_pruner_starting` | Provider fails to spawn/connect MCP server | `run:mcp_pruner_disabled` | Log `mcp_pruner.spawn_error`; continue run without MCP pruner. |
| `run:mcp_pruner_running` | Provider reports MCP server failure during run | `run:mcp_pruner_degraded` | Log `mcp_pruner.degraded`; continue run without MCP pruner. |
| `req:received` | Request body parse error | `req:invalid_request` | Return MCP client error; log `tool.request_parse_failed`. |
| `req:validating` | Schema/type/range validation errors | `req:invalid_request` | Return MCP client error with field errors; log `tool.request_invalid`. |
| `req:executing_tool` | File read error (ENOENT, EACCES) | `req:tool_error` | Return tool error; log `tool.exec_failed` (error_code). |
| `req:executing_tool` | Subprocess timeout for `bash`/`grep` | `req:tool_error` | Kill subprocess; return tool error; log `tool.exec_timeout` (timeout_ms). |
| `req:calling_pruner` | HTTP timeout | `req:pruner_error_fallback` | Abort request; log `pruner.timeout`; include `pruning.error.code="timeout"` in metadata. |
| `req:calling_pruner` | HTTP non-2xx / network error | `req:pruner_error_fallback` | Log `pruner.http_error`; include `pruning.error.code="http_error"` in metadata. |
| `req:calling_pruner` | Invalid pruner response (bad JSON / missing fields) | `req:pruner_error_fallback` | Log `pruner.invalid_response`; include `pruning.error.code="invalid_response"` in metadata. |
| `req:respond_raw` / `req:respond_pruned` | Response serialization/write error | `req:internal_error` | Log `tool.respond_failed`; close connection. |
| `req:*` | Any unhandled exception | `req:internal_error` | Log `tool.internal_error` with stack; return MCP internal error. |

### Crash Recovery
- **Detection**:
  - Runner: detects MCP failures via provider-reported spawn/connect errors or tool-call failures.
  - Server: detects client disconnects via socket close; detects hung subprocesses via per-tool timeouts.
- **Recovery state**:
  - Within the same run: runner transitions to `run:mcp_pruner_degraded` and continues the run with MCP pruner tools unavailable.
  - On a subsequent run (fresh process): runner always restarts from `run:init` and attempts `run:mcp_pruner_starting` again if enabled.
  - Per-request: client retries by issuing a new MCP request (new `request_id`); there is no in-request replay after a process crash.
- **Cleanup**:
  - Runner: stop injecting MCP config for subsequent runs if disabled; provider owns MCP server child lifecycle for the current run.
  - Server: kill timed-out `bash`/`grep` subprocesses; drop in-memory raw output buffers for aborted requests.

### Subprocesses (if applicable)
| Subprocess | Receives | Can Write | Failure Handling |
|------------|----------|-----------|------------------|
| `@jeeves/mcp-pruner` (server) | Run config via env (`PRUNER_URL`, `PRUNER_TIMEOUT_MS`, `MCP_PRUNER_CWD`). | Writes logs to stderr only; stdout is reserved for MCP protocol. | Provider spawn/connect failure -> `run:mcp_pruner_disabled`; unexpected exit during run -> `run:mcp_pruner_degraded`. |
| `bash` tool command | `cmd`, `cwd` (default runner cwd), `env` (sanitized merge), `timeout_ms`. | May write to filesystem as a normal shell command would (trusted local automation). | Timeout -> kill process and return `req:tool_error`; non-zero exit -> `req:tool_error`; stdout/stderr captured into raw output. |
| `grep` tool command (`rg` or equivalent) | `pattern`, `paths`, `cwd`, `timeout_ms`, `max_matches`/`max_bytes` limits. | None (read-only scan), aside from process stdout/stderr. | Timeout/non-zero exit -> `req:tool_error` (include stderr); large output should be truncated before optional pruning eligibility check. |

## 3. Interfaces

This feature adds a new local MCP server (`@jeeves/mcp-pruner`) and a new opt-in request parameter (`context_focus_question`) on its tools. It also defines an outbound HTTP contract to a configured `swe-pruner` service.

### Transport (stdio; issue-prescribed)
The MCP server is implemented using `@modelcontextprotocol/sdk` (`McpServer` + `StdioServerTransport`) and communicates over stdio. There is no HTTP `/mcp` endpoint and no `/healthz`.

### MCP Methods
All MCP requests are JSON-RPC 2.0 objects (over stdio):
- Request: `{ jsonrpc: "2.0", id: string | number, method: string, params?: object }`
- Response (success): `{ jsonrpc: "2.0", id: string | number, result: object }`
- Response (error): `{ jsonrpc: "2.0", id: string | number | null, error: { code: number, message: string, data?: object } }`
 
Tool input validation uses issue-aligned `zod` schemas, but the server does not treat SDK-generated error strings as a public contract. Validation failures are returned as deterministic JSON-RPC invalid-params errors as defined below.

Supported methods:
| MCP Method | Invocation Pattern | Params | Result | Errors |
|-----------|--------------------|--------|--------|--------|
| `initialize` | JSON-RPC request | `{ protocolVersion: string, clientInfo?: { name: string, version?: string }, capabilities?: object }` | `{ protocolVersion: string, serverInfo: { name: "@jeeves/mcp-pruner", version: string }, capabilities: { tools: { listChanged?: false } }, jeeves: { schemaVersion: 1 } }` | JSON-RPC `-32602` if required fields missing/invalid |
| `tools/list` | JSON-RPC request | `{}` or omitted | `{ tools: Array<{ name: "read" | "bash" | "grep", description: string, inputSchema: JSONSchema }> }` | JSON-RPC `-32601` for unknown method; `-32602` for invalid params |
| `tools/call` | JSON-RPC request | `{ name: "read" | "bash" | "grep", arguments: object }` | `{ content: Array<{ type: "text", text: string }>, structuredContent?: object, isError?: boolean }` | JSON-RPC `-32602` invalid params; tool-level errors return `result.isError=true` (not JSON-RPC errors) |

#### Invalid params (`-32602`) contract (deterministic)
The server does **not** treat SDK-generated error strings as a public contract. All request/param validation failures for supported methods are mapped to the following JSON-RPC error shape:

- `error.code`: `-32602`
- `error.message`: `"Invalid params"` (exact string)
- `error.data`:
  - `jeeves`: `{ schemaVersion: 1 }`
  - `method`: MCP method name (e.g., `"tools/call"`)
  - `tool` (optional): tool name when `method === "tools/call"` and `params.name` is present
  - `issues`: `Array<{ path: string; code: string; message: string }>`
    - `path`: dot-joined path (e.g., `"arguments.file_path"`), `""` for root
    - `code`: the `zod` issue `code`
    - `message`: equals `code` (stable, implementation-defined; avoids version-dependent wording)
    - Ordering: `issues` are sorted lexicographically by `(path, code)` before being returned

### MCP Tools
Each tool accepts an optional `context_focus_question` to request output pruning. When provided and pruning is configured+eligible, the server calls the pruner and returns pruned output with explicit metadata; otherwise it returns raw output with `pruning.applied=false`.

**Common fields**
- `context_focus_question` (optional, `string`): Non-empty question used to focus/prune the raw tool output.
- `max_output_bytes` (optional, `number`): If provided, raw tool output is truncated to at most this many UTF-8 bytes **before** pruning eligibility is evaluated.

Tool: `read`
- Arguments:
  - `file_path` (required, `string`): Path to read. Resolved against the server root dir; must resolve to a location within the root dir. (Issue-aligned name; replaces prior `path`.)
  - `encoding` (optional, `"utf-8"` only; default `"utf-8"`).
  - `max_output_bytes` (optional, `number`): Output truncation cap (see common fields).
  - `context_focus_question` (optional, `string`).
- Success `structuredContent`:
  - `{ tool: "read", file_path: string, encoding: "utf-8", content: string, truncated: boolean, bytes: number, duration_ms: number, pruning: PruningMetadata }`
- Tool error `structuredContent` (`isError=true`):
  - `{ tool: "read", error: { code: "not_found" | "permission_denied" | "invalid_path" | "io_error", message: string }, pruning: PruningMetadata }`

Tool: `bash`
- Arguments:
  - `command` (required, `string`): Shell command to run (executed via the platform shell; default `bash -lc` on POSIX). (Issue-aligned name; replaces prior `cmd`.)
  - `cwd` (optional, `string`): Working directory. Resolved against server root dir; must stay within root dir.
  - `env` (optional, `Record<string, string>`): Environment overrides merged over the server process env after sanitization.
  - `timeout_ms` (optional, `number`): Hard timeout for the subprocess.
  - `max_output_bytes` (optional, `number`): Output truncation cap (see common fields).
  - `context_focus_question` (optional, `string`).
- Success `structuredContent`:
  - `{ tool: "bash", command: string, cwd: string, stdout: string, stderr: string, exit_code: number, timed_out: boolean, truncated: boolean, duration_ms: number, pruning: PruningMetadata }`
- Tool error `structuredContent` (`isError=true`):
  - `{ tool: "bash", error: { code: "timeout" | "spawn_error" | "nonzero_exit" | "invalid_cwd", message: string, exit_code?: number }, stdout?: string, stderr?: string, pruning: PruningMetadata }`

Tool: `grep`
- Arguments:
  - `pattern` (required, `string`): Pattern to search for (regex by default).
  - `path` (optional, `string`): Single file/dir path to search. (Issue-aligned name; default `"."`.) Mutually exclusive with `paths`.
  - `paths` (optional, `string[]`): One or more file/dir paths to search. Each resolved against server root dir; all must stay within root dir.
  - `cwd` (optional, `string`): Working directory for the grep command (same constraints as `bash.cwd`).
  - `fixed_string` (optional, `boolean`; default `false`): If true, pattern is treated as a literal.
  - `case_sensitive` (optional, `boolean`; default `true`).
  - `timeout_ms` (optional, `number`).
  - `max_matches` (optional, `number`): Hard cap on match count returned.
  - `max_output_bytes` (optional, `number`): Output truncation cap (see common fields).
  - `context_focus_question` (optional, `string`).
- Success `structuredContent`:
  - `{ tool: "grep", pattern: string, paths: string[], matches: Array<{ path: string, line: number, column: number | null, text: string }>, match_count: number, truncated: boolean, duration_ms: number, pruning: PruningMetadata }`
- Tool error `structuredContent` (`isError=true`):
  - `{ tool: "grep", error: { code: "timeout" | "spawn_error" | "invalid_path" | "rg_error", message: string, exit_code?: number }, pruning: PruningMetadata }`

**Execution strategy (preferred `rg`, deterministic fallback)**
- Engine selection:
  1. Attempt `rg` from `PATH`.
  2. If `rg` is not executable / spawn fails with `ENOENT`, fall back to system `grep`.
- Preferred (`rg`) command (machine-parseable output):
  - Base args: `rg --json`
  - Add `-F` when `fixed_string=true`
  - Add `-i` when `case_sensitive=false`
  - Always pass `--` then resolved search paths derived from `grep.paths` or `[grep.path ?? "."]`
  - Parse `--json` events and emit one `matches[]` entry per match (first submatch start used for `column` when present).
  - Exit-code handling: `0` (matches) and `1` (no matches) are both **success**; `2` is a tool error with `code="rg_error"` and `exit_code=2`.
- Fallback (`grep`) command (line-oriented output):
  - Base args: `grep -R -n -H`
  - Use `-F` when `fixed_string=true`, else `-E` (POSIX ERE)
  - Add `-i` when `case_sensitive=false`
  - Always pass `--` then resolved search paths derived from `grep.paths` or `[grep.path ?? "."]`
  - Output parsing: parse each line as `path:line:text` (split on the first two `:`); `column` is `indexOf(pattern)+1` when `fixed_string=true`, otherwise `null`.
  - Exit-code handling: `0` (matches) and `1` (no matches) are both **success**; `2` is a tool error with `code="rg_error"` and `exit_code=2`.
- Limits (both engines):
  - `timeout_ms`: kill the child process and return a tool error with `code="timeout"`.
  - `max_matches`: stop reading once `max_matches` matches are collected, terminate the child process, and set `truncated=true`.
  - `max_output_bytes`: cap the UTF-8 bytes across returned `matches[].text` (stop early, terminate process, and set `truncated=true`).

Type: `PruningMetadata`
- Shape:
  - `{ attempted: boolean, applied: boolean, fallback: boolean, reason?: "disabled_or_unconfigured" | "no_focus_question" | "too_large" | "output_empty" | "pruner_error", raw_bytes: number, pruned_bytes?: number, pruner_duration_ms?: number, error?: { code: "timeout" | "http_error" | "invalid_response", message: string } }`
- Semantics:
  - `attempted=true` iff an outbound `swe-pruner` HTTP request was made.
  - `applied=true` iff pruning succeeded and the response payload was applied to the tool output.
  - `fallback=true` iff pruning was attempted but raw output was returned (always implies `attempted=true` and `applied=false`).
  - `reason` is set whenever `applied=false` to explain why pruning was not applied (including skip reasons like `no_focus_question` and failure reasons like `pruner_error`).
  - `raw_bytes` is measured after any tool-level `max_output_bytes` truncation (i.e., bytes that were eligible for pruning).
  - `pruned_bytes` is present only when `applied=true`.
  - `error` is present only when `reason="pruner_error"` (and `fallback=true`).

### Outbound HTTP (swe-pruner)
The MCP server makes a best-effort HTTP call when pruning is requested.

- **URL**: `PRUNER_URL` (full URL, including path)
- **Method**: `POST`
- **Headers**: `Content-Type: application/json`
- **Timeout**: `PRUNER_TIMEOUT_MS` (defaults to a safe value; see **Validation Rules**)
- **Request body (issue-aligned adapter)**: `{ code: string, query: string }`
  - Tool → `code` mapping (after any tool-level `max_output_bytes` truncation):
    - `read`: `code = content`
    - `bash`: `code = stdout` if `stdout` is non-empty, else `code = stderr` (the pruned output replaces the same field used as input)
    - `grep`: `code = matches` rendered as newline-separated `path:line:column:text` lines (column omitted when `null`)
  - `query = context_focus_question.trim()`
- **Success response (200)**:
  - Response MUST be JSON, and the pruned text is read from the first string field present in this order: `pruned_code`, then `content`, then `text`.
  - If none of these fields is present as a string, treat as `invalid_response`.
- **Applying the pruned text**:
  - `read`: replace `structuredContent.content` with the pruned text.
  - `bash`: replace the chosen stream (`stdout` or `stderr`) with the pruned text.
  - `grep`: replace `structuredContent.matches` by parsing the pruned text back into `matches[]` using the same `path:line:column?:text` rules; if parsing fails, treat as `invalid_response` and fall back to the raw matches.
- **Error mapping (all treated as pruning failure with raw output returned)**:
  - Timeout → `pruning.reason="pruner_error"`, `pruning.fallback=true`, `pruning.error.code="timeout"`
  - Network error / non-2xx → `pruning.error.code="http_error"`
  - JSON parse error / missing pruned field / grep re-parse failure → `pruning.error.code="invalid_response"`

### CLI Commands (if applicable)
| Command | Arguments | Options | Output |
|---------|-----------|---------|--------|
| `mcp-pruner` | (none) | (none; configured via env) | Starts an MCP stdio server; logs to stderr |

**Provider → server invocation contract**
- Providers spawn the server using a `ProviderRunOptions.mcpServers` entry shaped like `{ command, args, env }` and connect over stdio.
- The `mcp-pruner` process MUST keep stdout reserved for MCP protocol messages; all diagnostics go to stderr.

### Events (if applicable)
Events are emitted as structured log lines (default JSON) on the MCP server stderr. Each event is a single JSON object:
- `{ ts: string, level: "debug" | "info" | "warn" | "error", event: string, request_id?: string, data?: object }`

| Event | Trigger | Payload | Consumers |
|-------|---------|---------|-----------|
| `mcp_pruner.disabled` | Server/runner decides pruning server is not enabled for the run | `{ reason: "config_disabled" \| "config_invalid" \| "start_failed" }` | Runner logs; viewer log stream |
| `mcp_pruner.ready` | Server connects via stdio transport and is ready to serve MCP requests | `{ root: string }` | Runner diagnostics; viewer logs |
| `mcp_pruner.start_failed` | Server process fails before readiness | `{ message: string }` | Runner; viewer logs |
| `mcp_pruner.degraded` | Provider detects server exit/unreachability during a run | `{ reason: "exited" \| "unreachable", exit_code?: number, signal?: string }` | Runner; viewer logs |
| `mcp_pruner.stopped` | Server process exits after the run/phase completes | `{ graceful: boolean, duration_ms: number }` | Runner; viewer logs |
| `tool.request_invalid` | MCP request fails schema validation | `{ tool?: string, message: string }` | Debugging; viewer logs |
| `tool.exec_failed` | Tool execution fails (IO/spawn/nonzero exit) | `{ tool: string, code: string, message: string, exit_code?: number }` | Debugging; viewer logs |
| `tool.exec_timeout` | Tool execution exceeds timeout | `{ tool: string, timeout_ms: number }` | Debugging; viewer logs |
| `pruner.call_start` | Pruner HTTP call initiated | `{ endpoint: string, tool: string, input_bytes: number }` | Debugging; viewer logs |
| `pruner.call_ok` | Pruner HTTP call succeeded | `{ tool: string, pruner_duration_ms: number, pruned_bytes: number }` | Debugging; viewer logs |
| `pruner.call_failed` | Pruner call failed (timeout/http/invalid response) | `{ tool: string, reason: "timeout" \| "http_error" \| "invalid_response", pruner_duration_ms?: number, message?: string }` | Debugging; viewer logs |

### Configuration & Validation Rules

**Runner environment (Jeeves runner / viewer-server process)**
| Field | Type | Constraints | Behavior |
|-------|------|-------------|----------|
| `JEEVES_PRUNER_ENABLED` | boolean (env string) | optional; truthy: `1/true/yes/on`, falsy otherwise | When falsy, runner does not inject `mcpServers` config into providers (feature off). |
| `JEEVES_PRUNER_URL` | string | optional; empty string allowed; if set non-empty must be a valid absolute URL with `http:` or `https:` | When `JEEVES_PRUNER_ENABLED` is truthy, runner always forwards a `PRUNER_URL` value into the MCP server env: if `JEEVES_PRUNER_URL` is unset → default `http://localhost:8000/prune`; if set to `""` → forwarding `PRUNER_URL=""` disables pruning; else forward the provided URL verbatim. |
| `JEEVES_MCP_PRUNER_PATH` | string | optional; if set must be a valid file path | JS entrypoint used by `node` for the MCP server. If unset, runner resolves it deterministically (see **Default `mcp-pruner` path resolution**). |

**MCP server environment (`mcp-pruner` process)**
| Field | Type | Constraints | Behavior |
|-------|------|-------------|----------|
| `PRUNER_URL` | string | optional; default `http://localhost:8000/prune`; empty string disables pruning | Used for outbound HTTP to `swe-pruner`. If empty, pruning is skipped with `reason="disabled_or_unconfigured"`. When spawned by the Jeeves runner (and enabled), this env var is always set explicitly (default or empty). |
| `PRUNER_TIMEOUT_MS` | number (env string) | optional; default `30000`; integer `100..300000` | Timeout for the outbound pruner call. |
| `MCP_PRUNER_CWD` | string | optional; default process `cwd`; must exist and be a directory | Root directory for resolving relative paths and for executing tool subprocesses. |

**Precedence**
- Runner env vars determine whether MCP is injected and what env is passed to the provider-spawned server.
- Server env vars are set via the spawned process environment (from runner/provider wiring).

**Default `mcp-pruner` path resolution (when `JEEVES_MCP_PRUNER_PATH` is unset)**
To reliably support both monorepo workspace runs and installed-package usage, `@jeeves/runner` resolves the stdio server JS entrypoint with the following ordered algorithm:
1. `require.resolve("@jeeves/mcp-pruner/dist/index.js")` (works when the package is resolvable from the runner bundle).
2. Fallback to workspace dist layout: `path.resolve(__dirname, "../../mcp-pruner/dist/index.js")` (relative to `packages/runner/dist/*` at runtime).
3. If neither exists/readable, treat the pruner config as invalid for the run and do not inject `mcpServers`.

**Tool argument validation (MCP request params)**
| Field | Type | Constraints | Error |
|-------|------|-------------|-------|
| `read.file_path` | string | required; non-empty; no `\\0`; resolves within server root dir (`MCP_PRUNER_CWD`); must refer to a regular file | JSON-RPC `-32602` |
| `read.encoding` | string | optional; must equal `"utf-8"` | JSON-RPC `-32602` |
| `read.context_focus_question` | string | optional; if provided must be non-empty after trim; max 1000 chars | JSON-RPC `-32602` |
| `read.max_output_bytes` | number | optional; integer `1024..10485760` | JSON-RPC `-32602` |
| `bash.command` | string | required; non-empty; max 50000 chars | JSON-RPC `-32602` |
| `bash.cwd` | string | optional; resolves within server root dir (`MCP_PRUNER_CWD`); must exist and be a directory | JSON-RPC `-32602` |
| `bash.env` | object | optional; keys match `/^[A-Z_][A-Z0-9_]*$/`; values max 4000 chars; total entries max 200 | JSON-RPC `-32602` |
| `bash.timeout_ms` | number | optional; integer `100..300000`; default `30000` | JSON-RPC `-32602` |
| `bash.context_focus_question` | string | optional; same constraints as `read.context_focus_question` | JSON-RPC `-32602` |
| `bash.max_output_bytes` | number | optional; integer `1024..10485760` | JSON-RPC `-32602` |
| `grep.pattern` | string | required; non-empty; max 10000 chars | JSON-RPC `-32602` |
| `grep.path` | string | optional; if provided resolves within server root dir (`MCP_PRUNER_CWD`) | JSON-RPC `-32602` |
| `grep.paths` | string[] | optional; length `1..100`; each resolves within server root dir (`MCP_PRUNER_CWD`) | JSON-RPC `-32602` |
| `grep.cwd` | string | optional; same constraints as `bash.cwd` | JSON-RPC `-32602` |
| `grep.fixed_string` | boolean | optional | JSON-RPC `-32602` |
| `grep.case_sensitive` | boolean | optional | JSON-RPC `-32602` |
| `grep.timeout_ms` | number | optional; integer `100..300000`; default `30000` | JSON-RPC `-32602` |
| `grep.max_matches` | number | optional; integer `1..5000`; default `500` | JSON-RPC `-32602` |
| `grep.context_focus_question` | string | optional; same constraints as `read.context_focus_question` | JSON-RPC `-32602` |
| `grep.max_output_bytes` | number | optional; integer `1024..10485760` | JSON-RPC `-32602` |

**Validation failure behavior**
- MCP request validation is **synchronous** (schema/type/range checks) and fails fast with JSON-RPC `error.code=-32602` (invalid params) using the deterministic contract defined above.
- Tool execution and filesystem checks are **asynchronous** and surface as tool-level errors (`result.isError=true`), not JSON-RPC errors.
- Pruner call validation is **asynchronous**; any failure results in `pruning.fallback=true` and raw output returned.

### Provider Wiring (Claude + Codex)
This section reconciles the provider wiring to match the issue’s expected shape: providers spawn stdio MCP servers from `ProviderRunOptions.mcpServers` entries shaped like `{ command, args, env }`.

- **Server name (config key)**: `pruner` (i.e., `mcpServers.pruner = { ... }`).
- **Runner → providers type**: `ProviderRunOptions.mcpServers?: Readonly<Record<string, { command: string; args?: readonly string[]; env?: Readonly<Record<string, string>> }>>`
- **Runner build location**: `packages/runner/src/mcpConfig.ts` builds the `mcpServers` record from runner env vars and the run `cwd`.

**Claude Agent SDK**
- Touchpoint: `packages/runner/src/providers/claudeAgentSdk.ts`
- Wiring: pass `options.mcpServers` through to the Claude SDK `Options` as `mcpServers` (no URL; stdio servers are launched from `{ command, args, env }`).

**Codex**
- Touchpoint: `packages/runner/src/providers/codexSdk.ts`
- Wiring: convert `options.mcpServers` into `codex exec` config overrides (stdio transport):
  - `--config mcp_servers.<name>.command="<command>"`
  - `--config mcp_servers.<name>.args=["arg1","arg2"]` (only if `args` present)
  - `--config mcp_servers.<name>.env.<KEY>="<VALUE>"` for each env entry

### UI Interactions (if applicable)
| Action | Request | Loading State | Success | Error |
|--------|---------|---------------|---------|-------|
| Start a run (existing viewer) | Existing run start flow; runner injects `mcpServers` config and providers spawn `@jeeves/mcp-pruner` via stdio | Viewer shows normal run “in progress” states; tool calls appear as they occur | Viewer logs show `mcp:*/*` tool calls when the agent uses the MCP server | Failures are non-fatal to runs; viewer logs show `mcp_pruner.*` events and the run continues without MCP tools |

### Contract Gates (Explicit)
- **Breaking change**: No. This is a new optional MCP server and new optional tool argument; existing runs continue unchanged when disabled.
- **Migration path**: N/A (opt-in). Agents must explicitly set `context_focus_question` per tool call to request pruning.
- **Versioning**: MCP server reports `jeeves.schemaVersion=1` in `initialize`. Consumers MUST ignore unknown fields and SHOULD gate behavior on `jeeves.schemaVersion`.

## 4. Data
N/A - This feature does not add or modify data schemas.

## 5. Tasks

### Inputs From Sections 1–4 (Traceability)
- **Goals (Section 1)**:
  1. Standalone MCP server package `@jeeves/mcp-pruner` with tools `read`, `bash`, `grep`, each optionally accepting `context_focus_question`.
  2. When `context_focus_question` is provided, attempt pruning via configured `swe-pruner` HTTP endpoint; on any error/timeout, safely fall back to unpruned output with explicit metadata.
  3. Integrate into Jeeves runtime so both Claude Agent SDK and Codex runs can use the MCP tools, controlled by an explicit enable/disable switch.
- **Workflow (Section 2)**:
  - Runner lifecycle states to implement: `run:init → run:mcp_pruner_disabled | run:mcp_pruner_starting → run:mcp_pruner_running → run:mcp_pruner_degraded → run:shutdown` (with best-effort behavior; degraded/disabled must not fail the run).
  - Request pipeline states to implement: `req:received → req:validating → req:executing_tool → req:raw_output_ready → req:prune_check → (req:calling_pruner → req:respond_pruned | req:pruner_error_fallback → req:respond_raw) → req:responded` plus terminal errors `req:invalid_request | req:tool_error | req:internal_error`.
- **Interfaces (Section 3)**:
  - MCP transport: stdio via `@modelcontextprotocol/sdk` (`McpServer` + `StdioServerTransport`); providers spawn via `mcpServers` `{ command, args, env }`.
  - Tools: `read`, `bash`, `grep` with optional `context_focus_question` and issue-aligned input names (`read.file_path`, `bash.command`, `grep.pattern` + optional `grep.path`).
  - Outbound HTTP contract to pruner: `POST` to `PRUNER_URL` with timeout `PRUNER_TIMEOUT_MS`.
- **Data (Section 4)**: N/A (no schema changes, no migrations).

### Planning Gates (Explicit)
**Decomposition Gates**
1. **Smallest independently testable unit**: a single tool handler (e.g., `read`) + its argument validation + its `PruningMetadata` output, verified via unit tests (and optionally a minimal MCP SDK stdio integration test).
2. **Dependencies between tasks**: Yes. The MCP server entrypoint (SDK + stdio transport) must exist before end-to-end provider wiring; runner integration depends on the provider spawn config shape.
3. **Parallelizable tasks**: Yes. Tool handlers can be developed in parallel with runner/provider wiring after the package scaffold exists.

**Task Completeness Gates (applied per-task below)**
4. **Files changed**: Listed explicitly per task.
5. **Acceptance criteria**: Concrete, verifiable criteria per task.
6. **Verification command**: Concrete command per task (targeted vitest run / `pnpm typecheck` / `pnpm lint`).

**Ordering Gates**
7. **Must be done first**: Create the new `packages/mcp-pruner` workspace package and stdio MCP entrypoint (`src/index.ts`) so later tasks have a stable target.
8. **Can only be done last**: End-to-end runner/provider wiring (spawn server, inject endpoint into providers) + full-workspace validation (`pnpm typecheck && pnpm lint && pnpm test`).
9. **Circular dependencies**: None expected; enforce a DAG by keeping server implementation in `@jeeves/mcp-pruner` and runner integration in `@jeeves/runner` (runner depends on the server package, not vice versa).

**Infrastructure Gates**
10. **Build/config changes**: Yes. Add a new workspace package `packages/mcp-pruner`, update root `tsconfig.json` references, and add `@jeeves/mcp-pruner` as a dependency of `@jeeves/runner`.
11. **New dependencies**: Required by the issue: `@modelcontextprotocol/sdk` and `zod` in `@jeeves/mcp-pruner`.
12. **Env vars / secrets**:
  - Required to enable: `JEEVES_PRUNER_ENABLED` (truthy values).
  - Optional (runner): `JEEVES_PRUNER_URL`, `JEEVES_MCP_PRUNER_PATH`.
  - Optional (MCP server): `PRUNER_URL`, `PRUNER_TIMEOUT_MS`, `MCP_PRUNER_CWD`.
  - No secrets required beyond existing provider API keys (Claude/OpenAI), already handled elsewhere.

### Task Dependency Graph
```
T1 (no deps)
T2 → depends on T1
T3 → depends on T2
T4 → depends on T1, T3
T5 (no deps)
T6 → depends on T5
T7 → depends on T5, T6
T8 → depends on T5, T6
T9 → depends on T1, T6, T7, T8
T10 → depends on T1–T9
```

### Task Breakdown
| ID | Title | Summary | Files | Acceptance Criteria |
|----|-------|---------|-------|---------------------|
| T1 | Scaffold MCP pruner package | Add `@jeeves/mcp-pruner` workspace package with issue-prescribed dependencies (`@modelcontextprotocol/sdk`, `zod`) and stdio entrypoint. | `packages/mcp-pruner/src/index.ts` | `pnpm typecheck` includes the new package and `pnpm build` emits `packages/mcp-pruner/dist/index.js` with a `mcp-pruner` bin. |
| T2 | Implement pruner client | Implement `getPrunerConfig()` + `pruneContent()` with best-effort fallback to original content. | `packages/mcp-pruner/src/pruner.ts` | On timeout/non-2xx/invalid response, pruning falls back safely to the original content. |
| T3 | Implement tools (issue-aligned inputs) | Implement `read`, `bash`, `grep` with issue-aligned input names (`file_path`, `command`, `pattern`/`path`) and optional pruning hook. | `packages/mcp-pruner/src/tools/*.ts` | Tool input schemas match the issue examples; tool outputs remain compatible with Section 3 contracts. |
| T4 | Wire MCP SDK + stdio transport | Register tools on an `McpServer` and connect via `StdioServerTransport` (stdio). | `packages/mcp-pruner/src/index.ts` | Server runs over stdio (no HTTP endpoints); logs go to stderr (stdout reserved for protocol). |
| T5 | Extend runner options | Add `McpServerConfig` and `mcpServers` to `ProviderRunOptions` so providers can spawn MCP servers. | `packages/runner/src/provider.ts` | Providers can receive `mcpServers?: Record<string, { command, args?, env? }>` without type errors. |
| T6 | Add runner MCP config builder | Build the `mcpServers` record from env vars (`JEEVES_PRUNER_ENABLED`, `JEEVES_PRUNER_URL`, `JEEVES_MCP_PRUNER_PATH`) and wire into `runner.ts`. | `packages/runner/src/mcpConfig.ts` | When enabled, runner passes `mcpServers.pruner={ command, args, env }` to providers with deterministic defaults for `PRUNER_URL` and the `mcp-pruner` entrypoint path. |
| T7 | Claude provider wiring | Pass `options.mcpServers` through to Claude Agent SDK options. | `packages/runner/src/providers/claudeAgentSdk.ts` | Claude provider includes `mcpServers` when present; omits when absent. |
| T8 | Codex provider wiring | Convert `options.mcpServers` into Codex CLI `--config mcp_servers.*` overrides for stdio servers. | `packages/runner/src/providers/codexSdk.ts` | Codex provider sets `mcp_servers.<name>.command/args/env` (no `url` / `streamable_http`). |
| T9 | Docs | Add package docs + runner docs covering env vars and local usage. | `packages/mcp-pruner/CLAUDE.md` | Docs include env vars, local dev run instructions, and a minimal tool example. |
| T10 | Full validation | Run repo quality commands. | (none) | `pnpm lint && pnpm typecheck && pnpm test` pass. |

### Task Details

**T1: Scaffold MCP pruner package**
- Summary: Create the new `packages/mcp-pruner` workspace package with issue-prescribed dependencies (`@modelcontextprotocol/sdk`, `zod`) and a stdio MCP server entrypoint exposed as the `mcp-pruner` bin.
- Files:
  - `packages/mcp-pruner/package.json` - new workspace package + bin entry (`mcp-pruner` → `./dist/index.js`) and dependencies.
  - `packages/mcp-pruner/tsconfig.json` - TS build config emitting `dist/*`.
  - `packages/mcp-pruner/src/index.ts` - MCP server entrypoint (stdio transport).
  - `packages/mcp-pruner/CLAUDE.md` - package documentation.
  - `tsconfig.json` - add project reference to `./packages/mcp-pruner` (if required by repo conventions).
- Acceptance Criteria:
  1. `pnpm build` emits `packages/mcp-pruner/dist/index.js` and `mcp-pruner` runs as a stdio MCP server.
  2. Root `tsconfig.json` includes the new package so `pnpm typecheck` builds it.
- Dependencies: None
- Verification: `pnpm typecheck && pnpm build`

**T2: Implement pruner client**
- Summary: Implement the `swe-pruner` HTTP client contract (`{ code, query }`) with best-effort fallback to original content on all failures/timeouts.
- Files:
  - `packages/mcp-pruner/src/pruner.ts` - `getPrunerConfig()` + `pruneContent(...)`.
- Acceptance Criteria:
  1. `pruneContent` sends `{ code, query }` and accepts `pruned_code` / `content` / `text` as the pruned field.
  2. On timeout/non-2xx/network error/invalid response, `pruneContent` returns the original `code` and does not throw.
- Dependencies: T1
- Verification: `pnpm typecheck` (and unit tests if added)

**T3: Implement tools (issue-aligned inputs)**
- Summary: Implement `read`, `bash`, and `grep` tools with issue-aligned input names (`file_path`, `command`, `pattern` + optional `path`) and optional pruning via `context_focus_question`.
- Files:
  - `packages/mcp-pruner/src/tools/read.ts`
  - `packages/mcp-pruner/src/tools/bash.ts`
  - `packages/mcp-pruner/src/tools/grep.ts`
- Acceptance Criteria:
  1. Tool input schemas align with the issue examples: `read.file_path`, `bash.command`, `grep.pattern`, and optional `grep.path` (with `context_focus_question` optional for all).
  2. When `context_focus_question` is provided, tools attempt pruning via `pruneContent(...)`; on any pruning failure, they fall back to unpruned output.
- Dependencies: T2
- Verification: `pnpm typecheck` (and tool unit tests if added)

**T4: Wire MCP SDK + stdio transport**
- Summary: Register `read`, `bash`, and `grep` tools on an `McpServer` and connect via `StdioServerTransport` (stdio).
- Files:
  - `packages/mcp-pruner/src/index.ts` - MCP server entrypoint: tool registration + transport connect.
- Acceptance Criteria:
  1. `packages/mcp-pruner/src/index.ts` uses `@modelcontextprotocol/sdk/server/mcp` + `@modelcontextprotocol/sdk/server/stdio` and connects over stdio.
  2. The server writes diagnostics to stderr only (stdout reserved for MCP protocol).
- Dependencies: T1, T3
- Verification: `pnpm build` and a manual run of `node packages/mcp-pruner/dist/index.js`

**T5: Extend runner options**
- Summary: Extend `ProviderRunOptions` with `mcpServers` and define `McpServerConfig` in the runner so providers can spawn stdio MCP servers.
- Files:
  - `packages/runner/src/provider.ts`
- Acceptance Criteria:
  1. `ProviderRunOptions` includes `mcpServers?: Readonly<Record<string, McpServerConfig>>`.
  2. `McpServerConfig` matches the issue shape: `{ command: string; args?: readonly string[]; env?: Readonly<Record<string, string>> }`.
- Dependencies: None
- Verification: `pnpm typecheck`

**T6: Add runner MCP config builder**
- Summary: Build the `mcpServers` record from runner env vars and wire it through `runner.ts` so providers can spawn stdio MCP servers.
- Files:
  - `packages/runner/src/mcpConfig.ts`
  - `packages/runner/src/runner.ts`
- Acceptance Criteria:
  1. When `JEEVES_PRUNER_ENABLED` is falsy, runner does not pass `mcpServers` to providers.
  2. When enabled, runner passes `mcpServers.pruner={ command: "node", args: [<mcp-pruner path>], env: { PRUNER_URL, MCP_PRUNER_CWD } }` where:
     - `PRUNER_URL` is always set (default `http://localhost:8000/prune` when `JEEVES_PRUNER_URL` is unset; `""` disables pruning).
     - `<mcp-pruner path>` is either `JEEVES_MCP_PRUNER_PATH` or the default resolution described in Section 3.
- Dependencies: T1, T5
- Verification: `pnpm typecheck` (and unit tests if added)

**T7: Claude provider wiring**
- Summary: Pass `mcpServers` from `ProviderRunOptions` through to the Claude Agent SDK `Options` so the SDK spawns the stdio MCP server.
- Files:
  - `packages/runner/src/providers/claudeAgentSdk.ts`
- Acceptance Criteria:
  1. When `options.mcpServers` is provided, it is included in the Claude SDK `Options` as `mcpServers`.
  2. When not provided, Claude SDK options omit `mcpServers` entirely.
- Dependencies: T5, T6
- Verification: `pnpm typecheck` (and provider unit tests if added)

**T8: Codex provider wiring**
- Summary: Convert `ProviderRunOptions.mcpServers` into `codex exec` `--config mcp_servers.*` overrides so Codex spawns the stdio MCP server.
- Files:
  - `packages/runner/src/providers/codexSdk.ts`
- Acceptance Criteria:
  1. For each configured server, Codex provider sets `mcp_servers.<name>.command` and optional `mcp_servers.<name>.args`.
  2. For stdio servers, Codex provider sets env via `mcp_servers.<name>.env.<KEY>="<VALUE>"`.
  3. No `mcp_servers.<name>.url` / `transport="streamable_http"` is used for the pruner server.
- Dependencies: T5, T6
- Verification: `pnpm typecheck` (and provider unit tests if added)

**T9: Docs**
- Summary: Document how to build/run the MCP pruner server and how to enable it in Jeeves (runner + providers).
- Files:
  - `packages/mcp-pruner/CLAUDE.md` - usage + env vars + tool schemas.
  - `README.md` - runner env vars and a minimal enable/verify example.
- Acceptance Criteria:
  1. Docs list runner env vars (`JEEVES_PRUNER_ENABLED`, `JEEVES_PRUNER_URL`, `JEEVES_MCP_PRUNER_PATH`) and server env vars (`PRUNER_URL`, `PRUNER_TIMEOUT_MS`, `MCP_PRUNER_CWD`).
  2. Docs include a minimal `tools/call` example using `read.file_path` and `context_focus_question`.
- Dependencies: T1, T6, T7, T8
- Verification: N/A

**T10: Full validation**
- Summary: Run repo quality commands after implementation.
- Files: (none)
- Acceptance Criteria:
  1. `pnpm lint` passes.
  2. `pnpm typecheck` passes.
  3. `pnpm test` passes.
- Dependencies: T1–T9
- Verification: `pnpm lint && pnpm typecheck && pnpm test`

## 6. Validation

### Pre-Implementation Checks
- [ ] All dependencies installed: `pnpm install`
- [ ] Types check: `pnpm typecheck`
- [ ] Existing tests pass: `pnpm test`

### Post-Implementation Checks
- [ ] Types check: `pnpm typecheck`
- [ ] Lint passes: `pnpm lint`
- [ ] All tests pass: `pnpm test`
- [ ] New tests added for (as applicable): `packages/mcp-pruner/src/tools/*.test.ts`, `packages/mcp-pruner/src/pruner.test.ts`, `packages/runner/src/mcpConfig.test.ts`, `packages/runner/src/providers/*.test.ts`

### Manual Verification (if applicable)
- [ ] Start the viewer-server and run a workflow with MCP enabled:
  - `pnpm dev` (in another terminal)
  - Set env `JEEVES_PRUNER_ENABLED=true` for the viewer-server process
  - Start a run; confirm viewer logs include `mcp_pruner.ready` and subsequent `mcp:*/*` tool calls when the agent uses `read`/`bash`/`grep` with `context_focus_question`.
