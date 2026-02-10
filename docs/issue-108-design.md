# Design: Layered Skills for Task Spec Check

**Issue**: #108
**Status**: Draft - Classification Complete
**Feature Types**: Primary: Workflow, Secondary: Data Model

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
