---
name: safe-shell-search
description: "Enforce pruner-first codebase discovery and evidence-grounded claims. Use when: (1) searching across file contents to find implementations, (2) reading known file paths for inspection, (3) building evidence for behavior claims, (4) any codebase investigation that would otherwise use shell grep/cat/find. Triggers on: code search, file discovery, evidence gathering, investigation loop, codebase exploration."
---

# Safe Shell Search

Enforces MCP pruner-first search and read behavior with mandatory evidence grounding. Prevents premature shell command usage and unsubstantiated behavior claims.

---

## The Job

Ensure all codebase discovery and file inspection uses MCP pruner tools (`mcp:pruner/grep`, `mcp:pruner/read`) as the primary interface, with shell-based commands permitted only as a documented fallback. All behavior claims must be backed by direct code evidence.

---

## Tool Priority

### Discovery (finding where something is implemented)

You **MUST** use `mcp:pruner/grep` first when searching across file contents.

- Use `context_focus_question` to focus pruned output on the relevant aspect.
- Use `context_lines` to capture surrounding code when matches need local context.
- Use `patterns` (batch mode) when searching for multiple related terms in one call.

### Known-Path Inspection (reading a specific file or path)

You **MUST** use `mcp:pruner/read` first when you already know the exact file path.

- Use `context_focus_question` to filter long files to relevant sections.
- Use `start_line`/`end_line` or `around_line`/`radius` for targeted reads.

### Shell Fallback Policy

Shell-based file search/read commands (`grep`, `rg`, `find`, `cat`, `head`, `tail`) are **fallback-only**. You may use them only when:

1. MCP pruner tools are unavailable in the current phase.
2. Pruner output was truncated or filtered and the missing content is required for correctness.
3. The query requires shell-specific features not supported by pruner (e.g., binary file inspection, complex piped transformations).

**When you use shell fallback, you MUST document the reason in your progress output** (via `state_append_progress` or equivalent logging). Example:

> Shell fallback: pruner read output was truncated for `docs/large-file.md` (needed lines 450-600 for complete section); used `cat -n` with line range.

---

## Investigation Loop (Mandatory)

Every codebase investigation must follow this three-step loop:

### Step 1: Targeted Locator Greps

Run **3-6** targeted `mcp:pruner/grep` queries to find anchor points (definitions, usages, test files).

- Each query should target a specific symbol, pattern, or concept.
- Do **not** repeat an identical grep query in the same investigation pass unless the previous call failed or the search scope changed.

### Step 2: Read Surrounding Code

**Stop locator searching** and read surrounding code with `mcp:pruner/read` before making any behavior claims.

- Read enough context to understand control flow, error handling, and edge cases.
- Grep hits prove existence only. They do **not** prove behavior, ordering, race conditions, error handling, or correctness.

### Step 3: Confirm in Tests

Confirm expected behavior in related tests with at least one targeted test-file grep or read.

- Search for test files that exercise the code under investigation.
- Read test assertions to verify your understanding matches tested behavior.

---

## Evidence Rules

### Claims Must Be Grounded

Any claim about code behavior, ordering, races, error handling, or correctness **MUST** be backed by surrounding code read output from Step 2 of the investigation loop.

**Allowed evidence types:**
- Direct code reads showing the implementation
- Test assertions confirming the behavior
- Command output from executed verification commands

**Not valid evidence:**
- Grep match lines alone (existence only, not behavior)
- Assumptions based on naming conventions
- Inferences from partial context

### Evidence Documentation

When reporting findings, cite specific evidence:

```
Claim: Function X validates input before processing.
Evidence: `mcp:pruner/read` of src/handler.ts lines 45-62 shows
  validateInput() call at line 47 with early return on failure at line 49.
```

---

## MCP State Tools

Use MCP state tools for issue/task/progress/memory updates instead of direct file edits:

- `state_get_issue`, `state_get_tasks` for reading state
- `state_get_memory`, `state_upsert_memory`, `state_mark_memory_stale` for structured memory
- `state_set_task_status`, `state_update_issue_control` for status changes
- `state_append_progress` for progress logging

---

## Quick Reference

| Action | Tool | Fallback |
|--------|------|----------|
| Find implementations | `mcp:pruner/grep` | Shell grep (document reason) |
| Read known files | `mcp:pruner/read` | Shell cat/head (document reason) |
| Update state | MCP state tools | Never use direct file edits |
| Log progress | `state_append_progress` | N/A |
| Batch search | `mcp:pruner/grep` with `patterns` | Multiple shell greps (document reason) |
