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
[To be completed in design_workflow phase]

## 3. Interfaces
[To be completed in design_api phase]

## 4. Data
[To be completed in design_data phase]

## 5. Tasks
[To be completed in design_plan phase]

## 6. Validation
[To be completed in design_plan phase]
