<tooling_guidance>
- When searching across file contents to find where something is implemented, prefer MCP pruner search tools first (for example `mcp:pruner/grep` with `context_focus_question`).
- When you already know the exact file/path to inspect, use the MCP pruner `read` tool.
- Shell-based file search/read commands are still allowed when needed, but MCP pruner tools are the default for file discovery and file reading.
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
- Issue config: `.jeeves/issue.json`
- Progress log: `.jeeves/progress.txt`
</inputs>

<instructions>
1. Read `.jeeves/issue.json` and identify the current repo + issue number.

2. Update `.jeeves/issue.json` to hand off to the default workflow:
   - Set `workflow = "default"`
   - Do NOT set `phase` directly
   - Keep `status.needsDesign` context in the phase report (below)

3. Write `.jeeves/phase-report.json`:
   - `handoffComplete = true`
   - `needsDesign = true`

4. Append to `.jeeves/progress.txt`:
   - Why the work exceeded quick-fix scope
   - What work is already done (if any)
   - Next steps for the design phases
</instructions>

<completion>
Update `.jeeves/issue.json`:
```json
{
  "workflow": "default"
}
```

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
</completion>
