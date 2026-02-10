# Design: Layered Skills for Task Spec Check

**Issue**: #108
**Status**: Draft - Classification Complete
**Feature Types**: Primary: Workflow, Secondary: Data Model

---

## 0. Research Context

### Problem Restatement

The task-loop (`implement_task → task_spec_check`) relies on prompt-only guidance for command hygiene (using MCP pruner tools before shell fallback, investigation loops, evidence rules) and evidence quality (criterion-by-criterion verdicting with file/command evidence, `filesAllowed` enforcement, `phase-report.json` + `task-feedback.md` artifact contracts). These rules are duplicated as `<tooling_guidance>` blocks across 15+ prompt files and embedded directly in the ~270-line `task.spec_check.md` prompt. Prompt-level enforcement is fragile: agents can ignore or misinterpret guidelines, there's no structured validation of evidence output, and adding new guardrails requires editing every prompt file.

The existing skills infrastructure (`/codex/skills/`, `skills/` in-repo, `registry.yaml`) provides a natural extension point, but the current `code-quality` skill assigned to `task_spec_check` is a generic quality checklist—it doesn't encode the specific operational guardrails that cause recurring failures (shell search mistakes, unverifiable evidence claims, filesAllowed violations).

### Repository Findings

#### Skill System Architecture
- `AGENTS.md` (repo root, lines 147-175): Skills are discovered via AGENTS.md listing, loaded progressively (metadata first, then SKILL.md body on trigger). Currently populated by external `/codex/skills/` directory, not by the in-repo `skills/` tree.
- `skills/registry.yaml`: Defines phase-to-skill mappings (e.g., `task_spec_check → [code-quality]`, `implement_task → [test-driven-dev, frontend-design]`). **Not yet consumed by any runner code**—purely a design artifact for future provisioning.
- `skills/review/code-quality/SKILL.md`: The only skill currently mapped to `task_spec_check`. Generic quality checklist (correctness, readability, maintainability, security) with no spec-check-specific contracts.
- `/codex/skills/.system/skill-creator/SKILL.md`: Comprehensive skill creation guide with anatomy, progressive disclosure, naming conventions, and validation (`scripts/quick_validate.py`).

#### Task Spec Check Flow
- `prompts/task.spec_check.md`: The core spec-check prompt (~270 lines). Defines the full verification workflow:
  1. Load current task from MCP state (`state_get_issue`, `state_get_tasks`)
  2. Extract `acceptanceCriteria` and `filesAllowed` from task definition
  3. For each criterion: verify with direct evidence (file existence, code inspection, executed commands)
  4. Check all modified files against `filesAllowed` patterns
  5. Produce PASS/FAIL verdict with status updates and artifacts
- `prompts/task.implement.md`: Implementation prompt references `task_spec_check` as the next phase after implementation.
- `.jeeves/phase-report.json`: Structured output artifact from spec check (schema: `schemaVersion`, `phase`, `outcome`, `statusUpdates`)
- `.jeeves/task-feedback.md`: Written on FAIL with criterion-level failure details for the next implementation retry.

#### Workflow Integration
- `workflows/default.yaml`: `implement_task` (type: execute, provider: claude, model: opus) auto-transitions to `task_spec_check` (type: evaluate, provider: codex). Both use `mcp_profile: state_with_pruner`.
- `packages/core/src/workflow.ts`: Phase type system (`execute | evaluate | script | terminal`), transition guards via `when` expressions evaluated against `status.*` fields.
- `packages/core/src/workflowEngine.ts`: `evaluateTransitions()` uses `auto` and `when` guards from phase definitions. No skill-awareness in the engine.
- `apps/viewer-server/src/parallelRunner.ts`: Wave-based parallel execution (`implement_task` wave → `task_spec_check` wave → merge). Task status tracked per-worker.

#### Prompt/Instruction Injection
- `packages/runner/src/runner.ts` (line 20, 528-563): Prepends `AGENTS.md` and `CLAUDE.md` from cwd as `<workspace_instructions>`. This is how skills listed in AGENTS.md become visible to agents. No separate skill-loading mechanism in the runner.
- `<tooling_guidance>` blocks: Identical 8-line block duplicated in all 15+ prompt files. Contains investigation loop rules, MCP pruner priority, shell fallback restrictions, and evidence standards.

#### Feature Flag / Settings Pattern
- `packages/core/src/issueState.ts`: Issue state schema uses `.passthrough()` on `status` field—arbitrary keys are allowed. Current practice stores feature toggles as `issue.json.status.*` (e.g., `designClassifyComplete`, `featureTypes`).
- `apps/viewer-server/src/server.ts`: Normalizes and validates settings from issue state (passthrough schema allows opt-in flags without core schema changes).

#### MCP Tooling
- `packages/runner/src/mcpConfig.ts`: Defines MCP profiles (`default | none | pruner | state | state_with_pruner`). Profile `state_with_pruner` provides both state tools (issue/task/progress management) and pruner tools (grep/read with context focusing).
- State tools: `state_get_issue`, `state_get_tasks`, `state_set_task_status`, `state_update_issue_status`, `state_append_progress`, `state_get_memory`, `state_upsert_memory`.

### External Findings

#### Codex Skill System (Official)
- Skills use progressive disclosure: metadata always in context (~100 words), SKILL.md body loaded only when triggered, references/scripts loaded on demand.
- Skill locations follow a hierarchy: `.agents/skills` in repo → user → admin → system. Duplicate names don't merge.
- Best practice: one focused job per skill, narrow scope, imperative numbered steps, explicit input/output contracts.
- Skills can reference scripts for deterministic reliability, and references for domain knowledge loaded on demand.
- Source: [OpenAI Codex Skills Docs](https://developers.openai.com/codex/skills)

#### Layered Guardrail Patterns
- Defense-in-depth is the standard pattern for agent guardrails: multiple independent layers where if one layer fails, the next catches the issue.
- The 2025-2026 dominant pattern focuses on composable, reusable skills over proliferating agents, with workflows for orchestration + skills for specialization.
- Tool gating (approval flows for risky actions) and output checks (format, claims, compliance) are standard guardrail layers.
- Source: [FareedKhan-dev/agentic-guardrails](https://github.com/FareedKhan-dev/agentic-guardrails), [Building Production-Ready Guardrails](https://ssahuupgrad-93226.medium.com/building-production-ready-guardrails-for-agentic-ai-a-defense-in-depth-framework-4ab7151be1fe)

### Recommended Direction

**Primary approach: In-repo skills + prompt decomposition, no runner changes.**

1. **`safe-shell-search` (core skill)**: Create at `skills/common/safe-shell-search/SKILL.md`. Encodes the current `<tooling_guidance>` block as a reusable skill: MCP pruner priority, investigation loop pattern, evidence-of-existence rules, shell fallback restrictions. This replaces the duplicated `<tooling_guidance>` block across prompts—prompts would reference the skill instead.

2. **`jeeves-task-spec-check` (adapter skill)**: Create at `skills/implement/jeeves-task-spec-check/SKILL.md`. Encodes the Jeeves-specific artifact contracts (`phase-report.json` schema, `task-feedback.md` format, `filesAllowed` enforcement rules, MCP state tool usage for status updates). This extracts the Jeeves-specific operational logic from the monolithic `task.spec_check.md` prompt into a composable skill.

3. **Registry integration**: Update `skills/registry.yaml` to map `task_spec_check → [safe-shell-search, jeeves-task-spec-check, code-quality]`. While registry.yaml isn't consumed by code yet, this establishes the intended phase-skill binding.

4. **Prompt simplification**: Slim down `prompts/task.spec_check.md` to focus on the core verification workflow (load task → verify criteria → produce verdict) while delegating tooling guidance and artifact contracts to the skills. Remove duplicated `<tooling_guidance>` blocks from all prompts.

5. **Opt-in rollout**: Use `issue.json.status.settings.useLayeredSkills: true|false` as the feature flag. When false, existing prompts work unchanged. When true, the simplified prompt + skills are used. This follows the established settings pattern.

6. **Data model**: Add task spec-check evidence schema to skill references (structured PASS/FAIL/INCONCLUSIVE per criterion with evidence type, location, and confidence).

### Alternatives Considered

- **Runner-level skill injection**: Modify `packages/runner/src/runner.ts` to read `registry.yaml` and inject skill content into prompts based on phase. **Rejected**: Adds complexity to the runner, requires build/test changes in core infrastructure, and isn't needed for MVP—AGENTS.md listing and prompt-level references already work.

- **MCP-based skill server**: Create a new MCP server that exposes skill content as tools. **Rejected**: Over-engineering for the current need. Skills are instruction-only (no runtime behavior), so MCP tools add latency without benefit.

- **Inline prompt expansion only**: Keep everything in prompts but factor out shared blocks into partial templates. **Rejected**: Doesn't leverage the existing skill infrastructure, and prompt partials aren't supported by the runner.

- **Full migration of all phases to skills**: Migrate every `<tooling_guidance>` block and phase-specific logic into skills. **Rejected**: Too broad for MVP. Focus on `task_spec_check` first, validate the pattern, then extend.

### Risks and Unknowns

- **Skill discovery gap**: The in-repo `skills/` directory is not currently surfaced to agents via AGENTS.md. The AGENTS.md listing comes from `/codex/skills/` (external). **Mitigation**: Either (a) copy new skills to `/codex/skills/` during deployment, or (b) add a build step that generates AGENTS.md skill listings from `skills/registry.yaml`. Need to determine which path during workflow design.
- **Context window cost**: Adding two new skills increases metadata overhead in every context window by ~200 words (2 × ~100-word descriptions). Full SKILL.md bodies add more when triggered. **Mitigation**: Keep skill bodies concise (<200 lines each); use progressive disclosure for reference materials.
- **Regression risk**: Simplifying `task.spec_check.md` could lose nuanced guidance that skills don't capture. **Mitigation**: The opt-in flag allows A/B comparison. Keep original prompt as fallback. Validate with replay/simulation before defaulting.
- **Registry consumption**: `skills/registry.yaml` is currently an unused design artifact. Implementation of phase-skill provisioning code is needed but is out of scope for the core skill creation. **Mitigation**: Accept that registry is declarative documentation for now; actual provisioning can follow in a separate issue.
- **Parallel runner interaction**: `task_spec_check` runs in waves via `parallelRunner.ts`. Skills must not introduce state that conflicts with parallel execution (e.g., shared mutable files). **Mitigation**: Skills are stateless instructions; all mutable state flows through MCP state tools which are per-issue-directory.

### Sources

- `prompts/task.spec_check.md` — current spec check prompt with embedded guardrails
- `prompts/task.implement.md` — implementation prompt with tooling guidance
- `workflows/default.yaml` — phase definitions and transitions
- `skills/registry.yaml` — phase-to-skill mapping (design artifact)
- `skills/review/code-quality/SKILL.md` — current skill for task_spec_check
- `skills/common/jeeves/SKILL.md` — existing Jeeves common skill pattern
- `/codex/skills/.system/skill-creator/SKILL.md` — official skill creation guide
- `packages/runner/src/runner.ts` — prompt prepending and instruction injection
- `packages/runner/src/mcpConfig.ts` — MCP profile definitions
- `packages/core/src/issueState.ts` — issue state schema (passthrough settings)
- `packages/core/src/workflow.ts` — phase/transition type system
- `apps/viewer-server/src/parallelRunner.ts` — wave-based parallel execution
- `docs/integrated-skills.md` — skill catalog and phase mappings
- [OpenAI Codex Skills Documentation](https://developers.openai.com/codex/skills)
- [Codex Skills Repository](https://github.com/openai/skills)
- [Layered Guardrails for Agentic AI](https://github.com/FareedKhan-dev/agentic-guardrails)

---

## 1. Scope

### Problem
`task_spec_check` and related task-loop execution still depend mostly on prompt-only guidance, which causes recurring command hygiene mistakes and inconsistent evidence quality across runs. We need reusable operational guardrails that can be applied consistently without hard-coding everything into phase prompts.

### Goals
- [ ] Ship a two-layer skill architecture definition that separates reusable core skills from Jeeves-specific adapters.
- [ ] Implement a reusable core skill `safe-shell-search` and make it available to checker workflows.
- [ ] Implement a Jeeves adapter skill `jeeves-task-spec-check` with explicit artifact contracts for issue/task/progress/task-feedback state files.
- [ ] Integrate layered skill usage into `task_spec_check` behind an opt-in toggle with a documented fallback path.
- [ ] Define validation/replay criteria that compare baseline behavior vs layered-skill behavior for command errors and evidence quality.

### Non-Goals
- Migrating every workflow phase to layered skills in this change.
- Changing model/provider strategy, SDK provider selection, or broader runner architecture.
- Redesigning unrelated task-loop semantics (for example task scheduling/parallel execution behavior).

### Boundaries
- **In scope**: Skill-layer architecture and ownership, new core + adapter skills for MVP, task-spec-check integration path, opt-in rollout control, and validation/replay expectations.
- **Out of scope**: Full-surface skill migration, unrelated viewer UX changes, and non-skill workflow refactors.

---

## 2. Workflow

Scope: task-loop workflow from `implement_task` through `task_spec_check`, including retry/error paths and handoff to completeness verification. Upstream design phases and downstream PR/review phases are unchanged.

### States
| State | Description | Entry Condition |
|-------|-------------|-----------------|
| `implement_task` | Implements the current task (sequential run or parallel implement wave). | Entered from `pre_implementation_check`, `task_spec_check` retry transitions, or `completeness_verification` when missing work is detected. |
| `spec_check_mode_select` | Resolves which spec-check operating mode to run. | Entered after successful `implement_task` completion (exit code `0`, no stop request). |
| `spec_check_legacy` | Runs current monolithic `task.spec_check.md` behavior. | Entered when `status.settings.useLayeredSkills != true` (missing/false/invalid) or layered-skill prerequisites are unavailable. |
| `spec_check_layered` | Runs simplified `task.spec_check` flow plus layered skills (`safe-shell-search` + `jeeves-task-spec-check` + `code-quality`). | Entered when `status.settings.useLayeredSkills == true` and required skills are available. |
| `spec_check_persist` | Commits/verifies status updates and produces canonical artifacts for transition guards. | Entered after either spec-check mode completes verification. |
| `parallel_timeout_recovery` | Handles timeout cleanup for active parallel waves so workflow remains resumable. | Entered when implement/spec-check wave exceeds iteration or inactivity timeout. |
| `merge_conflict_recovery` | Converts merge-conflict outcomes into retryable canonical state. | Entered when spec-check wave merge step reports a conflict. |
| `fix_ci` | Repairs commit/push failures detected during task loop. | Entered when `status.commitFailed == true` or `status.pushFailed == true` after `spec_check_persist`. |
| `completeness_verification` | Validates all tasks against the full design before PR preparation. | Entered when `status.allTasksComplete == true` after `spec_check_persist`. |
| `run_stopped_setup_failure` | **Terminal for current run instance.** Orchestrator stops immediately due to setup/orchestration failure. | Entered from implement/spec-check execution on sandbox/spawn/no-active-wave setup failure. |
| `task_loop_handoff` | **Terminal for this subsystem.** Task loop exits to PR pipeline (`prepare_pr`). | Entered when `completeness_verification` sets `status.implementationComplete == true`. |

Initial state (for this subsystem): `implement_task` after `pre_implementation_check` passes, or when retry transitions route back from `task_spec_check`/`completeness_verification`.

Terminal states:
- `run_stopped_setup_failure`: terminal because run manager sets `completion_reason` to setup failure and exits current run loop.
- `task_loop_handoff`: terminal for task-loop scope because control transitions to `prepare_pr` workflow segment.

### Transitions
| From | Event/Condition | To | Side Effects |
|------|-----------------|-----|--------------|
| `implement_task` | `control.restartPhase == true` | `implement_task` | Keeps phase unchanged; clears `control.restartPhase` after transition commit. |
| `implement_task` | Phase exits `0` and stop not requested | `spec_check_mode_select` | Writes iteration artifacts; in sequential mode commits orchestrator-owned status updates from `.jeeves/phase-report.json`/inferred diff. |
| `implement_task` | Parallel wave timeout (`iteration_timeout` or `inactivity_timeout`) | `parallel_timeout_recovery` | Marks wave tasks failed, writes synthetic `task-feedback/<taskId>.md`, clears `status.parallel`, appends timeout progress entry. |
| `implement_task` | Parallel setup failure (sandbox create/spawn/orchestration error) | `run_stopped_setup_failure` | Rolls back task reservations, clears/avoids stale `status.parallel`, writes wave setup-failure summary, sets run `last_error` and `completion_reason=setup_failure`. |
| `spec_check_mode_select` | `status.settings.useLayeredSkills == true` and skills resolvable | `spec_check_layered` | Records layered mode choice in iteration diagnostics/progress context. |
| `spec_check_mode_select` | Flag missing/false/invalid | `spec_check_legacy` | Defaults safely to legacy mode; logs mode-selection rationale. |
| `spec_check_mode_select` | Flag true but skill resolution fails | `spec_check_legacy` | Logs fallback warning; avoids blocking task loop on provisioning issues. |
| `spec_check_legacy` | Verification completes | `spec_check_persist` | Produces PASS/FAIL evidence, updates task status via MCP/state writes, writes `.jeeves/phase-report.json` and optional feedback artifact. |
| `spec_check_layered` | Verification completes | `spec_check_persist` | Same persisted contract as legacy mode; operational guidance comes from layered skills instead of inline prompt blocks. |
| `spec_check_legacy` | Parallel wave timeout | `parallel_timeout_recovery` | Same timeout cleanup as implement wave, plus spec-check-specific failure feedback. |
| `spec_check_layered` | Parallel wave timeout | `parallel_timeout_recovery` | Same timeout cleanup as implement wave, plus spec-check-specific failure feedback. |
| `spec_check_legacy` | Merge conflict while integrating passed worker branches | `merge_conflict_recovery` | Writes synthetic merge-conflict feedback, preserves failure flags for retry, appends combined wave progress summary. |
| `spec_check_layered` | Merge conflict while integrating passed worker branches | `merge_conflict_recovery` | Same as legacy mode merge-conflict handling. |
| `spec_check_legacy` | Setup failure (`No active wave state`/spawn/sandbox error in parallel mode) | `run_stopped_setup_failure` | Stops run immediately with setup-failure reason; leaves canonical state resumable (no orphaned in-progress wave). |
| `spec_check_layered` | Setup failure (`No active wave state`/spawn/sandbox error in parallel mode) | `run_stopped_setup_failure` | Same immediate-stop handling as legacy mode. |
| `spec_check_persist` | `status.commitFailed == true` | `fix_ci` | Transition by workflow guard priority 1; CI-fix phase becomes responsible for repair then auto-return. |
| `spec_check_persist` | `status.pushFailed == true` | `fix_ci` | Transition by workflow guard priority 2. |
| `spec_check_persist` | `status.taskFailed == true` | `implement_task` | Transition by workflow guard priority 3; retry same/current task after feedback. |
| `spec_check_persist` | `status.taskPassed == true && status.hasMoreTasks == true` | `implement_task` | Transition by workflow guard priority 4; advances to next pending task. |
| `spec_check_persist` | `status.allTasksComplete == true` | `completeness_verification` | Transition by workflow guard priority 5. |
| `parallel_timeout_recovery` | Timeout occurred during `implement_task` wave | `implement_task` | Keeps canonical phase retryable at `implement_task`; next run re-schedules ready tasks. |
| `parallel_timeout_recovery` | Timeout occurred during `task_spec_check` wave | `implement_task` | Sets `taskFailed=true`/`hasMoreTasks=true`; workflow engine transitions `task_spec_check -> implement_task` on resume. |
| `merge_conflict_recovery` | Conflict flags persisted (`taskFailed=true`, `hasMoreTasks=true`) | `implement_task` | Workflow engine transition back to implementation retry loop. |
| `fix_ci` | Phase succeeds (auto transition) | `spec_check_mode_select` | Returns to task spec-check path; preserves task-loop status context. |
| `completeness_verification` | `status.missingWork == true` | `implement_task` | Re-enters implementation loop for uncovered requirements. |
| `completeness_verification` | `status.implementationComplete == true` | `task_loop_handoff` | Exits subsystem; canonical phase becomes `prepare_pr`. |

Transition evaluation order is deterministic: transitions are sorted by ascending `priority` in workflow loading, then evaluated in-order (`auto` first match, otherwise first true `when` guard).

Transition reversibility:
- Reversible: `implement_task <-> task_spec_check` retry loop (`taskFailed`, `hasMoreTasks`, merge/timeout recovery), `fix_ci -> spec_check_mode_select`, and `completeness_verification -> implement_task`.
- Irreversible in-run: transitions to `run_stopped_setup_failure` (requires new run start) and `task_loop_handoff` (leaves task-loop subsystem).

### Error Handling
| State | Error | Recovery State | Actions |
|-------|-------|----------------|---------|
| `implement_task` | Runner exits non-zero (sequential) | `implement_task` | Logs iteration failure; orchestrator ignores transition updates for non-zero exit and retries next iteration in same phase. |
| `implement_task` | Parallel implement wave timeout | `parallel_timeout_recovery` | Marks all active wave tasks `failed`, writes synthetic feedback per task, clears `status.parallel`, appends timeout progress entry. |
| `implement_task` | Sandbox creation/worker spawn failure | `run_stopped_setup_failure` | Terminates started workers, rolls back reserved task statuses, writes setup-failure wave summary/progress, stops run immediately. |
| `spec_check_mode_select` | Invalid `status.settings.useLayeredSkills` type/value | `spec_check_legacy` | Defaults to legacy mode, records warning, proceeds without blocking. |
| `spec_check_legacy` | Criterion unverifiable / filesAllowed violation | `spec_check_persist` | Sets failure flags (`taskFailed=true`, `hasMoreTasks=true`, `allTasksComplete=false`), writes task feedback artifact, records criterion-level evidence. |
| `spec_check_layered` | Criterion unverifiable / filesAllowed violation | `spec_check_persist` | Same canonical failure contract as legacy mode; failure remains retryable. |
| `spec_check_legacy` | Invalid/mismatched `.jeeves/phase-report.json` (schema/phase/object errors) | `spec_check_persist` | Parses with warnings, filters/normalizes allowed keys, emits audit report with `validationErrors`, logs `[PHASE_REPORT] warning`. |
| `spec_check_layered` | Invalid/mismatched `.jeeves/phase-report.json` (schema/phase/object errors) | `spec_check_persist` | Same parsing/audit behavior as legacy mode. |
| `spec_check_legacy` | Parallel spec-check wave timeout | `parallel_timeout_recovery` | Marks all wave tasks failed regardless of individual outcomes, writes synthetic timeout feedback, clears `status.parallel`, persists retry flags. |
| `spec_check_layered` | Parallel spec-check wave timeout | `parallel_timeout_recovery` | Same timeout cleanup as legacy mode. |
| `spec_check_legacy` | Spec-check merge conflict | `merge_conflict_recovery` | Writes merge-conflict synthetic feedback, keeps retry flags true, appends progress summary including conflict task. |
| `spec_check_layered` | Spec-check merge conflict | `merge_conflict_recovery` | Same merge-conflict handling as legacy mode. |
| `spec_check_legacy` | No active parallel wave state for spec check / setup-orchestration error | `run_stopped_setup_failure` | Stops run with setup failure reason; prevents entering stuck `task_spec_check` with missing wave context. |
| `spec_check_layered` | No active parallel wave state for spec check / setup-orchestration error | `run_stopped_setup_failure` | Same immediate-stop behavior as legacy mode. |
| `fix_ci` | CI-fix phase exits non-zero | `fix_ci` | Phase remains `fix_ci`; run logs error and retries on next iteration. |
| `completeness_verification` | Verification exits non-zero | `completeness_verification` | Phase remains unchanged; no transition applied until valid status flags are produced. |

Global vs per-state handling:
- Per-state: parallel timeout, merge conflict, reservation rollback, and phase mismatch correction are handled in `parallelRunner`.
- Global: run-level exceptions are caught in `runManager`, which sets `last_error`, `completion_reason`, broadcasts status, and ends the run safely.

### Crash Recovery
- **Detection**:
  - At run start, scan for orphaned `tasks.json` entries with `status="in_progress"` that are not in `issue.json.status.parallel.activeWaveTaskIds`.
  - On entering a parallel phase, detect persisted `status.parallel` to resume an active wave.
  - Detect corruption when canonical `issue.json.phase` does not match `status.parallel.activeWavePhase`.
  - Detect invalid parallel state shape/path IDs (`runId`, `activeWaveId`, task IDs) during `readParallelState`.
- **Recovery state**:
  - Resume into the canonical phase (`implement_task` or `task_spec_check`) using persisted `status.parallel.runId`.
  - If phase mismatch exists, correct `activeWavePhase` to canonical phase, append corruption warning, then resume.
  - If recovery cannot establish valid wave context (setup failure), stop current run (`run_stopped_setup_failure`) and require a new run.
- **Cleanup**:
  - Repair orphaned tasks (`in_progress -> failed`) and write canonical recovery feedback files.
  - Roll back reserved task statuses when setup fails.
  - Kill active worker processes on timeout/spawn failure.
  - Clear `issue.json.status.parallel` after timeout/cleanup so workflow remains resumable.
  - Persist progress entries for recovery actions and timeout/corruption events.

### Subprocesses (if applicable)
| Subprocess | Receives | Can Write | Failure Handling |
|------------|----------|-----------|------------------|
| `sdk_runner` (sequential phase subprocess) | `workflow`, `phase`, `provider`, `--workflows-dir`, `--prompts-dir`, canonical `--state-dir`, canonical `--work-dir`, optional model env. | Canonical issue/task/progress via MCP state tools; `.jeeves/phase-report.json`; `.jeeves/task-feedback.md` (phase-permitted). | Non-zero exit keeps phase for retry; transition status updates are ignored on non-zero exits; iteration/inactivity timeout stops run safely. |
| `parallel worker runner` (per-task subprocess) | Same runner args but worker sandbox `--state-dir`/`--work-dir`; env includes `JEEVES_DATA_DIR`, `JEEVES_RUN_TASK_ID`, optional `JEEVES_MODEL`. | Worker-local issue/task artifacts under `.runs/<runId>/workers/<taskId>/`; worker `task-feedback.md` copied to canonical `task-feedback/<taskId>.md` when relevant; contributes to canonical wave summaries. | Spawn/sandbox failure: terminate started workers, rollback reservations, setup-failure stop. Timeout: SIGKILL active workers, mark all wave tasks failed, synthesize feedback, clear `status.parallel`. Merge conflict: synthesize conflict feedback and force retry flags. |

## 3. Interfaces

N/A - This feature does not add or modify external interfaces.

## 4. Data

### Schema Changes
| Location | Field | Type | Required | Default | Constraints |
|----------|-------|------|----------|---------|-------------|
| `issue.json` | `status.settings.useLayeredSkills` | boolean | no | `false` | Only literal `true` enables layered mode. `false`, missing, or invalid types must route to `spec_check_legacy` and emit a warning. |
| `skills/registry.yaml` | `phases.task_spec_check` | string[] | yes | `["code-quality"]` | Ordered skill IDs. Target mapping for this feature: `["safe-shell-search", "jeeves-task-spec-check", "code-quality"]`. IDs must match concrete skill directory names. |
| `.jeeves/phase-report.json` | `reasons` | string[] | no | `[]` | Keep only non-empty strings; non-array values are ignored. |
| `.jeeves/phase-report.json` | `evidenceRefs` | string[] | no | `[]` | Keep only non-empty strings; each entry must point to evidence (`<path>:<line>`, command, or artifact ref). Non-array values are ignored. |
| `skills/implement/jeeves-task-spec-check/references/evidence-schema.json` | `criteria[].verdict` | string | yes | none | Enum: `PASS`, `FAIL`, `INCONCLUSIVE`. |
| `skills/implement/jeeves-task-spec-check/references/evidence-schema.json` | `criteria[].evidence[].confidence` | number | yes | none | Closed interval `[0, 1]`. |

### Field Definitions
**`status.settings.useLayeredSkills`**
- Purpose: Per-issue rollout flag for layered `task_spec_check` skills.
- Set by: Issue configuration (manual or viewer-side settings write).
- Read by: `spec_check_mode_select` transition guard before entering `spec_check_layered`.
- Derived: No.

**`phases.task_spec_check`**
- Purpose: Declarative skill ordering for `task_spec_check`.
- Set by: Repository configuration updates in `skills/registry.yaml`.
- Read by: Skill provisioning/deployment logic (current runtime does not consume `registry.yaml` directly).
- Derived: No.

**`.jeeves/phase-report.json.reasons` and `.jeeves/phase-report.json.evidenceRefs`**
- Purpose: Persist structured rationale/evidence references from spec-check output into orchestrator audit output.
- Set by: `task_spec_check` phase output.
- Read by: `RunManager.parsePhaseReportFile()` / `RunManager.commitOrchestratorOwnedPhaseState()`.
- Derived: No (agent-provided; normalized on parse).

**`criteria[].verdict` and `criteria[].evidence[].confidence`**
- Purpose: Normalize criterion-level evidence shape for `jeeves-task-spec-check` skill references.
- Set by: Spec-check evaluation logic when building criterion evidence records.
- Read by: Human reviewers and future automated validators/replay tooling.
- Derived: Yes (computed from acceptance criteria + observed evidence for the current run).

### Relationship & Ordering
- `status.settings.useLayeredSkills` references skill availability (`safe-shell-search`, `jeeves-task-spec-check`, `code-quality`) in the active skill set.
- If referenced skills are unavailable, mode selection must fall back to `spec_check_legacy`; no hard failure.
- `criteria[]` evidence records reference task acceptance criteria (`tasks.json.tasks[].acceptanceCriteria`).
- If task definitions are deleted or changed, historical evidence remains in archived run artifacts and is treated as historical-only.
- Ordering dependency: `useLayeredSkills` is read in `spec_check_mode_select` after `implement_task` exits `0` and before either spec-check mode executes. Mid-iteration flag changes apply on the next iteration.

### Migrations
| Change | Existing Data | Migration | Rollback |
|--------|---------------|-----------|----------|
| Add `status.settings.useLayeredSkills` | Field absent in existing `issue.json` records | No script. Treat absent as `false` at read time; only `true` opts in. | Remove field; behavior returns to legacy mode by default. |
| Update `skills/registry.yaml` mapping for `task_spec_check` | Existing mapping is `["code-quality"]` | Update ordered list to `["safe-shell-search", "jeeves-task-spec-check", "code-quality"]`. | Revert list to previous value. |
| Standardize optional `.jeeves/phase-report.json` arrays (`reasons`, `evidenceRefs`) | Reports may omit arrays | No script. On read, default missing/invalid arrays to `[]`. | Stop emitting fields; parser behavior remains backward-compatible. |
| Add `evidence-schema.json` reference contract | No prior structured criterion evidence schema file | Add new reference file under `skills/implement/jeeves-task-spec-check/references/`. | Delete reference file and revert consumers to legacy prose-only guidance. |

### Artifacts
| Artifact | Location | Created | Updated | Deleted |
|----------|----------|---------|---------|---------|
| Spec-check phase report | `.jeeves/phase-report.json` | Each iteration after phase execution (agent-file or inferred) | Overwritten each iteration with audit-normalized report | Cleared at iteration start before phase run |
| Sequential retry feedback | `.jeeves/task-feedback.md` | On spec-check FAIL in sequential mode | Overwritten on subsequent FAILs | Cleared by retry implementation flow after consumption |
| Canonical per-task feedback (parallel) | `.jeeves/task-feedback/<taskId>.md` | When copying worker feedback or synthesizing timeout/merge-conflict feedback | Overwritten on later failures for same task | Not auto-deleted; replaced or manually cleaned |
| Layered shell-search skill | `skills/common/safe-shell-search/SKILL.md` | Once when feature is implemented | Versioned by repository edits | Deleted only on feature rollback/removal |
| Jeeves spec-check adapter skill | `skills/implement/jeeves-task-spec-check/SKILL.md` | Once when feature is implemented | Versioned by repository edits | Deleted only on feature rollback/removal |
| Criterion evidence reference schema | `skills/implement/jeeves-task-spec-check/references/evidence-schema.json` | Once when feature is implemented | Updated when evidence contract evolves | Deleted only on feature rollback/removal |
| Skill phase mapping | `skills/registry.yaml` | Already exists | Updated to include layered task-spec-check mapping | Never auto-deleted (manual rollback only) |

### Artifact Lifecycle
| Scenario | Artifact Behavior |
|----------|-------------------|
| Success | `.jeeves/phase-report.json` is written with committed status updates and archived under `.runs/<runId>/iterations/<n>/phase-report.json`; failure feedback artifacts are not required. |
| Failure | `.jeeves/phase-report.json` is still written with normalized failure updates; sequential flow writes `.jeeves/task-feedback.md`; parallel flow writes `.jeeves/task-feedback/<taskId>.md` (copied or synthetic). |
| Crash recovery | If no valid phase-report exists, status updates are inferred from issue-state diff and a normalized phase report is written on next run; timeout/merge cleanup marks affected tasks failed, writes synthetic canonical feedback, and clears `status.parallel`. Static skill/registry files are unchanged by run crashes. |

### Data Gate Answers
1. Field paths are explicitly listed in the Schema Changes table.
2. Field types are explicitly listed (`boolean`, `string[]`, `string`, `number`).
3. Required vs optional is explicitly listed per field.
4. Default behavior for absent values is explicitly listed per field.
5. Constraints are explicit (enums, ordering, non-empty strings, `[0,1]` range).
6. References: rollout flag references skill availability; evidence records reference task acceptance criteria.
7. On referenced-data deletion: mode falls back to legacy for missing skills; historical evidence remains archived and is not backfilled.
8. Ordering dependency: flag is read in `spec_check_mode_select` before mode entry; criterion evidence is computed during spec-check after task load.
9. Breaking change: No; all additions are backward-compatible and additive.
10. Existing records without new fields: handled via defaults (`false` or `[]`).
11. Migration script: Not required.
12. Rollback: remove new flag/reference file and revert registry mapping; runtime remains compatible.
13. Derived fields: criterion verdict/evidence confidence are derived from observed validation evidence.
14. Derived computation timing: on write during spec-check execution.
15. Source-data change handling: rerun spec-check to regenerate evidence; previous run artifacts remain immutable history.
16. Artifacts created are explicitly listed in the Artifacts table.
17. Artifact storage locations are explicitly listed in the Artifacts table.
18. Artifact create/update/delete timing is explicitly listed in the Artifacts table.
19. Success/failure/crash behavior is explicitly listed in the Artifact Lifecycle table.

## 5. Tasks

### Planning Gates

#### Decomposition Gates
1. **Smallest independently testable unit**: One scoped artifact change with its own verification command (for example, adding one skill with trigger metadata and instruction contract, or adding one workflow-state transition and asserting it in a workflow test).
2. **Dependencies between tasks**: Yes. Workflow/prompt wiring depends on skill artifacts existing; runner parallel-phase updates depend on workflow phase names being finalized; replay validation depends on all prior implementation work.
3. **Parallelizable work**: Yes. Skill authoring and docs/registry updates can run in parallel after shared naming is agreed; runner changes and test authoring can run in parallel after workflow YAML shape is committed.

#### Task Completeness Gates
4. **Specific files**: Listed explicitly per task below (no wildcard-only tasks).
5. **Acceptance criteria**: Listed per task as concrete, observable outcomes.
6. **Verification command**: Listed per task (targeted `vitest`, `rg`, or JSON parse command).

#### Ordering Gates
7. **Must be done first**: Define/commit canonical skill IDs and workflow phase names (`safe-shell-search`, `jeeves-task-spec-check`, `spec_check_*`) so downstream wiring/tests target stable names.
8. **Can only be done last**: Baseline-vs-layered replay validation and final regression pass, because it depends on completed skills + workflow + runner wiring.
9. **Circular dependencies**: None. DAG is strictly acyclic (see graph below).

#### Infrastructure Gates
10. **Build/config changes needed**: Yes. `workflows/default.yaml` phase graph changes and `skills/registry.yaml` mapping updates.
11. **New dependencies required**: None.
12. **New environment variables/secrets required**: None.

### Goal Coverage
- Goal 1 (two-layer architecture): `T1`, `T2`, `T4`
- Goal 2 (`safe-shell-search` available to checker workflows): `T1`, `T4`
- Goal 3 (`jeeves-task-spec-check` adapter): `T2`
- Goal 4 (opt-in layered integration + fallback): `T3`, `T4`
- Goal 5 (validation/replay criteria): `T5` + Section 6 replay checks

### Task Dependency Graph
```
T1 (no deps)
T2 (no deps)
T3 -> depends on T1, T2
T4 -> depends on T3
T5 -> depends on T3, T4
```

### Task Breakdown
| ID | Title | Summary | Files | Acceptance Criteria |
|----|-------|---------|-------|---------------------|
| T1 | Add `safe-shell-search` Core Skill | Create reusable guardrail skill that replaces duplicated tooling-guidance behavior for search/read evidence hygiene. | `skills/common/safe-shell-search/SKILL.md` (new), `AGENTS.md` | Skill exists with explicit trigger/usage metadata; instructions require pruner-first discovery/read loop, evidence-grounded claims, and shell-fallback justification; skill is discoverable in workspace instructions. |
| T2 | Add `jeeves-task-spec-check` Adapter Skill + Evidence Schema | Create Jeeves-specific checker skill and structured criterion evidence schema. | `skills/implement/jeeves-task-spec-check/SKILL.md` (new), `skills/implement/jeeves-task-spec-check/references/evidence-schema.json` (new) | Adapter skill encodes state/artifact contracts (`state_*`, `.jeeves/phase-report.json`, `.jeeves/task-feedback.md`, `filesAllowed`); evidence schema enforces `PASS|FAIL|INCONCLUSIVE` verdicts and confidence range `[0,1]`; schema is valid JSON and referenced by skill. |
| T3 | Implement Layered Spec-Check Workflow and Prompt Split | Introduce mode-select + legacy/layered/persist states and wire transitions/guards for opt-in rollout and fallback behavior. | `workflows/default.yaml`, `prompts/task.spec_check.md`, `prompts/task.spec_check.layered.md` (new), `prompts/task.spec_check.mode_select.md` (new), `prompts/task.spec_check.persist.md` (new), `packages/core/src/workflowLoader.test.ts` | Workflow contains `spec_check_mode_select`, `spec_check_legacy`, `spec_check_layered`, and `spec_check_persist` with priority-ordered transitions matching Section 2; `status.settings.useLayeredSkills == true` routes to layered mode, otherwise legacy; fallback path to legacy is explicit when layered prerequisites are not met; workflow loader tests cover new phase presence/transition expectations. |
| T4 | Update Runner/Parallel Handling for New Spec-Check Phases | Extend runtime parallel/task-loop handling, timeout/merge/setup recovery, and phase-report status filtering for new state names. | `apps/viewer-server/src/runManager.ts`, `apps/viewer-server/src/parallelRunner.ts`, `apps/viewer-server/src/runManager.test.ts`, `apps/viewer-server/src/parallelRunner.test.ts` | Parallel execution recognizes layered/legacy spec-check phases without regressions to implement-wave behavior; timeout/merge-conflict recovery remains resumable and routes back to `implement_task` as designed; setup failures still stop run with setup-failure completion reason; tests cover phase transitions and recovery paths for new states. |
| T5 | Register, Document, and Replay-Validate Layered Mode | Publish phase-skill mapping/docs and codify baseline-vs-layered validation procedure. | `skills/registry.yaml`, `docs/integrated-skills.md`, `docs/issue-108-design.md` (Section 6 replay criteria), `apps/viewer-server/src/runManager.test.ts` | `task_spec_check` registry mapping is ordered as `safe-shell-search`, `jeeves-task-spec-check`, `code-quality`; integrated-skills docs reflect new mapping; replay criteria define measurable comparisons for command hygiene errors and evidence quality; tests assert phase-report `reasons`/`evidenceRefs` normalization and persistence behavior used by replay analysis. |

### Task Details

**T1: Add `safe-shell-search` Core Skill**
- Summary: Introduce a reusable core skill that standardizes safe codebase discovery/read behavior and evidence discipline.
- Files:
  - `skills/common/safe-shell-search/SKILL.md` - New skill instructions (pruner-first search/read loop, evidence constraints, fallback policy).
  - `AGENTS.md` - Add discoverable skill entry so task-spec-check workflows can trigger it.
- Acceptance Criteria:
  1. `safe-shell-search` skill metadata and trigger wording are present and unambiguous.
  2. Skill includes the required investigation loop and shell fallback justification requirements.
  3. Skill is listed in available skills metadata used by runner-prepended instructions.
- Dependencies: None
- Verification: `rg -n "safe-shell-search|pruner|fallback|investigation" skills/common/safe-shell-search/SKILL.md AGENTS.md`

**T2: Add `jeeves-task-spec-check` Adapter Skill + Evidence Schema**
- Summary: Move Jeeves-specific spec-check contracts into an adapter skill with a structured evidence reference schema.
- Files:
  - `skills/implement/jeeves-task-spec-check/SKILL.md` - New adapter skill with explicit task-state and artifact write contract.
  - `skills/implement/jeeves-task-spec-check/references/evidence-schema.json` - New schema for criterion verdict/evidence records.
- Acceptance Criteria:
  1. Adapter skill prescribes PASS/FAIL handling using MCP state tools and canonical `.jeeves` artifacts.
  2. Evidence schema defines `criteria[].verdict` enum `PASS|FAIL|INCONCLUSIVE`.
  3. Evidence schema defines `criteria[].evidence[].confidence` numeric range `[0,1]`.
- Dependencies: None
- Verification: `pnpm exec node -e "const fs=require('fs'); JSON.parse(fs.readFileSync('skills/implement/jeeves-task-spec-check/references/evidence-schema.json','utf8')); console.log('ok')"`

**T3: Implement Layered Spec-Check Workflow and Prompt Split**
- Summary: Replace the single `task_spec_check` step with explicit mode-selection and layered/legacy flow phases.
- Files:
  - `workflows/default.yaml` - Add new spec-check states/transitions and ordered guards per Section 2.
  - `prompts/task.spec_check.md` - Keep legacy behavior (or repoint as legacy wrapper) to preserve fallback.
  - `prompts/task.spec_check.layered.md` - New layered prompt delegating guardrails/contracts to skills.
  - `prompts/task.spec_check.mode_select.md` - New mode-selection prompt outputting deterministic mode choice context.
  - `prompts/task.spec_check.persist.md` - New persist phase prompt that finalizes artifact/transition handoff.
  - `packages/core/src/workflowLoader.test.ts` - Update default-workflow assertions for new phase graph.
- Acceptance Criteria:
  1. Workflow transitions from `implement_task` to `spec_check_mode_select`, then deterministically to layered or legacy path.
  2. `status.settings.useLayeredSkills == true` is the only flag value that opts into layered mode.
  3. Legacy fallback remains default for missing/false/invalid flag values or unresolved layered prerequisites.
  4. Workflow YAML parses/loads successfully in automated tests.
- Dependencies: `T1`, `T2`
- Verification: `pnpm exec vitest run packages/core/src/workflowLoader.test.ts`

**T4: Update Runner/Parallel Handling for New Spec-Check Phases**
- Summary: Make runtime orchestration resilient to the new spec-check phase names and preserve timeout/merge/setup recovery guarantees.
- Files:
  - `apps/viewer-server/src/runManager.ts` - Expand parallel-phase routing and transition/status commit behavior for new phases.
  - `apps/viewer-server/src/parallelRunner.ts` - Generalize worker phase handling from `task_spec_check` to layered/legacy spec-check phases.
  - `apps/viewer-server/src/runManager.test.ts` - Add/adjust tests for transition and phase-report behavior under new states.
  - `apps/viewer-server/src/parallelRunner.test.ts` - Add/adjust tests for timeout/merge/setup recovery with new phase names.
- Acceptance Criteria:
  1. Parallel mode runs spec-check waves correctly for layered and legacy spec-check phases.
  2. Timeout/merge-conflict recovery still yields a resumable canonical phase (`implement_task`) with no orphaned parallel state.
  3. Setup/orchestration failures still terminate run with setup-failure completion reason and rollback semantics.
  4. Transition status filtering/commit remains valid for new phase names.
- Dependencies: `T3`
- Verification: `pnpm exec vitest run apps/viewer-server/src/runManager.test.ts apps/viewer-server/src/parallelRunner.test.ts`

**T5: Register, Document, and Replay-Validate Layered Mode**
- Summary: Finalize phase-skill mapping/docs and add explicit baseline-vs-layered validation coverage.
- Files:
  - `skills/registry.yaml` - Update `phases.task_spec_check` ordered mapping.
  - `docs/integrated-skills.md` - Update phase mapping documentation.
  - `docs/issue-108-design.md` - Add replay validation criteria/checklist in Section 6.
  - `apps/viewer-server/src/runManager.test.ts` - Add assertions for `reasons`/`evidenceRefs` handling used by replay analysis.
- Acceptance Criteria:
  1. Registry mapping for `task_spec_check` is exactly `[safe-shell-search, jeeves-task-spec-check, code-quality]`.
  2. Docs reflect layered mapping and rollout expectations.
  3. Replay criteria specify how to compare baseline vs layered runs for command-hygiene errors and criterion evidence quality.
  4. Tests verify normalized `reasons`/`evidenceRefs` persistence in phase-report output.
- Dependencies: `T3`, `T4`
- Verification: `pnpm exec vitest run apps/viewer-server/src/runManager.test.ts -t "phase-report"`

## 6. Validation

### Pre-Implementation Checks
- [ ] All dependencies installed: `pnpm install`
- [ ] Workflow parses with no schema errors: `pnpm exec vitest run packages/core/src/workflowLoader.test.ts`
- [ ] Existing runner regressions baseline captured: `pnpm exec vitest run apps/viewer-server/src/runManager.test.ts apps/viewer-server/src/parallelRunner.test.ts`

### Post-Implementation Checks
- [ ] Types check: `pnpm typecheck`
- [ ] Lint passes: `pnpm lint`
- [ ] All tests pass: `pnpm test`
- [ ] Targeted workflow tests pass: `pnpm exec vitest run packages/core/src/workflowLoader.test.ts`
- [ ] Targeted runner tests pass: `pnpm exec vitest run apps/viewer-server/src/runManager.test.ts apps/viewer-server/src/parallelRunner.test.ts`
- [ ] New tests added for:
  - `packages/core/src/workflowLoader.test.ts` (new phase graph assertions)
  - `apps/viewer-server/src/runManager.test.ts` (mode/persist + phase-report reasons/evidenceRefs)
  - `apps/viewer-server/src/parallelRunner.test.ts` (layered/legacy phase recovery)

### Replay Validation (Baseline vs Layered)
- [ ] Run baseline with `status.settings.useLayeredSkills=false` and capture `viewer-run.log`, `.jeeves/phase-report.json`, and progress entries.
- [ ] Run layered mode with `status.settings.useLayeredSkills=true` on the same task set and capture the same artifacts.
- [ ] Compare command hygiene failures:
  - Baseline vs layered count of shell-first search violations.
  - Baseline vs layered count of unverifiable criterion claims.
- [ ] Compare evidence quality:
  - Layered runs include criterion-level verdict entries and non-empty evidence references for each evaluated criterion.
  - `phase-report.json` includes normalized `reasons[]`/`evidenceRefs[]` arrays when provided.
- [ ] Verify fallback:
  - With layered flag true and layered prerequisites unavailable, mode-select routes to legacy without run failure.

### Manual Verification
- [ ] Trigger one `task_spec_check` run in legacy mode and one in layered mode for the same task; confirm both complete the loop and land in the expected next phase.
- [ ] Validate timeout and merge-conflict recovery still return task loop to `implement_task` with retryable status flags.
