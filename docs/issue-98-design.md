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
[To be completed in design_workflow phase]

## 3. Interfaces
[To be completed in design_api phase]

## 4. Data
[To be completed in design_data phase]

## 5. Tasks
[To be completed in design_plan phase]

## 6. Validation
[To be completed in design_plan phase]

