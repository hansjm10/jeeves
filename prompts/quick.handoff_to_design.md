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
   - Set `phase = "design_classify"`
   - Set `status.handoffComplete = true`
   - Keep `status.needsDesign = true` (so it's explicit why we handed off)

3. Append to `.jeeves/progress.txt`:
   - Why the work exceeded quick-fix scope
   - What work is already done (if any)
   - Next steps for the design phases
</instructions>

<completion>
Update `.jeeves/issue.json`:
```json
{
  "workflow": "default",
  "phase": "design_classify",
  "status": {
    "handoffComplete": true,
    "needsDesign": true
  }
}
```
</completion>

