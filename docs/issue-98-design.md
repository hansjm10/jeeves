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

---

## 2. Workflow

This feature adds a new MCP server (`@jeeves/mcp-pruner`) and an opt-in “prune this tool output” path. There are two cooperating state machines:

1. **Runner lifecycle** (per Jeeves run): starts/stops the MCP server and exposes it to the agent provider.
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
| `run:mcp_pruner_disabled` | MCP pruner server is not available for this run; agents may use provider-native tools only. | `JEEVES_MCP_PRUNER_ENABLED=false`, or runner cannot start the server. |
| `run:mcp_pruner_starting` | Runner spawns `@jeeves/mcp-pruner` and waits for readiness. | `run:init` decides MCP pruner is enabled. |
| `run:mcp_pruner_running` | MCP pruner server is ready; runner advertises MCP endpoint to the provider. | Server reports ready (health check passes) within startup timeout. |
| `run:mcp_pruner_degraded` | MCP pruner was running but is now unavailable; it is disabled for the remainder of this run. | Runner detects child process exit or repeated connection failures. |
| `run:shutdown` | Runner stops the MCP pruner server (if running) and releases resources. | The provider phase ends (success, failure, or cancel). |
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
| `run:init` | `JEEVES_MCP_PRUNER_ENABLED=false` | `run:mcp_pruner_disabled` | Log `mcp_pruner.disabled` (reason=`config_disabled`). |
| `run:init` | `JEEVES_MCP_PRUNER_ENABLED=true` | `run:mcp_pruner_starting` | Spawn subprocess `@jeeves/mcp-pruner` with env/config; start startup timer. |
| `run:mcp_pruner_starting` | Health check succeeds before timeout | `run:mcp_pruner_running` | Store MCP endpoint in run context; log `mcp_pruner.ready` (host/port). |
| `run:mcp_pruner_starting` | Spawn fails or health check timeout | `run:mcp_pruner_disabled` | Kill any partially started process; log `mcp_pruner.start_failed` with error/timeout. |
| `run:mcp_pruner_running` | Child process exits or becomes unreachable (N consecutive connect failures) | `run:mcp_pruner_degraded` | Mark MCP server unavailable for remainder of run; log `mcp_pruner.degraded` with exit code/signal. |
| `run:mcp_pruner_running` | Provider phase ends (success/fail/cancel) | `run:shutdown` | Send SIGTERM; wait `shutdown_timeout_ms`; SIGKILL if needed; log `mcp_pruner.stopped`. |
| `run:mcp_pruner_disabled` | Provider phase ends | `run:shutdown` | No-op aside from logging `mcp_pruner.not_running`. |
| `run:mcp_pruner_degraded` | Provider phase ends | `run:shutdown` | Ensure any remaining child pid is terminated; log `mcp_pruner.shutdown_after_degraded`. |
| `req:received` | Request accepted | `req:validating` | Assign `request_id`; log `tool.request_received` (tool, request_id). |
| `req:validating` | Arguments invalid for tool schema | `req:invalid_request` | Return MCP client error; log `tool.request_invalid` (validation_errors). |
| `req:validating` | Arguments valid | `req:executing_tool` | Normalize args (defaults); log `tool.exec_start` (tool, request_id). |
| `req:executing_tool` | Underlying operation fails (ENOENT, exit!=0, timeout) | `req:tool_error` | Return tool error; log `tool.exec_failed` (error/exit_code/duration_ms). |
| `req:executing_tool` | Underlying operation succeeds | `req:raw_output_ready` | Capture raw output + metadata; log `tool.exec_ok` (duration_ms, bytes). |
| `req:raw_output_ready` | Raw output captured | `req:prune_check` | Compute `raw_bytes` and pruning eligibility inputs. |
| `req:prune_check` | No `context_focus_question` provided | `req:respond_raw` | Set `pruning.attempted=false` and `pruning.reason=no_question`. |
| `req:prune_check` | Pruning disabled or pruner endpoint missing (`JEEVES_PRUNER_ENDPOINT` unset) | `req:respond_raw` | Set `pruning.attempted=false` and `pruning.reason=disabled_or_unconfigured`. |
| `req:prune_check` | Raw output exceeds `max_prune_input_bytes` | `req:respond_raw` | Set `pruning.attempted=false` and `pruning.reason=input_too_large`. |
| `req:prune_check` | `context_focus_question` present and pruning eligible | `req:calling_pruner` | Start pruner timeout timer; log `pruner.call_start` (endpoint, request_id). |
| `req:calling_pruner` | HTTP 200 + valid pruned payload | `req:respond_pruned` | Set `pruning.applied=true`; log `pruner.call_ok` (duration_ms, pruned_bytes). |
| `req:calling_pruner` | Timeout, network error, non-2xx, or invalid payload | `req:pruner_error_fallback` | Set `pruning.applied=false`; log `pruner.call_failed` (reason, duration_ms). |
| `req:pruner_error_fallback` | Fallback chosen | `req:respond_raw` | Set `pruning.attempted=true` and `pruning.fallback=true` (include error summary). |
| `req:respond_raw` | Response serialized and written | `req:responded` | Return raw output + pruning metadata; log `tool.respond_ok` (mode=`raw`). |
| `req:respond_pruned` | Response serialized and written | `req:responded` | Return pruned output + pruning metadata; log `tool.respond_ok` (mode=`pruned`). |
| `req:*` | Unhandled exception anywhere in pipeline | `req:internal_error` | Return MCP internal error; log `tool.internal_error` with stack/request_id/tool. |

### Error Handling
| State | Error | Recovery State | Actions |
|-------|-------|----------------|---------|
| `run:init` | Invalid env/config values (e.g., non-integer timeouts) | `run:mcp_pruner_disabled` | Log `mcp_pruner.config_invalid`; continue run without MCP pruner. |
| `run:mcp_pruner_starting` | Spawn fails (ENOENT, permission) | `run:mcp_pruner_disabled` | Log `mcp_pruner.spawn_error`; ensure no child pid is tracked. |
| `run:mcp_pruner_starting` | Startup health check timeout | `run:mcp_pruner_disabled` | Log `mcp_pruner.start_timeout`; SIGKILL any child still alive. |
| `run:mcp_pruner_running` | Child process exits unexpectedly | `run:mcp_pruner_degraded` | Log `mcp_pruner.exited`; stop advertising MCP tools for rest of run. |
| `run:mcp_pruner_running` | MCP connection failures exceed threshold | `run:mcp_pruner_degraded` | Log `mcp_pruner.unreachable`; stop advertising MCP tools for rest of run. |
| `run:shutdown` | Server refuses to exit within `shutdown_timeout_ms` | `run:shutdown` | SIGKILL; log `mcp_pruner.kill_escalated`. |
| `req:received` | Request body parse error | `req:invalid_request` | Return MCP client error; log `tool.request_parse_failed`. |
| `req:validating` | Schema/type/range validation errors | `req:invalid_request` | Return MCP client error with field errors; log `tool.request_invalid`. |
| `req:executing_tool` | File read error (ENOENT, EACCES) | `req:tool_error` | Return tool error; log `tool.exec_failed` (error_code). |
| `req:executing_tool` | Subprocess timeout for `bash`/`grep` | `req:tool_error` | Kill subprocess; return tool error; log `tool.exec_timeout` (timeout_ms). |
| `req:calling_pruner` | HTTP timeout | `req:pruner_error_fallback` | Abort request; log `pruner.timeout`; include `pruning.error=timeout` in metadata. |
| `req:calling_pruner` | HTTP non-2xx / network error | `req:pruner_error_fallback` | Log `pruner.http_error`; include `pruning.error=http_error` in metadata. |
| `req:calling_pruner` | Invalid pruner response (bad JSON / missing fields) | `req:pruner_error_fallback` | Log `pruner.invalid_response`; include `pruning.error=invalid_response` in metadata. |
| `req:respond_raw` / `req:respond_pruned` | Response serialization/write error | `req:internal_error` | Log `tool.respond_failed`; close connection. |
| `req:*` | Any unhandled exception | `req:internal_error` | Log `tool.internal_error` with stack; return MCP internal error. |

### Crash Recovery
- **Detection**:
  - Runner: detects a crash by the MCP server child process `exit` event, or by failing readiness/health checks.
  - Server: detects client disconnects via socket close; detects hung subprocesses via per-tool timeouts.
- **Recovery state**:
  - Within the same run: runner transitions to `run:mcp_pruner_degraded` and continues the run with MCP pruner tools unavailable.
  - On a subsequent run (fresh process): runner always restarts from `run:init` and attempts `run:mcp_pruner_starting` again if enabled.
  - Per-request: client retries by issuing a new MCP request (new `request_id`); there is no in-request replay after a process crash.
- **Cleanup**:
  - Runner: terminate any tracked MCP server pid; release port bindings by killing process; clear “advertised MCP tools” from provider context.
  - Server: kill timed-out `bash`/`grep` subprocesses; drop in-memory raw output buffers for aborted requests.

### Subprocesses (if applicable)
| Subprocess | Receives | Can Write | Failure Handling |
|------------|----------|-----------|------------------|
| `@jeeves/mcp-pruner` (server) | Run config via env (enabled flag, listen host/port, pruner endpoint, timeouts, `max_prune_input_bytes`); working directory from runner. | Writes logs to stdout/stderr (captured by runner); no direct writes to Jeeves state files. | Runner startup timeout -> disable; unexpected exit/unreachable -> `run:mcp_pruner_degraded` until run ends. |
| `bash` tool command | `cmd`, `cwd` (default runner cwd), `env` (sanitized merge), `timeout_ms`. | May write to filesystem as a normal shell command would (trusted local automation). | Timeout -> kill process and return `req:tool_error`; non-zero exit -> `req:tool_error`; stdout/stderr captured into raw output. |
| `grep` tool command (`rg` or equivalent) | `pattern`, `paths`, `cwd`, `timeout_ms`, `max_matches`/`max_bytes` limits. | None (read-only scan), aside from process stdout/stderr. | Timeout/non-zero exit -> `req:tool_error` (include stderr); large output should be truncated before optional pruning eligibility check. |

## 3. Interfaces

This feature adds a new local MCP server (`@jeeves/mcp-pruner`) and a new opt-in request parameter (`context_focus_question`) on its tools. It also defines an outbound HTTP contract to a configured `swe-pruner` service.

### Endpoints
| Method | Path | Input | Success | Errors |
|--------|------|-------|---------|--------|
| GET | `/healthz` | None | 200: `{ ok: true, status: "ok", server: { name: "@jeeves/mcp-pruner", version: string }, time: { started_at: string, uptime_ms: number } }` | 500: `{ ok: false, error: { code: "internal_error", message: string } }` |
| POST | `/mcp` | MCP JSON-RPC 2.0 request (`Content-Type: application/json`) | 200: MCP JSON-RPC 2.0 response; supports `initialize`, `tools/list`, `tools/call` | 200 with JSON-RPC `error` for parse/validation/method errors (`-32700`, `-32600`, `-32601`, `-32602`, `-32603`); 415: `{ ok: false, error: { code: "unsupported_media_type", message: string } }`; 405: `{ ok: false, error: { code: "method_not_allowed", message: string } }` |

**HTTP error shape (non-MCP endpoints)**
- `application/json` body: `{ ok: false, error: { code: string, message: string, details?: Record<string, unknown> } }`

### MCP Methods
All MCP requests are JSON-RPC 2.0 objects:
- Request: `{ jsonrpc: "2.0", id: string | number, method: string, params?: object }`
- Response (success): `{ jsonrpc: "2.0", id: string | number, result: object }`
- Response (error): `{ jsonrpc: "2.0", id: string | number | null, error: { code: number, message: string, data?: object } }`

For `error.code=-32602` (invalid params), `error.data` MUST be:
- `{ field_errors: Array<{ field: string, message: string }> }`

Supported methods:
| MCP Method | Invocation Pattern | Params | Result | Errors |
|-----------|--------------------|--------|--------|--------|
| `initialize` | JSON-RPC request | `{ protocolVersion: string, clientInfo?: { name: string, version?: string }, capabilities?: object }` | `{ protocolVersion: string, serverInfo: { name: "@jeeves/mcp-pruner", version: string }, capabilities: { tools: { listChanged?: false } }, jeeves: { schemaVersion: 1 } }` | JSON-RPC `-32602` if required fields missing/invalid |
| `tools/list` | JSON-RPC request | `{}` or omitted | `{ tools: Array<{ name: "read" | "bash" | "grep", description: string, inputSchema: JSONSchema }> }` | JSON-RPC `-32601` for unknown method; `-32602` for invalid params |
| `tools/call` | JSON-RPC request | `{ name: "read" | "bash" | "grep", arguments: object }` | `{ content: Array<{ type: "text", text: string }>, structuredContent?: object, isError?: boolean }` | JSON-RPC `-32602` invalid params; tool-level errors return `result.isError=true` (not JSON-RPC errors) |

### MCP Tools
Each tool accepts an optional `context_focus_question` to request output pruning. When provided and pruning is configured+eligible, the server calls the pruner and returns pruned output with explicit metadata; otherwise it returns raw output with `pruning.applied=false`.

**Common fields**
- `context_focus_question` (optional, `string`): Non-empty question used to focus/prune the raw tool output.
- `max_output_bytes` (optional, `number`): If provided, raw tool output is truncated to at most this many UTF-8 bytes **before** pruning eligibility is evaluated.

Tool: `read`
- Arguments:
  - `path` (required, `string`): Path to read. Resolved against the server root dir; must resolve to a location within the root dir.
  - `encoding` (optional, `"utf-8"` only; default `"utf-8"`).
  - `max_output_bytes` (optional, `number`): Output truncation cap (see common fields).
  - `context_focus_question` (optional, `string`).
- Success `structuredContent`:
  - `{ tool: "read", path: string, encoding: "utf-8", content: string, truncated: boolean, bytes: number, duration_ms: number, pruning: PruningMetadata }`
- Tool error `structuredContent` (`isError=true`):
  - `{ tool: "read", error: { code: "not_found" | "permission_denied" | "invalid_path" | "io_error", message: string }, pruning: PruningMetadata }`

Tool: `bash`
- Arguments:
  - `cmd` (required, `string`): Shell command to run (executed via the platform shell; default `bash -lc` on POSIX).
  - `cwd` (optional, `string`): Working directory. Resolved against server root dir; must stay within root dir.
  - `env` (optional, `Record<string, string>`): Environment overrides merged over the server process env after sanitization.
  - `timeout_ms` (optional, `number`): Hard timeout for the subprocess.
  - `max_output_bytes` (optional, `number`): Output truncation cap (see common fields).
  - `context_focus_question` (optional, `string`).
- Success `structuredContent`:
  - `{ tool: "bash", cmd: string, cwd: string, stdout: string, stderr: string, exit_code: number, timed_out: boolean, truncated: boolean, duration_ms: number, pruning: PruningMetadata }`
- Tool error `structuredContent` (`isError=true`):
  - `{ tool: "bash", error: { code: "timeout" | "spawn_error" | "nonzero_exit" | "invalid_cwd", message: string, exit_code?: number }, stdout?: string, stderr?: string, pruning: PruningMetadata }`

Tool: `grep`
- Arguments:
  - `pattern` (required, `string`): Pattern to search for (regex by default).
  - `paths` (required, `string[]`): One or more file/dir paths to search. Each resolved against server root dir; all must stay within root dir.
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

Type: `PruningMetadata`
- `{ attempted: boolean, applied: boolean, fallback: boolean, reason?: "disabled_or_unconfigured" | "no_focus_question" | "too_large" | "output_empty" | "pruner_error", raw_bytes: number, pruned_bytes?: number, pruner_duration_ms?: number, error?: { code: "timeout" | "http_error" | "invalid_response", message: string } }`

### Outbound HTTP (swe-pruner)
The MCP server makes a best-effort HTTP call when pruning is requested.

- **URL**: `JEEVES_PRUNER_ENDPOINT` (full URL, including path)
- **Method**: `POST`
- **Headers**: `Content-Type: application/json`
- **Timeout**: `JEEVES_PRUNER_TIMEOUT_MS` (defaults to a safe value; see **Validation Rules**)
- **Request body**:
  - `{ request_id: string, tool: "read" | "bash" | "grep", focus_question: string, input: string, input_bytes: number, max_output_bytes?: number }`
- **Success response (200)**:
  - `{ output: string, output_bytes: number }`
- **Error responses (any non-2xx, network errors, JSON parse errors)**:
  - Treated as pruning failure; MCP server returns raw output and sets `pruning.fallback=true` with `pruning.error`.

### CLI Commands (if applicable)
| Command | Arguments | Options | Output |
|---------|-----------|---------|--------|
| `jeeves-mcp-pruner` | (none) | `--host <ip>` (default `127.0.0.1`), `--port <n>` (default `0` = ephemeral), `--root <dir>` (default process `cwd`), `--log-format <json|text>` (default `json`) | Starts server; logs readiness and all requests to stdout/stderr |

**Runner → server invocation contract**
- Runner MUST pass `--root` as the run working directory and SHOULD pass `--port 0` unless a fixed port is required.
- Server MUST bind only to loopback by default (`127.0.0.1`) unless explicitly configured.
- Runner determines readiness by polling `GET /healthz` until timeout; it MUST NOT assume readiness based only on a log line.

### Events (if applicable)
Events are emitted as structured log lines (default JSON) on the MCP server stdout. Each event is a single JSON object:
- `{ ts: string, level: "debug" | "info" | "warn" | "error", event: string, request_id?: string, data?: object }`

| Event | Trigger | Payload | Consumers |
|-------|---------|---------|-----------|
| `mcp_pruner.disabled` | Server/runner decides pruning server is not enabled for the run | `{ reason: "config_disabled" \| "config_invalid" \| "start_failed" }` | Runner logs; viewer log stream |
| `mcp_pruner.ready` | Server starts listening and health endpoint is available | `{ host: string, port: number, root: string }` | Runner readiness diagnostics; viewer logs |
| `mcp_pruner.start_failed` | Server process fails before readiness | `{ message: string }` | Runner; viewer logs |
| `mcp_pruner.degraded` | Runner detects server exit/unreachability during a run | `{ reason: "exited" \| "unreachable", exit_code?: number, signal?: string }` | Runner; viewer logs |
| `mcp_pruner.stopped` | Runner shuts down server at end of phase | `{ graceful: boolean, duration_ms: number }` | Runner; viewer logs |
| `tool.request_invalid` | MCP request fails schema validation | `{ tool?: string, field_errors: Array<{ field: string, message: string }> }` | Debugging; viewer logs |
| `tool.exec_failed` | Tool execution fails (IO/spawn/nonzero exit) | `{ tool: string, code: string, message: string, exit_code?: number }` | Debugging; viewer logs |
| `tool.exec_timeout` | Tool execution exceeds timeout | `{ tool: string, timeout_ms: number }` | Debugging; viewer logs |
| `pruner.call_start` | Pruner HTTP call initiated | `{ endpoint: string, tool: string, input_bytes: number }` | Debugging; viewer logs |
| `pruner.call_ok` | Pruner HTTP call succeeded | `{ tool: string, pruner_duration_ms: number, pruned_bytes: number }` | Debugging; viewer logs |
| `pruner.call_failed` | Pruner call failed (timeout/http/invalid response) | `{ tool: string, reason: "timeout" \| "http_error" \| "invalid_response", pruner_duration_ms?: number, message?: string }` | Debugging; viewer logs |

### Validation Rules
| Field | Type | Constraints | Error |
|-------|------|-------------|-------|
| `config.JEEVES_MCP_PRUNER_ENABLED` | boolean (env string) | optional; truthy: `1/true/yes/on`, falsy otherwise | invalid values treated as `false` with `mcp_pruner.config_invalid` |
| `config.JEEVES_MCP_PRUNER_HOST` | string | optional; default `127.0.0.1`; must be a loopback address (`127.0.0.1`/`::1`) | `invalid_host` |
| `config.JEEVES_MCP_PRUNER_PORT` | number (env string) | optional; default `0`; integer `0..65535` | `invalid_port` |
| `config.JEEVES_MCP_PRUNER_ROOT_DIR` | string | optional; default process `cwd`; must exist and be a directory | `invalid_root_dir` |
| `config.JEEVES_PRUNER_ENDPOINT` | string | optional; if set must be a valid absolute URL with `http:` or `https:` | `invalid_pruner_endpoint` |
| `config.JEEVES_PRUNER_TIMEOUT_MS` | number (env string) | optional; default `2000`; integer `100..30000` | `invalid_timeout_ms` |
| `config.JEEVES_MCP_PRUNER_MAX_PRUNE_INPUT_BYTES` | number (env string) | optional; default `262144` (256 KiB); integer `1024..2097152` | `invalid_max_prune_input_bytes` |
| `read.path` | string | required; non-empty; no `\\0`; resolves within root dir; must refer to a regular file | JSON-RPC `-32602` + `field_errors` |
| `read.encoding` | string | optional; must equal `"utf-8"` | JSON-RPC `-32602` |
| `read.context_focus_question` | string | optional; if provided must be non-empty after trim; max 1000 chars | JSON-RPC `-32602` |
| `read.max_output_bytes` | number | optional; integer `1024..10485760` | JSON-RPC `-32602` |
| `bash.cmd` | string | required; non-empty; max 50000 chars | JSON-RPC `-32602` |
| `bash.cwd` | string | optional; resolves within root dir; must exist and be a directory | JSON-RPC `-32602` |
| `bash.env` | object | optional; keys match `/^[A-Z_][A-Z0-9_]*$/`; values max 4000 chars; total entries max 200 | JSON-RPC `-32602` |
| `bash.timeout_ms` | number | optional; integer `100..300000`; default `30000` | JSON-RPC `-32602` |
| `bash.context_focus_question` | string | optional; same constraints as `read.context_focus_question` | JSON-RPC `-32602` |
| `bash.max_output_bytes` | number | optional; integer `1024..10485760` | JSON-RPC `-32602` |
| `grep.pattern` | string | required; non-empty; max 10000 chars | JSON-RPC `-32602` |
| `grep.paths` | string[] | required; length `1..100`; each resolves within root dir | JSON-RPC `-32602` |
| `grep.cwd` | string | optional; same constraints as `bash.cwd` | JSON-RPC `-32602` |
| `grep.fixed_string` | boolean | optional | JSON-RPC `-32602` |
| `grep.case_sensitive` | boolean | optional | JSON-RPC `-32602` |
| `grep.timeout_ms` | number | optional; integer `100..300000`; default `30000` | JSON-RPC `-32602` |
| `grep.max_matches` | number | optional; integer `1..5000`; default `500` | JSON-RPC `-32602` |
| `grep.context_focus_question` | string | optional; same constraints as `read.context_focus_question` | JSON-RPC `-32602` |
| `grep.max_output_bytes` | number | optional; integer `1024..10485760` | JSON-RPC `-32602` |

**Validation failure behavior**
- MCP request validation is **synchronous** (schema/type/range checks) and fails fast with JSON-RPC `error.code=-32602` and `error.data.field_errors`.
- Tool execution and filesystem checks are **asynchronous** and surface as tool-level errors (`result.isError=true`), not JSON-RPC errors.
- Pruner call validation is **asynchronous**; any failure results in `pruning.fallback=true` and raw output returned.

### UI Interactions (if applicable)
| Action | Request | Loading State | Success | Error |
|--------|---------|---------------|---------|-------|
| Start a run (existing viewer) | Existing run start flow; runner may start `@jeeves/mcp-pruner` as a child process | Viewer shows normal run “in progress” states; tool calls appear as they occur | Viewer logs show `mcp:*/*` tool calls when the agent uses the MCP server | Failures are non-fatal to runs; viewer logs show `mcp_pruner.*` events and the run continues without MCP tools |

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
  - HTTP endpoints: `GET /healthz`, `POST /mcp` (JSON-RPC 2.0; methods: `initialize`, `tools/list`, `tools/call`).
  - Tools: `read`, `bash`, `grep` with optional `context_focus_question`, `max_output_bytes`, and `PruningMetadata`.
  - Outbound HTTP contract to pruner: `POST` to `JEEVES_PRUNER_ENDPOINT` with timeout `JEEVES_PRUNER_TIMEOUT_MS`.
- **Data (Section 4)**: N/A (no schema changes, no migrations).

### Planning Gates (Explicit)
**Decomposition Gates**
1. **Smallest independently testable unit**: a single tool handler (e.g., `read`) + its argument validation + its `PruningMetadata` output, verified via unit tests against the `/mcp` JSON-RPC surface.
2. **Dependencies between tasks**: Yes. MCP server skeleton and JSON-RPC plumbing must exist before tool handlers; runner integration depends on server readiness contract; provider wiring depends on runner exposing the MCP endpoint.
3. **Parallelizable tasks**: Yes. After the MCP method plumbing exists, `read`/`bash`/`grep` implementations can be developed in parallel; docs can be done in parallel with implementation once env var names are finalized.

**Task Completeness Gates (applied per-task below)**
4. **Files changed**: Listed explicitly per task.
5. **Acceptance criteria**: Concrete, verifiable criteria per task.
6. **Verification command**: Concrete command per task (targeted vitest run / `pnpm typecheck` / `pnpm lint`).

**Ordering Gates**
7. **Must be done first**: Create the new `packages/mcp-pruner` workspace package and baseline HTTP server (`/healthz`) + CLI contract, so later tasks have a stable target.
8. **Can only be done last**: End-to-end runner/provider wiring (spawn server, inject endpoint into providers) + full-workspace validation (`pnpm typecheck && pnpm lint && pnpm test`).
9. **Circular dependencies**: None expected; enforce a DAG by keeping server implementation in `@jeeves/mcp-pruner` and runner integration in `@jeeves/runner` (runner depends on the server package, not vice versa).

**Infrastructure Gates**
10. **Build/config changes**: Yes. Add a new workspace package `packages/mcp-pruner`, update root `tsconfig.json` references, and add `@jeeves/mcp-pruner` as a dependency of `@jeeves/runner`.
11. **New dependencies**: Prefer **none** (use Node 20 built-ins: `http`, `fetch`, `child_process`). Only add third-party deps if provider MCP wiring requires it.
12. **Env vars / secrets**:
  - Required to enable: `JEEVES_MCP_PRUNER_ENABLED` (truthy values).
  - Optional: `JEEVES_PRUNER_ENDPOINT`, `JEEVES_PRUNER_TIMEOUT_MS`, `JEEVES_MCP_PRUNER_HOST`, `JEEVES_MCP_PRUNER_PORT`, `JEEVES_MCP_PRUNER_MAX_PRUNE_INPUT_BYTES`.
  - No secrets required beyond existing provider API keys (Claude/OpenAI), already handled elsewhere.

### Task Dependency Graph
```
T1 (no deps)
T2 → depends on T1
T3 → depends on T2
T4 → depends on T3
T5 → depends on T3
T6 → depends on T3
T7 → depends on T4, T5, T6
T8 → depends on T1
T9 → depends on T8
T10 → depends on T7, T9
```

### Task Breakdown
| ID | Title | Summary | Files | Acceptance Criteria |
|----|-------|---------|-------|---------------------|
| T1 | Scaffold MCP pruner package | Add `@jeeves/mcp-pruner` workspace package with CLI and `/healthz`. | `packages/mcp-pruner/package.json` | `pnpm typecheck` includes the new package and `GET /healthz` returns `ok:true` with server info. |
| T2 | Implement `/mcp` + MCP methods | Add JSON-RPC parsing/dispatch and MCP methods `initialize` + `tools/list`. | `packages/mcp-pruner/src/server.ts` | `POST /mcp` supports `initialize` and `tools/list` and returns JSON-RPC errors for invalid requests. |
| T3 | Add validation + shared utils | Implement argument validation, `field_errors`, root path confinement, and byte truncation helpers. | `packages/mcp-pruner/src/validate.ts` | Invalid params return `-32602` with `field_errors`; paths/cwd cannot escape `--root`. |
| T4 | Add `read` tool | Implement `tools/call` for `read` including structured outputs and tool errors. | `packages/mcp-pruner/src/tools/read.ts` | Reads succeed within root; invalid/not-found paths yield tool errors; `max_output_bytes` truncation works. |
| T5 | Add `bash` tool | Implement `bash` execution with timeouts, cwd confinement, env sanitization, and structured output. | `packages/mcp-pruner/src/tools/bash.ts` | Captures stdout/stderr/exit; timeouts return tool error; cwd outside root is rejected. |
| T6 | Add `grep` tool | Implement `grep` using `rg` (or fallback) with match parsing and limits. | `packages/mcp-pruner/src/tools/grep.ts` | Returns structured matches with `max_matches`; invalid paths rejected; timeout handled. |
| T7 | Add pruning pipeline | Add swe-pruner HTTP client and integrate optional pruning for all tools with `PruningMetadata` + fallback. | `packages/mcp-pruner/src/pruner.ts` | When `context_focus_question` set and pruner configured, attempted pruning is reflected in metadata; failures fall back to raw output with `fallback=true`. |
| T8 | Runner lifecycle integration | Spawn/stop the MCP server per phase; poll `/healthz`; degrade on failure without failing the run. | `packages/runner/src/mcpPruner.ts` | With enable=false, no server spawn; with enable=true, server is started and stopped; failures continue the run in degraded/disabled mode. |
| T9 | Provider wiring (Claude + Codex) | Pass the MCP endpoint into both providers so agents can call `mcp:*` tools. | `packages/runner/src/providers/codexSdk.ts` | Codex and Claude providers can be configured to use the local MCP server endpoint when enabled. |
| T10 | Docs + full validation | Document env vars, CLI usage, and run integration; ensure `pnpm lint/typecheck/test` passes. | `README.md` | Docs describe how to enable and verify pruning; all quality commands pass. |

### Task Details

**T1: Scaffold MCP pruner package**
- Summary: Create the new `packages/mcp-pruner` package with a CLI `jeeves-mcp-pruner` that starts an HTTP server and responds to `GET /healthz`.
- Files:
  - `tsconfig.json` - add project reference to `./packages/mcp-pruner`.
  - `packages/mcp-pruner/package.json` - new workspace package + bin entry.
  - `packages/mcp-pruner/tsconfig.json` - new composite TS project.
  - `packages/mcp-pruner/src/bin.ts` - CLI arg parsing (`--host`, `--port`, `--root`, `--log-format`) and server startup.
  - `packages/mcp-pruner/src/server.ts` - minimal HTTP server with `/healthz`.
  - `packages/mcp-pruner/src/server.test.ts` - health check test (bind to ephemeral port, assert response shape).
- Acceptance Criteria:
  1. Running the CLI starts a server bound to loopback and `GET /healthz` returns `{ ok: true, status: "ok", server: { name, version }, time: { started_at, uptime_ms } }`.
  2. Root `tsconfig.json` includes the new package so `pnpm typecheck` builds it.
- Dependencies: None
- Verification: `pnpm typecheck && pnpm test packages/mcp-pruner/src/server.test.ts`

**T2: Implement `/mcp` + MCP methods**
- Summary: Add `POST /mcp` JSON-RPC 2.0 parsing and MCP methods `initialize` and `tools/list`, matching the contract in Section 3.
- Files:
  - `packages/mcp-pruner/src/server.ts` - add `/mcp` route + JSON-RPC dispatcher.
  - `packages/mcp-pruner/src/mcp.ts` - JSON-RPC types + method handlers (`initialize`, `tools/list`).
  - `packages/mcp-pruner/src/mcp.test.ts` - tests for success responses + JSON-RPC error codes (`-32700`, `-32600`, `-32601`, `-32602`, `-32603`).
- Acceptance Criteria:
  1. `initialize` returns `serverInfo.name="@jeeves/mcp-pruner"` and `jeeves.schemaVersion=1`.
  2. `tools/list` returns exactly `read`, `bash`, `grep` with JSONSchema `inputSchema`.
  3. Invalid JSON and invalid params yield the correct JSON-RPC errors (no tool execution).
- Dependencies: T1
- Verification: `pnpm test packages/mcp-pruner/src/mcp.test.ts`

**T3: Add validation + shared utils**
- Summary: Implement reusable validation and safety utilities: `field_errors` formatting, root path/cwd confinement, and UTF-8 byte truncation.
- Files:
  - `packages/mcp-pruner/src/validate.ts` - validators for env/config and tool args; helper to build `-32602` responses.
  - `packages/mcp-pruner/src/pathSafety.ts` - `resolveWithinRoot(root, inputPath)` helpers for `read.path`, `bash.cwd`, `grep.paths`.
  - `packages/mcp-pruner/src/truncate.ts` - `truncateUtf8Bytes` used for `max_output_bytes` behavior.
  - `packages/mcp-pruner/src/validate.test.ts` - unit tests for key validation rules.
- Acceptance Criteria:
  1. Any tool arg validation failure produces JSON-RPC `-32602` with `error.data.field_errors` entries that name the failing field.
  2. Path traversal attempts (e.g. `../..`) are rejected and never reach filesystem/subprocess execution.
  3. `max_output_bytes` caps raw output prior to pruning eligibility evaluation.
- Dependencies: T2
- Verification: `pnpm test packages/mcp-pruner/src/validate.test.ts`

**T4: Add `read` tool**
- Summary: Implement `tools/call` for `read` including `structuredContent` and tool-level errors (`result.isError=true`).
- Files:
  - `packages/mcp-pruner/src/tools/read.ts` - file read implementation + structured output shape.
  - `packages/mcp-pruner/src/mcp.ts` - dispatch `tools/call` to `read`.
  - `packages/mcp-pruner/src/tools/read.test.ts` - tests for success, not found, invalid path, and truncation.
- Acceptance Criteria:
  1. `read` succeeds for files under root and returns `structuredContent.tool="read"` with `content`, `bytes`, and `duration_ms`.
  2. Invalid paths and missing files return tool errors with codes `invalid_path` / `not_found` and do not crash the server.
- Dependencies: T3
- Verification: `pnpm test packages/mcp-pruner/src/tools/read.test.ts`

**T5: Add `bash` tool**
- Summary: Implement `bash` execution with `timeout_ms`, cwd confinement, env sanitization, and structured output.
- Files:
  - `packages/mcp-pruner/src/tools/bash.ts` - spawn wrapper with timeout and capture.
  - `packages/mcp-pruner/src/mcp.ts` - dispatch `tools/call` to `bash`.
  - `packages/mcp-pruner/src/tools/bash.test.ts` - tests for successful command, non-zero exit, and timeout.
- Acceptance Criteria:
  1. `bash` returns `stdout`, `stderr`, `exit_code`, `timed_out`, `duration_ms`, and `pruning` metadata.
  2. Timeouts kill the subprocess and return a tool error with `code="timeout"`.
  3. `cwd` is rejected if it resolves outside root.
- Dependencies: T3
- Verification: `pnpm test packages/mcp-pruner/src/tools/bash.test.ts`

**T6: Add `grep` tool**
- Summary: Implement `grep` search using `rg` (preferred) with match parsing and limits; provide a deterministic fallback if `rg` is unavailable.
- Files:
  - `packages/mcp-pruner/src/tools/grep.ts` - search implementation + parsing into `{ path, line, column, text }`.
  - `packages/mcp-pruner/src/mcp.ts` - dispatch `tools/call` to `grep`.
  - `packages/mcp-pruner/src/tools/grep.test.ts` - tests using a temp directory with fixture files.
- Acceptance Criteria:
  1. `grep` returns `matches[]` and `match_count`, respects `max_matches`, and does not return paths outside root.
  2. Tool errors include `rg_error`/`timeout`/`invalid_path` with `exit_code` when applicable.
- Dependencies: T3
- Verification: `pnpm test packages/mcp-pruner/src/tools/grep.test.ts`

**T7: Add pruning pipeline**
- Summary: Add the optional pruning path for tool outputs when `context_focus_question` is provided and pruner config is valid; implement safe fallback behavior for all failures.
- Files:
  - `packages/mcp-pruner/src/pruner.ts` - HTTP client for `JEEVES_PRUNER_ENDPOINT` + timeout and response validation.
  - `packages/mcp-pruner/src/mcp.ts` - integrate pruning decision and enrich responses with `PruningMetadata`.
  - `packages/mcp-pruner/src/pruner.test.ts` - tests with a local mock HTTP server for success + timeout + non-2xx + invalid JSON.
- Acceptance Criteria:
  1. When `context_focus_question` is absent/empty, pruning is not attempted and metadata indicates `attempted=false` with `reason="no_focus_question"`.
  2. When pruning is attempted and succeeds, tool result content is replaced with pruned output and metadata indicates `applied=true` with `pruned_bytes`.
  3. On any pruner failure (timeout/non-2xx/invalid response), raw output is returned and metadata indicates `fallback=true` with `reason="pruner_error"` and `error.code`.
- Dependencies: T4, T5, T6
- Verification: `pnpm test packages/mcp-pruner/src/pruner.test.ts`

**T8: Runner lifecycle integration**
- Summary: Integrate the server into the runner lifecycle: start the MCP server as a child process per run phase, poll readiness via `/healthz`, and stop it during shutdown. Failures must degrade/disable MCP without failing the run.
- Files:
  - `packages/runner/package.json` - add dependency on `@jeeves/mcp-pruner` so the runner can resolve its CLI entry.
  - `packages/runner/src/mcpPruner.ts` - lifecycle manager (spawn, parse ready event to learn port when `--port 0`, health polling, shutdown).
  - `packages/runner/src/runner.ts` - wrap `provider.run(...)` with start/stop hooks.
  - `packages/runner/src/mcpPruner.test.ts` - unit tests using a fake child process / stubbed fetch for readiness.
- Acceptance Criteria:
  1. When `JEEVES_MCP_PRUNER_ENABLED` is falsy, the runner does not spawn the server and runs behave as before.
  2. When enabled and the server starts, the runner waits for `/healthz` success before advertising the MCP endpoint to providers.
  3. If startup fails or the server exits mid-run, the runner logs a degraded/disabled event and the run continues (no hard failure).
- Dependencies: T1
- Verification: `pnpm test packages/runner/src/mcpPruner.test.ts`

**T9: Provider wiring (Claude + Codex)**
- Summary: Pass the MCP server endpoint to both providers so tool invocations flow through the MCP server when enabled.
- Files:
  - `packages/runner/src/provider.ts` - (if needed) extend `ProviderRunOptions` to include MCP server connection info.
  - `packages/runner/src/providers/claudeAgentSdk.ts` - configure Claude Agent SDK to use the MCP server (per SDK-supported config).
  - `packages/runner/src/providers/codexSdk.ts` - pass MCP server config to the Codex CLI invocation (flags/env/config as supported by Codex).
  - `packages/runner/src/providers/*.test.ts` - unit tests asserting the provider is configured with the MCP endpoint when present.
- Acceptance Criteria:
  1. When MCP is enabled, providers are given the MCP base URL and can emit `tool_use` events named `mcp:*/*` when the agent calls MCP tools.
  2. When MCP is disabled/degraded, providers run without MCP configuration and continue successfully.
- Dependencies: T8
- Verification: `pnpm test packages/runner/src/providers/codexSdk.test.ts`

**T10: Docs + full validation**
- Summary: Document configuration and developer workflow, then run full repo checks.
- Files:
  - `README.md` - add a “Context-pruning MCP server” section describing env vars, starting the server, and how to verify it.
  - `packages/mcp-pruner/README.md` - usage, endpoints, and tool contracts (brief; link to design doc).
- Acceptance Criteria:
  1. Docs include all env vars from Section 3 “Validation Rules” and a minimal example of `tools/call` with `context_focus_question`.
  2. Repo quality commands pass: lint, typecheck, and tests.
- Dependencies: T7, T9
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
- [ ] New tests added for: `packages/mcp-pruner/src/server.test.ts`, `packages/mcp-pruner/src/mcp.test.ts`, `packages/mcp-pruner/src/validate.test.ts`, `packages/mcp-pruner/src/tools/read.test.ts`, `packages/mcp-pruner/src/tools/bash.test.ts`, `packages/mcp-pruner/src/tools/grep.test.ts`, `packages/mcp-pruner/src/pruner.test.ts`, `packages/runner/src/mcpPruner.test.ts`

### Manual Verification (if applicable)
- [ ] Start the viewer-server and run a workflow with MCP enabled:
  - `pnpm dev` (in another terminal)
  - Set env `JEEVES_MCP_PRUNER_ENABLED=true` for the viewer-server process
  - Start a run; confirm viewer logs include `mcp_pruner.ready` and subsequent `mcp:*/*` tool calls when the agent uses `read`/`bash`/`grep` with `context_focus_question`.
