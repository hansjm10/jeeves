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
- **In scope**: New `packages/mcp-pruner` package, MCP tool schemas/contracts for `read`/`bash`/`grep` with optional pruning, runner/provider wiring so both Claude and Codex runs can access the MCP server, and issue-required documentation updates in `packages/mcp-pruner/CLAUDE.md` and `packages/runner/CLAUDE.md`.
- **Out of scope**: Swe-pruner service lifecycle management, persistent per-issue pruning settings, viewer UI/UX work, and broader security hardening beyond existing “trusted local automation” assumptions.
- **Transport choice (issue-prescribed)**: Implement the MCP server using `@modelcontextprotocol/sdk` with `StdioServerTransport` (stdio). Providers spawn the MCP server via `{ command, args, env }` config.
- **Tool schema scope (issue-prescribed)**: Tool schemas are a strict match to the issue examples (minimal args + optional `context_focus_question`, text-only outputs). No additional tool arguments or structured/metadata outputs are in scope.
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
- **Transition triggers & side effects**: Each transition’s condition and side effects are fully specified in the **Transitions** table (process management and diagnostic logging).
- **Reversibility**: Transitions are **not reversible** within a run/request. “Undo” happens only by starting a new run (runner lifecycle) or issuing a new request (tool pipeline).
- **Global vs per-state errors**: Per-state errors are listed in **Error Handling**; for states not called out explicitly, the only error path is the global per-request handler (`req:* -> req:internal_error`).
- **Crash recovery**: Fully specified under **Crash Recovery** (detection signals, recovery state selection, and cleanup steps).
- **MCP server process ownership & shutdown**: The **provider** exclusively owns the `@jeeves/mcp-pruner` child process lifecycle (spawn, monitor, terminate). The runner never tracks PIDs or sends signals directly. On provider phase end (success/failure/cancel), the provider MUST terminate the MCP server process best-effort (`SIGTERM`, wait `2000ms`, then `SIGKILL`) and close stdio streams before returning control to the runner.
- **Subprocess contract**: Inputs, writable surface, and failure handling for each subprocess are specified in **Subprocesses**. Subprocess results are collected as `(stdout, stderr, exit_code, duration_ms)` and then optionally transformed by pruning; the final response returns either raw or pruned tool output.

### States
| State | Description | Entry Condition |
|-------|-------------|-----------------|
| `run:init` | Runner loads config and decides whether to enable the MCP pruner server for this run. | A workflow run begins (provider about to start a phase). |
| `run:mcp_pruner_disabled` | MCP pruner server is not configured for this run; agents use provider-native tools only. | `JEEVES_PRUNER_ENABLED=false`, or runner cannot build a valid `mcpServers` config. |
| `run:mcp_pruner_starting` | Provider starts `@jeeves/mcp-pruner` as a stdio MCP server using runner-provided `{ command, args, env }` config. | `run:init` decides MCP pruner is enabled and injects `mcpServers`. |
| `run:mcp_pruner_running` | MCP pruner server is available to the agent (provider successfully spawned/connected). | Provider successfully initializes MCP servers for the run. |
| `run:mcp_pruner_degraded` | MCP pruner was enabled but is now unavailable; it is disabled for the remainder of this run. | Provider reports MCP server failure after successful startup (unexpected exit or runtime unavailability). |
| `run:shutdown` | Runner ends the provider phase and releases resources. | The provider phase ends (success, failure, or cancel). |
| `req:received` | MCP server accepts an incoming tool request and assigns `request_id`. | A client connects and submits an MCP request. |
| `req:validating` | MCP server validates tool name and arguments, applies defaults, and normalizes inputs. | `req:received` begins processing. |
| `req:invalid_request` | MCP server rejects the request with a client error; no tool execution occurs. **Terminal (per-request).** | Validation fails (schema/type rules). |
| `req:executing_tool` | MCP server executes the underlying operation (`read` file, run `bash`, or run `grep`). | `req:validating` succeeds. |
| `req:tool_error` | Underlying tool operation fails; MCP server returns an **error text** in a normal tool response. **Terminal (per-request).** | Tool execution fails (e.g., file read error, subprocess spawn error, `grep` exit code 2). |
| `req:raw_output_ready` | Raw (unpruned) tool output is available in memory. | `req:executing_tool` completes successfully. |
| `req:prune_check` | MCP server decides whether pruning will be attempted. | `req:raw_output_ready` completes. |
| `req:calling_pruner` | MCP server calls the configured HTTP pruner endpoint with raw output + `context_focus_question`. | `req:prune_check` determines pruning is eligible. |
| `req:pruner_error_fallback` | Pruner call failed; MCP server falls back to returning raw output. | Pruner times out, returns non-2xx, or returns an invalid payload. |
| `req:respond_raw` | MCP server formats and returns raw output. | Pruning is not attempted or pruning failed. |
| `req:respond_pruned` | MCP server formats and returns pruned output. | Pruner returns a valid pruned result. |
| `req:responded` | MCP response has been successfully written and the request is complete. **Terminal (per-request).** | `req:respond_raw` or `req:respond_pruned` finishes writing. |
| `req:internal_error` | Unexpected server error; MCP server returns an internal error response. **Terminal (per-request).** | An unhandled exception occurs at any request state. |

### Transitions
| From | Event/Condition | To | Side Effects |
|------|-----------------|-----|--------------|
| `run:init` | `JEEVES_PRUNER_ENABLED=false` | `run:mcp_pruner_disabled` | Write a diagnostic log message (pruner disabled by config). |
| `run:init` | `JEEVES_PRUNER_ENABLED=true` and MCP config resolves | `run:mcp_pruner_starting` | Build `mcpServers` config and pass it to the provider (provider owns spawn/connect). |
| `run:init` | `JEEVES_PRUNER_ENABLED=true` and MCP config/path resolution fails | `run:mcp_pruner_disabled` | Write a diagnostic log message (enabled but config invalid / path resolution failed); continue run without MCP. |
| `run:mcp_pruner_starting` | Provider successfully initializes MCP servers | `run:mcp_pruner_running` | Write a diagnostic log message (pruner available). |
| `run:mcp_pruner_starting` | Provider fails to spawn/connect MCP server | `run:mcp_pruner_disabled` | Write a diagnostic log message (spawn/connect failed); continue run without MCP. |
| `run:mcp_pruner_running` | Provider reports MCP server failure during run | `run:mcp_pruner_degraded` | Write a diagnostic log message (server failure); continue run without MCP. |
| `run:mcp_pruner_running` | Provider phase ends (success/fail/cancel) | `run:shutdown` | Provider terminates the MCP server best-effort (`SIGTERM` → wait `2000ms` → `SIGKILL`) and closes stdio streams; runner only logs. |
| `run:mcp_pruner_disabled` | Provider phase ends | `run:shutdown` | No-op aside from a diagnostic log message (pruner not running). |
| `run:mcp_pruner_degraded` | Provider phase ends | `run:shutdown` | If the provider still has a live MCP server handle, it terminates it best-effort (`SIGTERM` → wait `2000ms` → `SIGKILL`) and closes stdio streams; runner only logs. |
| `req:received` | Request accepted | `req:validating` | Assign `request_id`; write a diagnostic log message. |
| `req:validating` | Arguments invalid for tool schema | `req:invalid_request` | Return MCP client error; write a diagnostic log message. |
| `req:validating` | Arguments valid | `req:executing_tool` | Normalize args (defaults); write a diagnostic log message. |
| `req:executing_tool` | Underlying operation fails (file read error, subprocess spawn error, or `grep` exit code 2) | `req:tool_error` | Return tool error; write a diagnostic log message. |
| `req:executing_tool` | Underlying operation succeeds | `req:raw_output_ready` | Capture raw output; write a diagnostic log message. |
| `req:raw_output_ready` | Raw output captured | `req:prune_check` | Determine pruning eligibility. |
| `req:prune_check` | No `context_focus_question` provided | `req:respond_raw` | Skip pruning and return raw output. |
| `req:prune_check` | Pruning disabled or pruner URL disabled (`PRUNER_URL` empty) | `req:respond_raw` | Skip pruning and return raw output. |
| `req:prune_check` | `context_focus_question` provided and tool-specific pruning rules allow | `req:calling_pruner` | Call the pruner endpoint (best-effort); write a diagnostic log message. |
| `req:calling_pruner` | HTTP 200 + valid pruned payload | `req:respond_pruned` | Return pruned output. |
| `req:calling_pruner` | Timeout, network error, non-2xx, or invalid payload | `req:pruner_error_fallback` | Write a diagnostic log message; fall back to raw output. |
| `req:pruner_error_fallback` | Fallback chosen | `req:respond_raw` | Return raw output. |
| `req:respond_raw` | Response serialized and written | `req:responded` | Return raw output. |
| `req:respond_pruned` | Response serialized and written | `req:responded` | Return pruned output. |
| `req:*` | Unhandled exception anywhere in pipeline | `req:internal_error` | Return MCP internal error; write a diagnostic log message. |

### Error Handling
| State | Error | Recovery State | Actions |
|-------|-------|----------------|---------|
| `run:init` | Invalid env/config values | `run:mcp_pruner_disabled` | Write a diagnostic log message; continue run without MCP pruner. |
| `run:mcp_pruner_starting` | Provider fails to spawn/connect MCP server | `run:mcp_pruner_disabled` | Write a diagnostic log message; continue run without MCP pruner. |
| `run:mcp_pruner_running` | Provider reports MCP server failure during run | `run:mcp_pruner_degraded` | Write a diagnostic log message; continue run without MCP pruner. |
| `req:received` | Request body parse error | `req:invalid_request` | Return MCP client error; write a diagnostic log message. |
| `req:validating` | Schema/type validation errors | `req:invalid_request` | Return MCP client error with field errors; write a diagnostic log message. |
| `req:executing_tool` | File read error (ENOENT, EACCES) | `req:tool_error` | Return tool error; write a diagnostic log message. |
| `req:executing_tool` | Subprocess spawn error, or `grep` exit code 2 | `req:tool_error` | Return tool error; write a diagnostic log message. |
| `req:calling_pruner` | Pruner timeout | `req:pruner_error_fallback` | Write a diagnostic log message and fall back to raw output. |
| `req:calling_pruner` | Pruner non-2xx / network error | `req:pruner_error_fallback` | Write a diagnostic log message and fall back to raw output. |
| `req:calling_pruner` | Invalid pruner response | `req:pruner_error_fallback` | Write a diagnostic log message and fall back to raw output. |
| `req:respond_raw` / `req:respond_pruned` | Response serialization/write error | `req:internal_error` | Write a diagnostic log message; close connection. |
| `req:*` | Any unhandled exception | `req:internal_error` | Write a diagnostic log message; return MCP internal error. |

### Crash Recovery
- **Detection**:
  - Runner: detects MCP failures via provider-reported spawn/connect errors or tool-call failures.
  - Server: detects client disconnects via socket close; treats subprocess failures as tool errors.
- **Recovery state**:
  - Within the same run:
    - Spawn/connect failure during `run:mcp_pruner_starting` -> `run:mcp_pruner_disabled`.
    - Failure after successful startup (`run:mcp_pruner_running`) -> `run:mcp_pruner_degraded`.
    - In both cases, the run continues with MCP pruner tools unavailable.
  - On a subsequent run (fresh process): runner always restarts from `run:init` and attempts `run:mcp_pruner_starting` again if enabled.
  - Per-request: client retries by issuing a new MCP request (new `request_id`); there is no in-request replay after a process crash.
- **Cleanup**:
  - Runner: stop injecting MCP config for subsequent runs if disabled; provider owns MCP server child lifecycle for the current run.
  - Server: drop in-memory raw output buffers for aborted requests. (No execution timeout is enforced for `bash`/`grep`; subprocesses run until completion or until the `mcp-pruner` process is terminated.)

### Subprocesses (if applicable)
Execution timeouts:
- `bash`/`grep`: none (no server-enforced timeout; subprocesses run until completion or until the `mcp-pruner` process is terminated by the provider at phase end).

| Subprocess | Receives | Can Write | Failure Handling |
|------------|----------|-----------|------------------|
| `@jeeves/mcp-pruner` (server) | Run config via env (`PRUNER_URL`, `PRUNER_TIMEOUT_MS`, `MCP_PRUNER_CWD`). | Writes logs to stderr only; stdout is reserved for MCP protocol. | Provider spawn/connect failure -> `run:mcp_pruner_disabled`; unexpected exit during run -> `run:mcp_pruner_degraded`. |
| `bash` tool command | `command` (runs with `cwd=MCP_PRUNER_CWD`). | May write to filesystem as a normal shell command would (trusted local automation). | Exit code is surfaced in the **tool output text** (see Section 3). Non-zero exit is **not** a tool error (it still transitions to `req:raw_output_ready` and follows the normal prune-check path). Spawn error transitions to `req:tool_error` and returns `Error executing command: <message>` as tool output text. |
| `grep` tool command (`grep`) | `pattern`, optional `path` (defaults to `"."`). | None (read-only scan), aside from process stdout/stderr. | Exit code `0` (matches) -> stdout; `1` (no matches) -> success with `"(no matches found)"`; exit code `2` -> `req:tool_error` and returns `Error: <stderr>` as tool output text. |

## 3. Interfaces

This feature adds a new local MCP server (`@jeeves/mcp-pruner`) and a new opt-in request parameter (`context_focus_question`) on its tools. It also defines an outbound HTTP contract to a configured `swe-pruner` service.

### Transport (stdio; issue-prescribed)
The MCP server is implemented using `@modelcontextprotocol/sdk` (`McpServer` + `StdioServerTransport`) and communicates over stdio. There is no HTTP `/mcp` endpoint and no `/healthz`.

### MCP Methods
All MCP requests are JSON-RPC 2.0 objects (over stdio):
- Request: `{ jsonrpc: "2.0", id: string | number, method: string, params?: object }`
- Response (success): `{ jsonrpc: "2.0", id: string | number, result: object }`
- Response (error): `{ jsonrpc: "2.0", id: string | number | null, error: { code: number, message: string, data?: object } }`
 
Tool input validation uses issue-aligned `zod` schemas. Validation failures return JSON-RPC `-32602` with `error.message="Invalid params"` (exact string). Any additional `error.data` is SDK-defined and not treated as a stable public contract.

Supported methods:
| MCP Method | Invocation Pattern | Params | Result | Errors |
|-----------|--------------------|--------|--------|--------|
| `initialize` | JSON-RPC request | `{ protocolVersion: string, clientInfo?: { name: string, version?: string }, capabilities?: object }` | `{ protocolVersion: string, serverInfo: { name: "mcp-pruner", version: "1.0.0" }, capabilities: { tools: { listChanged?: false } } }` | JSON-RPC `-32602` if required fields missing/invalid |
| `tools/list` | JSON-RPC request | `{}` or omitted | `{ tools: Array<{ name: "read" | "bash" | "grep", description: string, inputSchema: JSONSchema }> }` | JSON-RPC `-32601` for unknown method; `-32602` for invalid params |
| `tools/call` | JSON-RPC request | `{ name: "read" | "bash" | "grep", arguments: object }` | `{ content: Array<{ type: "text", text: string }> }` | JSON-RPC `-32602` invalid params; tool execution failures return a normal tool result with an error string in `content[0].text` |

### MCP Tools (issue-aligned)
Tool schemas are a **strict match** to the GitHub issue examples:
- Only `read.file_path`, `bash.command`, `grep.pattern` + optional `grep.path`
- `context_focus_question` is optional for all tools
- No additional tool arguments (timeouts, output limits, path lists, flags, etc.)
- No structured/metadata outputs are part of the public contract

All tools return `result.content` with a single `{ type: "text", text: string }` item. `result.isError` is **not set** (omitted), including on failures; errors are represented as specific strings in `content[0].text` as described below. Parameter validation failures are JSON-RPC `-32602` (invalid params).

**Common field**
- `context_focus_question` (optional, `string`): If provided and truthy, triggers a best-effort prune request using the tool’s pruning-candidate text as `code` and the question value as `query` (passed verbatim), subject to the per-tool pruning rules below (e.g., `read` does not prune its error string; empty file content is still eligible; `bash` does not prune the `(no output)` placeholder).

Tool: `read`
- Arguments:
  - `file_path` (required, `string`): Absolute or relative path to the file to read (see **Tool argument validation**).
  - `context_focus_question` (optional, `string`).
- Output text:
  - Success: raw file contents (UTF-8), or pruned contents when pruning succeeds.
  - Failure (file read error): `Error reading file: <fs error message>` (exact prefix).
  - Pruning eligibility: when `context_focus_question` is provided and truthy, pruning is attempted even if the file contents are the empty string (`""`). Pruning is **not** attempted for the file-read error string (issue example returns early).

Tool: `bash`
- Arguments:
  - `command` (required, `string`): Shell command to run.
  - `context_focus_question` (optional, `string`).
- Output text (issue-aligned; exact markers):
  - Assemble an `output` string as:
    - Start with captured `stdout` (may be empty).
    - If `stderr` is non-empty, append `\\n[stderr]\\n` + captured `stderr`.
    - If `exit_code !== 0` (including `null`), append `\\n[exit code: <exit_code>]`.
  - If the assembled `output` is empty, return `(no output)` (exact string).
  - Spawn error: `Error executing command: <error.message>` (exact prefix).
  - Pruning eligibility: when `context_focus_question` is provided and truthy, pruning is attempted on the assembled `output` **before** the `(no output)` fallback. This matches the issue example: `(no output)` is never pruned. Pruning is not attempted for the spawn-error string.

Tool: `grep`
- Arguments:
  - `pattern` (required, `string`): Pattern to search for (regex).
  - `path` (optional, `string`): File/dir path to search. Defaults to `"."` (see **Tool argument validation**).
  - `context_focus_question` (optional, `string`).
- Output text: line-oriented search results (e.g., `path:line:match`), as produced by the underlying engine.

**Execution strategy (issue-aligned)**
- Command: `grep -rn --color=never <pattern> <path>` where `<path> = arguments.path ?? "."`
- Exit-code handling:
  - `0` (matches): return `stdout` verbatim
  - `1` (no matches): return `(no matches found)` (exact string)
  - `2` (error): if `stderr` is non-empty return `Error: <stderr>` (exact prefix); otherwise fall back to `stdout || "(no matches found)"`
- Spawn error: `Error executing grep: <error.message>` (exact prefix)
- Pruning eligibility: only when `context_focus_question` is provided and truthy **and** `stdout` is non-empty. `(no matches found)` and error strings are never pruned (including when `stdout` is `""`).

### Outbound HTTP (swe-pruner)
The MCP server makes a best-effort HTTP call when a tool’s pruning eligibility conditions are met and pruning is enabled (`PRUNER_URL` is set and non-empty).

- **URL**: `PRUNER_URL` (full URL, including path)
- **Method**: `POST`
- **Headers**: `Content-Type: application/json`
- **Timeout**: `PRUNER_TIMEOUT_MS` (defaults to a safe value; see **Validation Rules**)
- **Request body (issue-aligned)**: `{ code: string, query: string }`
  - `code` is the tool’s pruning-candidate text prior to pruning (per-tool rules above; e.g., `bash` uses the assembled `output` before the `(no output)` fallback).
  - `query = context_focus_question` (passed verbatim; no trimming)
- **Success response (200)**:
  - Response MUST be JSON, and the pruned text is read from the first string field present in this order: `pruned_code`, then `content`, then `text`.
  - If none of these fields is present as a string, treat as `invalid_response`.
- **Applying the pruned text**: replace the tool output text with the pruned text.
- **Error mapping**: timeout/network/non-2xx/invalid response all return the raw tool output text (best-effort fallback).

### CLI Commands (if applicable)
| Command | Arguments | Options | Output |
|---------|-----------|---------|--------|
| `mcp-pruner` | (none) | (none; configured via env) | Starts an MCP stdio server; logs to stderr |

**Provider → server invocation contract**
- Providers spawn the server using a `ProviderRunOptions.mcpServers` entry shaped like `{ command, args, env }` and connect over stdio.
- The `mcp-pruner` process MUST keep stdout reserved for MCP protocol messages; all diagnostics go to stderr.

### Diagnostics & Logging
This design does not introduce a new cross-component structured “event” contract. Diagnostics are conventional logs:
- `@jeeves/mcp-pruner` writes diagnostics to stderr (stdout reserved for MCP protocol).
- Runner/provider diagnostics (including whether MCP servers were injected/spawned) are emitted by the runner/provider processes themselves.

The viewer already captures run logs for both Claude and Codex runs, including stderr/stdout from spawned processes, so no additional forwarding mechanism is required.

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
| `PRUNER_URL` | string | optional; default `http://localhost:8000/prune`; empty string disables pruning | Used for outbound HTTP to `swe-pruner`. If empty, pruning is skipped and tools return raw output. When spawned by the Jeeves runner (and enabled), this env var is always set explicitly (default or empty). |
| `PRUNER_TIMEOUT_MS` | number (env string) | optional; default `30000`; integer `100..300000` | Timeout for the outbound pruner call (ms). Parse as an integer. If missing or invalid (NaN), use `30000` and log a warning to stderr. If out of range, clamp to `100..300000` and log a warning. |
| `MCP_PRUNER_CWD` | string | optional; default process `cwd` | Working directory for `bash`/`grep` and the base path for resolving relative `read.file_path`. **No sandbox/containment is enforced**; absolute paths are accepted as-is (issue examples). |

**Precedence**
- Runner env vars determine whether MCP is injected and what env is passed to the provider-spawned server.
- Server env vars are set via the spawned process environment (from runner/provider wiring).

**Default `mcp-pruner` path resolution (when `JEEVES_MCP_PRUNER_PATH` is unset)**
To reliably support both monorepo workspace runs and installed-package usage, `@jeeves/runner` resolves the stdio server JS entrypoint with the following ordered algorithm:
1. `require.resolve("@jeeves/mcp-pruner/dist/index.js")` (works when the package is resolvable from the runner bundle).
2. Fallback to workspace dist layout: `path.resolve(__dirname, "../../mcp-pruner/dist/index.js")` (relative to `packages/runner/dist/*` at runtime).
3. If neither exists/readable, treat the pruner config as invalid for the run and do not inject `mcpServers`.

**Tool argument validation (MCP request params)**
Tool argument validation is intentionally minimal and issue-aligned: schemas validate **types only** (required vs optional strings). The server does not enforce additional constraints (no sandboxing/containment, no trimming, no max lengths).

Path semantics:
- `read.file_path`: if absolute, use as-is; if relative, resolve against `MCP_PRUNER_CWD` via `path.resolve(cwd, file_path)`.
- `grep.path`: passed to `grep` as provided (default `"."`); relative paths are interpreted by `grep` relative to `cwd=MCP_PRUNER_CWD`.

| Field | Type | Constraints | Error |
|-------|------|-------------|-------|
| `read.file_path` | string | required | JSON-RPC `-32602` (invalid type / missing) |
| `read.context_focus_question` | string | optional | JSON-RPC `-32602` (invalid type) |
| `bash.command` | string | required | JSON-RPC `-32602` (invalid type / missing) |
| `bash.context_focus_question` | string | optional | JSON-RPC `-32602` (invalid type) |
| `grep.pattern` | string | required | JSON-RPC `-32602` (invalid type / missing) |
| `grep.path` | string | optional | JSON-RPC `-32602` (invalid type) |
| `grep.context_focus_question` | string | optional | JSON-RPC `-32602` (invalid type) |

**Validation failure behavior**
- MCP request validation is **synchronous** (schema/type checks) and fails fast with JSON-RPC `error.code=-32602` and `error.message="Invalid params"`.
- Tool execution and filesystem errors are surfaced as **error text** in a normal tool response (no `result.isError`).
- Pruner call failures return raw output (best-effort fallback).

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
| Start a run (existing viewer) | Existing run start flow; runner injects `mcpServers` config and providers spawn `@jeeves/mcp-pruner` via stdio | Viewer shows normal run “in progress” states; tool calls appear as they occur | Viewer logs show `mcp:*/*` tool calls when the agent uses the MCP server | Failures are non-fatal to runs; viewer logs show diagnostic output from the runner/provider and the `mcp-pruner` stderr stream, and the run continues without MCP tools |

### Contract Gates (Explicit)
- **Breaking change**: No. This is a new optional MCP server and new optional tool argument; existing runs continue unchanged when disabled.
- **Migration path**: N/A (opt-in). Agents must explicitly set `context_focus_question` per tool call to request pruning.
- **Versioning**: MCP server identifies as `name="mcp-pruner"`, `version="1.0.0"` (issue example). Consumers MUST ignore unknown fields in `initialize`.

## 4. Data
N/A - This feature does not add or modify data schemas.

## 5. Tasks

### Inputs From Sections 1–4 (Traceability)
- **Goals (Section 1)**:
  1. Standalone MCP server package `@jeeves/mcp-pruner` with tools `read`, `bash`, `grep`, each optionally accepting `context_focus_question`.
  2. When `context_focus_question` is provided, attempt pruning via configured `swe-pruner` HTTP endpoint; on any error/timeout, safely fall back to unpruned output.
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
1. **Smallest independently testable unit**: a single tool handler (e.g., `read`) + its argument validation + its pruning fallback behavior, verified via unit tests (and optionally a minimal MCP SDK stdio integration test).
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
T6 → depends on T1, T5
T7 → depends on T5, T6
T8 → depends on T5, T6
T9 → depends on T1, T6, T7, T8
T10 → depends on T1–T9
```

### Task Breakdown
| ID | Title | Summary | Files | Acceptance Criteria |
|----|-------|---------|-------|---------------------|
| T1 | Scaffold MCP pruner package | Add `@jeeves/mcp-pruner` workspace package with issue-prescribed dependencies (`@modelcontextprotocol/sdk`, `zod`) and stdio entrypoint. | `packages/mcp-pruner/package.json`, `packages/mcp-pruner/tsconfig.json`, `packages/mcp-pruner/src/index.ts`, `tsconfig.json` | `packages/mcp-pruner/package.json` + `tsconfig.json` match issue Steps 1.2/1.3 (incl. `@modelcontextprotocol/sdk@^1.12.0`, `zod@^3.24.0`), `pnpm typecheck` includes the new package, and `pnpm build` emits `packages/mcp-pruner/dist/index.js` with a `mcp-pruner` bin. |
| T2 | Implement pruner client | Implement `getPrunerConfig()` + `pruneContent()` with best-effort fallback to original content. | `packages/mcp-pruner/src/pruner.ts` | On timeout/non-2xx/invalid response, pruning falls back safely to the original content. |
| T3 | Implement tools (issue-aligned inputs) | Implement `read`, `bash`, `grep` with issue-aligned input names (`file_path`, `command`, `pattern`/`path`) and optional pruning hook. | `packages/mcp-pruner/src/tools/*.ts` | Tool output/error/path behavior matches Section 3 exactly (markers, exit-code handling, no containment, no `result.isError`). |
| T4 | Wire MCP SDK + stdio transport | Register tools on an `McpServer` and connect via `StdioServerTransport` (stdio). | `packages/mcp-pruner/src/index.ts` | Server identifies as `name="mcp-pruner"`, `version="1.0.0"`, returns `-32602` with `message="Invalid params"`, and runs over stdio with stderr-only diagnostics. |
| T5 | Extend runner options | Add `McpServerConfig` and `mcpServers` to `ProviderRunOptions` so providers can spawn MCP servers. | `packages/runner/src/provider.ts` | Providers can receive `mcpServers?: Record<string, { command, args?, env? }>` without type errors. |
| T6 | Add runner MCP config builder | Build the `mcpServers` record from env vars (`JEEVES_PRUNER_ENABLED`, `JEEVES_PRUNER_URL`, `JEEVES_MCP_PRUNER_PATH`) and wire into `runner.ts`. | `packages/runner/src/mcpConfig.ts`, `packages/runner/src/runner.ts` | When enabled, runner passes `mcpServers.pruner={ command, args, env }` to providers with deterministic defaults for `PRUNER_URL` and the `mcp-pruner` entrypoint path. |
| T7 | Claude provider wiring | Pass `options.mcpServers` through to Claude Agent SDK options. | `packages/runner/src/providers/claudeAgentSdk.ts` | Claude provider includes `mcpServers` when present; omits when absent. |
| T8 | Codex provider wiring | Convert `options.mcpServers` into Codex CLI `--config mcp_servers.*` overrides for stdio servers. | `packages/runner/src/providers/codexSdk.ts` | Codex provider sets `mcp_servers.<name>.command/args/env` (no `url` / `streamable_http`). |
| T9 | Docs | Add package docs + runner docs covering env vars and local usage. | `packages/mcp-pruner/CLAUDE.md`, `packages/runner/CLAUDE.md` | Docs include env vars, local dev run instructions, and a minimal tool example. |
| T10 | Full validation | Run repo quality commands and record validation evidence. | `.jeeves/progress.txt`, `packages/mcp-pruner/src/index.ts`, `packages/runner/src/mcpConfig.ts`, `packages/runner/src/providers/claudeAgentSdk.ts`, `packages/runner/src/providers/codexSdk.ts` | `pnpm lint && pnpm typecheck && pnpm test` pass and the command outcomes are recorded in `.jeeves/progress.txt`. |

### Task Details

**T1: Scaffold MCP pruner package**
- Summary: Create the new `packages/mcp-pruner` workspace package with issue-prescribed dependencies (`@modelcontextprotocol/sdk`, `zod`) and a stdio MCP server entrypoint exposed as the `mcp-pruner` bin.
- Files:
  - `packages/mcp-pruner/package.json` - new workspace package + bin entry (`mcp-pruner` → `./dist/index.js`) and dependencies.
  - `packages/mcp-pruner/tsconfig.json` - TS build config emitting `dist/*`.
  - `packages/mcp-pruner/src/index.ts` - MCP server entrypoint (stdio transport).
  - `tsconfig.json` - add project reference to `./packages/mcp-pruner` (if required by repo conventions).
- Required scaffold specifics (issue Steps 1.2/1.3):
  - `packages/mcp-pruner/package.json` MUST include at minimum:
    - `"name": "@jeeves/mcp-pruner"`, `"version": "0.0.0"`, `"private": true`, `"type": "module"`
    - `"main": "./dist/index.js"`, `"types": "./dist/index.d.ts"`
    - `"bin": { "mcp-pruner": "./dist/index.js" }`
    - `"scripts": { "build": "tsc", "dev": "tsc --watch" }`
    - `"dependencies": { "@modelcontextprotocol/sdk": "^1.12.0", "zod": "^3.24.0" }`
    - `"devDependencies": { "@types/node": "^22.0.0" }`
  - `packages/mcp-pruner/tsconfig.json` MUST include at minimum:
    - `"extends": "../../tsconfig.base.json"`
    - `"compilerOptions": { "outDir": "./dist", "rootDir": "./src", "declaration": true, "declarationMap": true }`
    - `"include": ["src/**/*"]`, `"exclude": ["node_modules", "dist"]`
- Acceptance Criteria:
  1. `pnpm build` emits `packages/mcp-pruner/dist/index.js` and `mcp-pruner` runs as a stdio MCP server.
  2. Root `tsconfig.json` includes the new package so `pnpm typecheck` builds it.
  3. `packages/mcp-pruner/package.json` and `packages/mcp-pruner/tsconfig.json` include the issue-specified fields/versions above to prevent drift.
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
  2. `read` path semantics: absolute `file_path` is used as-is; relative `file_path` resolves against `MCP_PRUNER_CWD` (no containment/sandbox rule). Read failures return `Error reading file: <message>`.
  3. `bash` output semantics match the issue example exactly: append `\\n[stderr]\\n<stderr>` when stderr non-empty; append `\\n[exit code: <code>]` when `code !== 0`; empty output becomes `(no output)`; spawn error is `Error executing command: <message>`.
  4. `grep` uses `grep -rn --color=never <pattern> <path>` with `<path> = arguments.path ?? "."`; exit code `1` returns `(no matches found)`; exit code `2` with non-empty stderr returns `Error: <stderr>`; spawn error is `Error executing grep: <message>`.
  5. Tool results never set `result.isError`; all failures are surfaced as strings in `content[0].text`.
  6. When `context_focus_question` is provided and truthy (and the tool’s pruning eligibility conditions are met), tools attempt pruning via `pruneContent(raw, context_focus_question, config)`; on any pruner failure, they fall back to unpruned output (query passed verbatim).
- Dependencies: T2
- Verification: `pnpm typecheck` (and tool unit tests if added)

**T4: Wire MCP SDK + stdio transport**
- Summary: Register `read`, `bash`, and `grep` tools on an `McpServer` and connect via `StdioServerTransport` (stdio).
- Files:
  - `packages/mcp-pruner/src/index.ts` - MCP server entrypoint: tool registration + transport connect.
- Acceptance Criteria:
  1. `packages/mcp-pruner/src/index.ts` uses `@modelcontextprotocol/sdk/server/mcp` + `@modelcontextprotocol/sdk/server/stdio` and connects over stdio.
  2. Server identity matches the issue example: `new McpServer({ name: "mcp-pruner", version: "1.0.0" })`, and `initialize` returns `serverInfo.name="mcp-pruner"`, `serverInfo.version="1.0.0"`.
  3. Invalid params are reported as JSON-RPC `error.code=-32602` with `error.message="Invalid params"` (exact string).
  4. The server writes diagnostics to stderr only (stdout reserved for MCP protocol).
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
  - `packages/runner/CLAUDE.md` - runner env vars and a minimal enable/verify example.
- Acceptance Criteria:
  1. Docs list runner env vars (`JEEVES_PRUNER_ENABLED`, `JEEVES_PRUNER_URL`, `JEEVES_MCP_PRUNER_PATH`) and server env vars (`PRUNER_URL`, `PRUNER_TIMEOUT_MS`, `MCP_PRUNER_CWD`).
  2. Docs include a minimal `tools/call` example using `read.file_path` and `context_focus_question`.
- Dependencies: T1, T6, T7, T8
- Verification: N/A

**T10: Full validation**
- Summary: Run repo quality commands after implementation and record outcomes in a concrete validation artifact.
- Files:
  - `.jeeves/progress.txt` - append a validation checkpoint with command pass/fail outcomes.
  - `packages/mcp-pruner/src/index.ts` - validate the MCP server entrypoint changes via lint/typecheck/test.
  - `packages/runner/src/mcpConfig.ts` - validate runner MCP config wiring via lint/typecheck/test.
  - `packages/runner/src/providers/claudeAgentSdk.ts` - validate Claude provider MCP wiring via lint/typecheck/test.
  - `packages/runner/src/providers/codexSdk.ts` - validate Codex provider MCP wiring via lint/typecheck/test.
- Acceptance Criteria:
  1. `pnpm lint` passes.
  2. `pnpm typecheck` passes.
  3. `pnpm test` passes.
  4. Validation command outcomes are recorded in `.jeeves/progress.txt`.
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
  - Start a run; confirm viewer logs show `mcp:*/*` tool calls when the agent uses `read`/`bash`/`grep` with `context_focus_question` and that the spawned `mcp-pruner` stderr output is visible in the run logs.
