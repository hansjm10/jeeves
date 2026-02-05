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
[To be completed in design_api phase]

## 4. Data
[To be completed in design_data phase]

## 5. Tasks
[To be completed in design_plan phase]

## 6. Validation
[To be completed in design_plan phase]
