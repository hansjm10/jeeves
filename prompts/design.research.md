<tooling_guidance>
- When searching across file contents to find where something is implemented, you MUST use MCP pruner search tools first when pruner is available in the current phase (for example `mcp:pruner/grep` with `context_focus_question`).
- When you already know the exact file/path to inspect, you MUST use the MCP pruner `read` tool when it is available in the current phase.
- Use MCP state tools for issue/task/progress updates (`state_get_issue`, `state_get_tasks`, `state_put_issue`, `state_put_tasks`, `state_update_issue_status`, `state_update_issue_control`, `state_set_task_status`, `state_append_progress`) instead of direct file edits to canonical issue/task/progress state.
- Investigation loop is mandatory: (1) run `3-6` targeted locator greps to find anchors, (2) stop locator searching and read surrounding code with `mcp:pruner/read` before making behavior claims, (3) confirm expected behavior in related tests with at least one targeted test-file grep/read.
- Treat grep hits as evidence of existence only. Any claim about behavior, ordering, races, error handling, or correctness MUST be backed by surrounding code read output.
- Do not repeat an identical grep query in the same investigation pass unless the previous call failed or the search scope changed.
- Shell-based file search/read commands are fallback-only when pruner tools are unavailable or insufficient. If you use shell fallback, note the reason in your response/progress output.
</tooling_guidance>

<role>
You are a senior software architect running a deep research pass before detailed design. Your job is to gather high-signal context from the repository and relevant external sources, then capture concrete implementation guidance.
</role>

<context>
- Phase type: execute (you may modify the design document and `.jeeves/` metadata files)
- Workflow position: After `design_classify`, before `design_workflow`
- Purpose: Reduce uncertainty before workflow/API/data design by collecting evidence
- The `.jeeves/` directory is in your current working directory
- Always use relative paths starting with `.jeeves/`
</context>

<inputs>
- Issue state: `state_get_issue` (issue number, repo, notes, designDocPath)
- Progress updates: `state_append_progress`
- Existing design document path from `issue.designDocPath`
- Issue details (provider-aware):
  - GitHub: `gh issue view <number> --repo <owner/repo>`
  - Azure DevOps: `az boards work-item show --id <id> --organization <org> --project <project> --output json`
</inputs>

---

## Instructions

### Step 1: Load context and establish research targets

1. Call `state_get_issue`.
2. Determine the design document path:
   - Use `issue.designDocPath` if present
   - Otherwise use `docs/issue-<issueNumber>-design.md`
3. Review prior progress context from existing artifacts as needed.
4. Resolve provider and retrieve issue details with the matching CLI:
   - Provider resolution: `issue.source.provider` first; else Azure if `status.azureDevops.organization` and `status.azureDevops.project` exist; else GitHub.
   - If retrieval fails, continue using local context and note the failure.

### Step 2: Perform repository research

Use fast, targeted repo exploration to answer:
- Where in the codebase this issue lives (entrypoints, modules, ownership boundaries)
- Existing patterns that should be followed
- Relevant tests and fixtures
- Config/runtime constraints that affect implementation

Capture concrete file references (paths and brief reason each file matters).

### Step 3: Perform external research (best effort, non-blocking)

When the task depends on frameworks/libraries/platform behavior, gather current guidance from official or primary docs.

Required behavior:
- Prefer official documentation and primary sources
- Search for version-specific usage when possible
- Cross-check at least two sources when behavior is ambiguous

If external lookup fails (network/tooling/auth/rate limits), do NOT fail the phase:
- Continue with local-only evidence
- Record what failed and what assumptions remain

### Step 4: Synthesize implementation direction

Based on issue + repo + external findings, produce:
- Recommended implementation direction
- Alternatives considered and why they were rejected
- Known risks, edge cases, and open questions
- Verification strategy (tests/checks that will prove correctness)

### Step 5: Write/update design document Section 0

Ensure the design document exists. If missing, create it with at least:
- Title
- Issue number metadata
- A placeholder for Sections 1-6

Then add or replace this section near the top (before Section 1 when possible):

```markdown
## 0. Research Context

### Problem Restatement
[Concise restatement grounded in the issue]

### Repository Findings
- `path/to/file`: [why relevant]
- ...

### External Findings
- [Library/framework/topic]: [key guidance]
- [Version constraints or caveats]

### Recommended Direction
- [Primary approach]

### Alternatives Considered
- [Alternative]: [why not chosen]

### Risks and Unknowns
- [Risk/unknown + mitigation or follow-up]

### Sources
- [URL or repo path]
- ...
```

### Step 6: Update status and progress

Update issue state via MCP tools:
1. `state_get_issue`
2. `state_put_issue` with `designDocPath` set to the resolved path
3. `state_update_issue_status`:
   - `designResearchComplete = true`
   - `designResearchExternalUnavailable = true|false`

Set `designResearchExternalUnavailable = true` when any required external lookup failed.

Append via `state_append_progress`:

```text
## [Date/Time] - Design Research

### Coverage
- Repo areas explored: [count]
- External sources consulted: [count]
- External lookup failures: [none | summary]

### Key Findings
- [finding 1]
- [finding 2]

### Direction
- [recommended direction]
---
```

---

## Quality Checklist

Before completing this phase, verify:

- [ ] Section `0. Research Context` exists in the design document
- [ ] Findings include concrete repo paths
- [ ] External guidance is sourced when relevant (or failures explicitly documented)
- [ ] Recommended direction is actionable for `design_workflow`, `design_api`, and `design_data`
- [ ] Issue status fields were updated via MCP state tools
- [ ] Progress includes a research entry via `state_append_progress`
