# Design Document: Add Early Pre-Implementation Completeness Check (Issue #76)

## Document Control
- **Title**: Add early completeness check after task decomposition
- **Authors**: Jeeves Agent (Codex CLI)
- **Reviewers**: TBD
- **Status**: Draft
- **Last Updated**: 2026-02-02
- **Related Issues**: https://github.com/hansjm10/jeeves/issues/76
- **Execution Mode**: AI-led

## 1. Summary
The current workflow performs `completeness_verification` only after all tasks pass, which often surfaces missing requirements late and causes additional tasks to be created at the end of implementation. This design introduces a lightweight `pre_implementation_check` evaluation phase immediately after `task_decomposition` to catch obvious scope gaps (missing issue requirements, missing design doc file, and malformed task coverage) before entering the task implementation loop.

## 2. Context & Problem Statement
- **Background**: The default workflow (`workflows/default.yaml`) runs `task_decomposition → implement_task → task_spec_check` in a loop, and only after all tasks are passed does it run `completeness_verification` (`prompts/verify.completeness.md`). Real-world runs (e.g., the Issue #68 example in Issue #76) frequently discover missing requirements late, forcing task list expansion near the end of the workflow.
- **Problem**: Late discovery of missing requirements increases iteration count and rework, and it can produce a “60% complete” illusion where task-level checks pass but the overall issue scope is not fully covered.
- **Forces**:
  - Must remain “lightweight” to avoid duplicating full `completeness_verification`.
  - Must operate with existing workflow engine constraints: transitions are driven by `status.*` guard expressions and evaluation phases are read-only for source code.
  - Must not introduce new persistence mechanisms beyond `.jeeves/*` files.

## 3. Goals & Non-Goals
- **Goals**:
  1. Add a new `pre_implementation_check` phase in the default workflow between `task_decomposition` and `implement_task`.
  2. Verify that the decomposed task list plausibly covers the GitHub issue requirements and design document scope before implementation begins.
  3. Verify that the design document referenced by `.jeeves/issue.json.designDocPath` exists on disk **and is git-tracked** (so “design doc exists and is committed” is enforced as “tracked in git”).
  4. Provide actionable feedback in `.jeeves/progress.txt` when gaps are detected, and gate workflow progression via `status.preCheckPassed` / `status.preCheckFailed`.
- **Non-Goals**:
  - Replace or weaken `completeness_verification`; that phase remains the authoritative end-to-end audit.
  - Automatically rewrite the design document during the pre-check.
  - Perform deep code-level verification (no source changes exist yet; this is intentionally pre-implementation).

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**: Maintainers using the Jeeves viewer to run issue workflows.
- **Agent Roles**:
  - Task Decomposition Agent (`prompts/task.decompose.md`): produces `.jeeves/tasks.json`.
  - Pre-Implementation Check Agent (new, `prompts/verify.pre_implementation.md`): validates task coverage and artifacts prior to implementation.
  - Implementation Agent (`prompts/task.implement.md`): implements tasks once the pre-check passes.
- **Affected Packages/Services**:
  - Workflow config: `workflows/default.yaml`
  - Prompt templates: `prompts/verify.pre_implementation.md` (new)
  - Viewer-server orchestration tests (transition assumptions): `apps/viewer-server/src/runManager.test.ts`
- **Compatibility Considerations**:
  - Existing workflows that reference `task_decomposition → implement_task` must be updated only for the default workflow; other workflows are unaffected.
  - The workflow engine already supports new phases and new `status.*` keys without schema changes (unknown status keys evaluate to falsy in guard expressions).

## 5. Current State
- Default workflow (`workflows/default.yaml`) includes:
  - `task_decomposition` (execute) which produces `.jeeves/tasks.json` and sets `status.taskDecompositionComplete`.
  - Transition `task_decomposition → implement_task` when `status.taskDecompositionComplete == true`.
  - `task_spec_check` (evaluate) gates task loop and eventually transitions to `completeness_verification` when `status.allTasksComplete == true`.
- Viewer-server orchestration (`apps/viewer-server/src/runManager.ts`) advances phases based on `WorkflowEngine.evaluateTransitions(currentPhase, updatedIssueJson)` and performs task `filesAllowed` expansion only when transitioning into `implement_task`.

## 6. Proposed Solution
### 6.1 Architecture Overview
- Insert a new evaluation phase `pre_implementation_check` into the default workflow between decomposition and implementation.
- The pre-check reads:
  - `.jeeves/issue.json` (issue number, `designDocPath`)
  - `.jeeves/tasks.json` (decomposed tasks)
  - the design doc at `designDocPath`
  - GitHub issue requirements via `gh issue view <issue_number> --repo <repo>`
- The pre-check outputs:
  - `status.preCheckPassed: true` when no gaps are detected
  - `status.preCheckFailed: true` when gaps are detected (with detailed log entry in `.jeeves/progress.txt`)
- Workflow transitions:
  - `task_decomposition → pre_implementation_check` when `status.taskDecompositionComplete == true`
  - `pre_implementation_check → implement_task` when `status.preCheckPassed == true`
  - `pre_implementation_check → task_decomposition` when `status.preCheckFailed == true`

### 6.2 Detailed Design
#### Workflow YAML changes (`workflows/default.yaml`)
1. Add a new phase:
   - Name: `pre_implementation_check`
   - Type: `evaluate`
   - Provider: `codex` (default workflow already sets codex defaults)
   - Prompt: `verify.pre_implementation.md`
   - Description: “Verify task coverage before implementation”
   - Transitions:
     - to `implement_task` when `status.preCheckPassed == true`
     - to `task_decomposition` when `status.preCheckFailed == true`
2. Update the `task_decomposition` transition target from `implement_task` to `pre_implementation_check`.

#### New prompt (`prompts/verify.pre_implementation.md`)
Create a new “evaluate/read-only” prompt that:
1. Loads authoritative inputs:
   - `.jeeves/issue.json` for issue number, repo, and `designDocPath`
   - `.jeeves/tasks.json` for the task list
   - design doc content from `designDocPath`
   - GitHub issue body via `gh issue view <number> --repo <owner/repo> --json title,body` (fallback: `.jeeves/issue.md` cache; if both are unavailable, hard fail)
2. Checks:
   - **Design doc is present + committed (hard fail)**:
     - `designDocPath` exists and is a file.
     - `designDocPath` is git-tracked (enforced via `git ls-files --error-unmatch <designDocPath>`). If missing or untracked, set `status.preCheckFailed = true` and log remediation instructions (e.g., add/commit the doc, then rerun).
   - **Task list is structurally valid (hard fail)**:
     - `.jeeves/tasks.json` exists and parses as a JSON array.
     - Each task entry contains: `id` (string), `title` (string), `summary` (string), `acceptanceCriteria` (array of non-empty strings).
     - Task IDs are unique (duplicates are a hard fail because requirement→task mapping becomes ambiguous).
     - Non-gating warnings (log only): unusually low/high task count, very short summaries, or overly broad acceptance criteria.
   - **Deterministic requirements extraction + coverage (hard fail on gaps)**:
     - **Requirement source**: GitHub issue body (not the design doc). The design doc is validated for existence/tracking, but it is not treated as the authoritative requirements list for this pre-check.
     - **Must-have requirements**:
       1) If the issue body contains a markdown heading named `Acceptance Criteria`, `Requirements`, or `Proposed Solution` (case-insensitive), extract *all* list items (bulleted/numbered/task-list) that occur within the first such section as must-haves.
       2) Else, extract *all* markdown task-list items (`- [ ] ...` / `- [x] ...`) in the issue body as must-haves.
       3) Else, hard fail with an explicit log message that the issue lacks an explicit requirements list and cannot be pre-checked deterministically.
     - **Coverage rule**: each must-have requirement must map to ≥1 task ID. The pre-check must output a small mapping table in `.jeeves/progress.txt` (`Requirement → Task IDs`) with 1–2 sentence justifications per requirement.
     - **Pass threshold**: 100% of must-have requirements mapped. Any unmapped must-have requirement is a hard fail (set `status.preCheckFailed = true`).
3. Writes status:
   - On pass: set `.jeeves/issue.json.status.preCheckPassed = true` and `.jeeves/issue.json.status.preCheckFailed = false` (or omit false), and append a progress entry.
   - On fail: set `.jeeves/issue.json.status.preCheckPassed = false` (or omit) and `.jeeves/issue.json.status.preCheckFailed = true`, append a progress entry listing uncovered requirements and suggested task additions.
4. Write constraints:
   - Must not modify `.jeeves/tasks.json` (no auto-fixing or auto-appending tasks); on failure it must force a rerun of `task_decomposition` via the workflow transition.
   - May write `.jeeves/issue.md` as a cache of the fetched GitHub issue body/title (when `gh issue view` succeeds) so subsequent pre-check runs are deterministic even if `gh` is unavailable.
   - Does not modify any source files; allowed writes remain `.jeeves/*`.

#### Updates to existing tests
`apps/viewer-server/src/runManager.test.ts` currently assumes that `task_decomposition` can transition directly to `implement_task` when `status.taskDecompositionComplete == true`. With the new phase inserted, tests that assert `phase === 'implement_task'` after starting in `task_decomposition` must be updated to:
- start from `pre_implementation_check` with `status.preCheckPassed == true`, or
- run multiple iterations and/or seed `issue.json` and `tasks.json` accordingly.

### 6.3 Operational Considerations
- **Deployment**: No deployment changes; this is repo-local workflow/prompt/test updates.
- **Telemetry & Observability**: Rely on `.jeeves/progress.txt` entries from the pre-check to make failures actionable and visible in the viewer.
- **Security & Compliance**: Pre-check uses `gh issue view` and local repo inspection only. No new secret handling is introduced.

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(workflow): add pre_implementation_check phase | Insert new phase and update transitions in `workflows/default.yaml` | Implementation Agent | Design approved | Workflow loads; `task_decomposition` transitions to `pre_implementation_check` |
| feat(prompts): add verify.pre_implementation.md | Add new prompt implementing the lightweight checks and status updates | Implementation Agent | Workflow updated | Prompt exists; sets `status.preCheckPassed`/`status.preCheckFailed`; logs to `.jeeves/progress.txt` |
| test(viewer-server): update RunManager transition tests | Update tests impacted by new phase insertion | Implementation Agent | Workflow + prompt | Tests pass; task `filesAllowed` expansion still occurs before `implement_task` runs |
| docs: document new phase semantics | Update any developer docs referencing the task loop (if applicable) | Docs Agent | Workflow updated | Documentation mentions the new phase and its purpose |

### 7.2 Milestones
- **Phase 1**: Land workflow + prompt changes and adjust tests.
- **Phase 2**: Iterate on prompt heuristics based on real runs (tune what counts as “must-have” requirement coverage).

### 7.3 Coordination Notes
- **Hand-off Package**:
  - `workflows/default.yaml` diff (phase insertion)
  - New prompt: `prompts/verify.pre_implementation.md`
  - Test updates: `apps/viewer-server/src/runManager.test.ts`
- **Communication Cadence**: Reviewers validate prompt behavior by simulating a run that starts in `task_decomposition` and observing transition gating.

## 8. Agent Guidance & Guardrails
- **Context Packets**:
  - `workflows/default.yaml` (phase graph)
  - `prompts/task.decompose.md` and `prompts/verify.completeness.md` (existing patterns)
  - `apps/viewer-server/src/runManager.ts` (phase transition + task expansion behavior)
- **Prompting & Constraints**:
  - The new pre-check prompt must be **evaluate/read-only** and may only write `.jeeves/*`.
  - Status keys must be exactly `preCheckPassed` and `preCheckFailed` to match guard expressions.
  - Progress logging format must be consistent with existing `.jeeves/progress.txt` conventions.
- **Safety Rails**:
  - Do not modify any non-`.jeeves/*` files in the pre-check prompt instructions.
  - Avoid introducing new required tools beyond `gh` and basic git/file checks.
- **Validation Hooks**:
  - `pnpm test` must pass (specifically the viewer-server RunManager tests affected by phase transitions).

## 9. Alternatives Considered
1. **Enhance `task_decomposition` prompt only**: Add requirement coverage checks directly into `prompts/task.decompose.md`. Rejected because it conflates generation with verification and makes it harder to reason about why the task list is insufficient.
2. **Move completeness verification earlier**: Run `completeness_verification` after decomposition. Rejected as too heavyweight; `verify.completeness` is designed to map requirements to implemented code/tests, which do not exist pre-implementation.
3. **Skip gating; only warn**: Let implementation proceed while logging warnings. Rejected because the goal is to avoid late-stage churn; gating is necessary to force correction early.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - Update `apps/viewer-server/src/runManager.test.ts` to reflect the new phase ordering and verify that `filesAllowed` expansion still happens on transition into `implement_task`.
  - Add/adjust workflow loader expectations (or add a new test) to assert:
    - default workflow includes `pre_implementation_check` with `prompt: verify.pre_implementation.md`
    - `task_decomposition` no longer transitions directly to `implement_task`
    - `pre_implementation_check` transitions to `implement_task` on `status.preCheckPassed == true` and back to `task_decomposition` on `status.preCheckFailed == true`
- **Performance**:
  - Pre-check should limit itself to reading issue/design/task files and a single `gh issue view` call; no repo-wide scans required.
- **Tooling / A11y**: Not applicable (no UI changes).

## 11. Risks & Mitigations
- **Risk**: The pre-check fails repeatedly because `task_decomposition` doesn’t incorporate pre-check feedback.
  - **Mitigation**: Require the pre-check to write explicit, copy-pastable “missing requirements” bullets into `.jeeves/progress.txt` so the next decomposition iteration can incorporate them.
- **Risk**: Overly strict coverage heuristics cause false negatives.
  - **Mitigation**: Keep gating limited to an explicit, deterministic “must-have requirements” list extracted from the issue (and treat other signals as warn-only).
- **Risk**: Tests or tooling assume `task_decomposition` transitions directly to `implement_task`.
  - **Mitigation**: Update viewer-server tests and any docs that describe the task loop.

## 12. Rollout Plan
- **Milestones**:
  1. Merge workflow + prompt + tests.
  2. Validate on one real issue run; adjust prompt wording if it is too strict/too lax.
- **Migration Strategy**: None; this affects only new runs using the updated default workflow.
- **Communication**: Add a short note in docs (or release notes if they exist) describing the new pre-check and how to respond when it fails (return to task decomposition).

## 13. Decisions (Resolved)
1. **Requirement extraction + pass threshold**: Must-have requirements are extracted deterministically from the issue body (section-based, then task-list fallback). Passing requires 100% mapping of must-haves to ≥1 task ID.
2. **“Design doc is committed” enforcement**: Enforced as “git-tracked” (`git ls-files --error-unmatch <designDocPath>`). Missing or untracked is a hard fail.
3. **`gh issue view` availability**: If `gh issue view` fails, the pre-check uses `.jeeves/issue.md` as the required cached source of truth; if neither is available, it hard fails.
4. **Heuristics vs gating**: Task-count bounds and “quality” checks are warn-only; only structural validity, must-have requirement coverage, and design-doc tracking are gating.
5. **`.jeeves/tasks.json` mutation**: Not allowed. The pre-check only logs gaps and forces a rerun of `task_decomposition` on failure.

## 14. Follow-Up Work
- Consider updating `prompts/task.decompose.md` to explicitly read GitHub issue requirements and prioritize them (if pre-check failures become common).
- Consider adding a small schema/structure validator for `.jeeves/tasks.json` generation to reduce malformed tasks.

## 15. References
- `workflows/default.yaml`
- `prompts/verify.completeness.md`
- `prompts/task.decompose.md`
- `apps/viewer-server/src/runManager.ts`
- Issue #76: https://github.com/hansjm10/jeeves/issues/76

## Appendix A — Glossary
- **Phase**: A named step in the workflow (`execute`, `evaluate`, `script`, or `terminal`) defined in `workflows/*.yaml`.
- **Task loop**: The cycle of `implement_task → task_spec_check` across tasks until `allTasksComplete`.
- **Completeness verification**: Post-task audit that maps design/issue requirements to code/tests and creates new tasks when gaps remain.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2026-02-02 | Jeeves Agent | Initial draft |
