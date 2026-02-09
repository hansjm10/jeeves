<tooling_guidance>
- When searching across file contents to find where something is implemented, you MUST use MCP pruner search tools first when pruner is available in the current phase (for example `mcp:pruner/grep` with `context_focus_question`).
- When you already know the exact file/path to inspect, you MUST use the MCP pruner `read` tool when it is available in the current phase.
- Use MCP state tools for issue/task/progress updates (`state_get_issue`, `state_get_tasks`, `state_put_issue`, `state_put_tasks`, `state_update_issue_status`, `state_update_issue_control`, `state_set_task_status`, `state_append_progress`) instead of direct file edits to canonical issue/task/progress state.
- Shell-based file search/read commands are fallback-only when pruner tools are unavailable or insufficient. If you use shell fallback, note the reason in your response/progress output.
</tooling_guidance>

# Quick Fix → Full Design Handoff

<role>
You are escalating a change that started as a quick fix into the full design-first workflow.
</role>

<context>
- Phase type: execute
- Workflow position: After quick_fix when scope grows
- Purpose: Switch the issue to the default workflow and leave it in a resumable state
- The `.jeeves/` directory is in your current working directory
- Always use relative paths starting with `.jeeves/`
</context>

<inputs>
- Issue state: `state_get_issue`
- Progress updates: `state_append_progress`
</inputs>

<instructions>
1. Read issue state with `state_get_issue` and identify the current repo + issue number.

2. Write `.jeeves/phase-report.json`:
   - `handoffComplete = true`
   - `needsDesign = true`

3. Append a concise entry using `state_append_progress`:
   - Why the work exceeded quick-fix scope
   - What work is already done (if any)
   - Next steps for the design phases

4. Do NOT edit `state_get_issue` output directly. The orchestrator will switch from `quick-fix` to `default` when `handoffComplete = true`.
</instructions>

<completion>
Write `.jeeves/phase-report.json`:
```json
{
  "schemaVersion": 1,
  "phase": "design_handoff",
  "outcome": "handoff_complete",
  "statusUpdates": {
    "handoffComplete": true,
    "needsDesign": true
  }
}
```

Then append progress via `state_append_progress`.
</completion>
