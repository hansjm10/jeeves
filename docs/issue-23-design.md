---
title: Task Decomposition Workflow for Context-Efficient Implementation
sidebar_position: 5
---

# Task Decomposition Workflow for Context-Efficient Implementation

## Document Control
- **Title**: Implement Task Decomposition Workflow for Context-Efficient Implementation
- **Authors**: Jeeves AI Agent
- **Reviewers**: Project maintainers
- **Status**: Draft
- **Last Updated**: 2025-01-29
- **Related Issues**: [#23](https://github.com/hansjm10/jeeves/issues/23)
- **Execution Mode**: AI-led

## 1. Summary

Large implementations exhaust agent context windows, causing loss of earlier decisions and degraded output quality. This design introduces a task decomposition workflow that splits implementation into small, scoped tasks created during design. Each task runs in a fresh context with only its specific scope, acceptance criteria, and file permissions. The system includes spec-accordance verification between tasks to ensure quality and correctness.

## 2. Context & Problem Statement

- **Background**: The current Jeeves workflow uses a single monolithic "implement" phase where an AI agent accumulates context as it works through the entire implementation. The workflow currently flows: `design_draft` → `design_review` → `implement` → `code_review` → `complete`.

- **Problem**: A single "implement" phase accumulates context as the agent works, eventually hitting token limits (~100k+ tokens on large features) or losing track of early decisions. This leads to:
  - Inconsistent code quality as context grows
  - Lost design decisions made early in implementation
  - Incomplete implementations when context is exhausted
  - Difficulty tracking progress on multi-file changes

- **Forces**:
  - Must maintain backward compatibility with existing workflows
  - Must integrate with existing prompt structure and workflow engine
  - Must support the existing `.jeeves/issue.json` state management pattern
  - Each task should use minimal context (~20k tokens) for consistent quality

## 3. Goals & Non-Goals

### Goals
1. **Task decomposition**: Design phase produces a structured task list with 5-15 small, scoped tasks
2. **Fresh context per task**: Each `implement_task` phase runs with only its specific task context
3. **Spec verification**: Every task passes acceptance criteria verification before advancing
4. **Retry mechanism**: Failed spec checks trigger task retry with feedback
5. **Completeness verification**: Final check ensures nothing was missed across all tasks
6. **File permission enforcement**: Each task can only modify its designated `filesAllowed` list

### Non-Goals
1. **Parallel task execution**: Tasks execute sequentially, not in parallel
2. **Cross-task state sharing**: Each task starts with fresh context, no accumulated state
3. **Dynamic task creation during implementation**: Tasks are fixed after task_decomposition phase
4. **Rollback capability**: No automatic rollback if tasks fail (manual intervention required)

## 4. Stakeholders, Agents & Impacted Surfaces

- **Primary Stakeholders**: Jeeves maintainers and users running AI-assisted development workflows
- **Agent Roles**:
  - **Task Decomposition Agent**: Reads design document, produces `tasks.json` with 5-15 small tasks
  - **Implementation Agent**: Implements a single task per invocation, respects file permissions
  - **Spec Check Agent**: Verifies acceptance criteria for current task, decides pass/retry
  - **Completeness Agent**: Final verification that full design is implemented
- **Affected Packages/Services**:
  - `src/jeeves/core/tasks.py` (new)
  - `src/jeeves/core/workflow.py` (minor updates for task context)
  - `src/jeeves/core/engine.py` (no changes - engine is stateless, evaluates guards)
  - `workflows/default.yaml` (new phases and transitions)
  - `prompts/` (4 new prompt files)
- **Compatibility Considerations**:
  - Existing workflows continue to work unchanged
  - New task-based flow is opt-in via design document task extraction
  - `issue.json` schema extended with `tasks` and `status` fields

## 5. Current State

### Current Workflow Structure
```
design_draft → design_review → implement → code_review → complete
```

### Current Files
- `src/jeeves/core/workflow.py`: Defines `Phase`, `Transition`, `Workflow`, `PhaseType` dataclasses
- `src/jeeves/core/engine.py`: Stateless `WorkflowEngine` that evaluates transitions against context
- `src/jeeves/core/guards.py`: Guard expression parser supporting `==`, `!=`, `and`, `or`
- `src/jeeves/core/issue.py`: `IssueState`, `GitHubIssue` dataclasses and JSON persistence
- `src/jeeves/core/write_checker.py`: `check_forbidden_writes()` using glob patterns
- `workflows/default.yaml`: Current workflow definition with 6 phases
- `prompts/implement.md`: Current monolithic implementation prompt

### Existing Task-Related Prompts (Partial Implementation)
The codebase already has partial task-related prompts that expect task tracking in `issue.json`:
- `prompts/issue.task.implement.md`: Task implementation with TDD approach
- `prompts/issue.task.spec-review.md`: Spec compliance review
- `prompts/issue.task.quality-review.md`: Code quality review

These prompts expect `issue.json.tasks` and `status.currentTaskId`, `status.taskStage` fields.

## 6. Proposed Solution

### 6.1 Architecture Overview

**Narrative**: After design approval, a new `task_decomposition` phase reads the design document and extracts a structured task list into `.jeeves/tasks.json`. Implementation then loops through tasks: for each task, `implement_task` executes the work (with file permission enforcement), then `task_spec_check` verifies acceptance criteria. If verification fails, the task retries with feedback. After all tasks complete, `completeness_verification` ensures nothing was missed before proceeding to code review.

**Workflow Diagram**:
```
design_review (approved)
    │
    ▼
task_decomposition (execute) ─── creates tasks.json
    │
    ▼
┌────────────────────────────────────────────────────────┐
│  implement_task (execute) ─── one task at a time       │
│       │                                                │
│       ▼                                                │
│  task_spec_check (evaluate) ─── verify criteria        │
│       │                                                │
│  [next task if passed, retry if failed]                │
└────────────────────────────────────────────────────────┘
    │ (all tasks complete)
    ▼
completeness_verification (evaluate) ─── nothing missing?
    │
    ▼
code_review → complete
```

### 6.2 Detailed Design

#### 6.2.1 Task Schema (`.jeeves/tasks.json`)

```json
{
  "schemaVersion": 1,
  "decomposedFrom": "docs/issue-23-design.md",
  "tasks": [
    {
      "id": "T1",
      "title": "Create Task dataclasses",
      "summary": "Define Task and TaskList dataclasses in src/jeeves/core/tasks.py",
      "acceptanceCriteria": [
        "Task class exists with id, title, summary, acceptanceCriteria, filesAllowed, dependsOn, status fields",
        "TaskList class exists with schemaVersion, decomposedFrom, tasks fields",
        "All fields have appropriate types (str, List[str], Optional)"
      ],
      "filesAllowed": ["src/jeeves/core/tasks.py"],
      "dependsOn": [],
      "status": "pending"
    }
  ]
}
```

**Field Definitions**:
| Field | Type | Description |
|-------|------|-------------|
| `schemaVersion` | `int` | Schema version for future migrations (always `1`) |
| `decomposedFrom` | `str` | Path to design document this was extracted from |
| `tasks` | `List[Task]` | Ordered list of tasks to implement |
| `tasks[].id` | `str` | Unique task identifier (e.g., "T1", "T2") |
| `tasks[].title` | `str` | Short descriptive title |
| `tasks[].summary` | `str` | What this task accomplishes |
| `tasks[].acceptanceCriteria` | `List[str]` | Verifiable criteria for task completion |
| `tasks[].filesAllowed` | `List[str]` | Glob patterns for files this task may modify |
| `tasks[].dependsOn` | `List[str]` | Task IDs that must complete first (for ordering) |
| `tasks[].status` | `str` | One of: `pending`, `in_progress`, `passed`, `failed` |

#### 6.2.2 Task Management Module (`src/jeeves/core/tasks.py`)

```python
# New file: src/jeeves/core/tasks.py
"""Task management for decomposed implementation workflow."""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional
import json


@dataclass
class Task:
    """A single implementation task."""
    id: str
    title: str
    summary: str
    acceptanceCriteria: List[str]
    filesAllowed: List[str] = field(default_factory=list)
    dependsOn: List[str] = field(default_factory=list)
    status: str = "pending"  # pending, in_progress, passed, failed

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "summary": self.summary,
            "acceptanceCriteria": self.acceptanceCriteria,
            "filesAllowed": self.filesAllowed,
            "dependsOn": self.dependsOn,
            "status": self.status,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Task":
        return cls(
            id=data["id"],
            title=data["title"],
            summary=data["summary"],
            acceptanceCriteria=data.get("acceptanceCriteria", []),
            filesAllowed=data.get("filesAllowed", []),
            dependsOn=data.get("dependsOn", []),
            status=data.get("status", "pending"),
        )


@dataclass
class TaskList:
    """A list of tasks extracted from a design document."""
    schemaVersion: int
    decomposedFrom: str
    tasks: List[Task]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "schemaVersion": self.schemaVersion,
            "decomposedFrom": self.decomposedFrom,
            "tasks": [t.to_dict() for t in self.tasks],
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "TaskList":
        return cls(
            schemaVersion=data.get("schemaVersion", 1),
            decomposedFrom=data.get("decomposedFrom", ""),
            tasks=[Task.from_dict(t) for t in data.get("tasks", [])],
        )


def load_tasks(path: Path) -> TaskList:
    """Load tasks from a JSON file."""
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return TaskList.from_dict(data)


def save_tasks(task_list: TaskList, path: Path) -> None:
    """Save tasks to a JSON file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(task_list.to_dict(), f, indent=2)
        f.write("\n")


def get_current_task(task_list: TaskList) -> Optional[Task]:
    """Get the current task (first pending or in_progress task)."""
    for task in task_list.tasks:
        if task.status in ("pending", "in_progress"):
            return task
    return None


def get_task_by_id(task_list: TaskList, task_id: str) -> Optional[Task]:
    """Get a task by its ID."""
    for task in task_list.tasks:
        if task.id == task_id:
            return task
    return None


def advance_task(task_list: TaskList, task_id: str, passed: bool) -> bool:
    """Mark a task as passed/failed and advance to next if passed.

    Returns True if there are more tasks, False if all complete.
    """
    task = get_task_by_id(task_list, task_id)
    if task is None:
        return False

    task.status = "passed" if passed else "failed"

    # Check if there are more pending tasks
    next_task = get_current_task(task_list)
    return next_task is not None


def all_tasks_complete(task_list: TaskList) -> bool:
    """Check if all tasks have passed."""
    return all(t.status == "passed" for t in task_list.tasks)


def get_pending_task_count(task_list: TaskList) -> int:
    """Get count of tasks not yet passed."""
    return sum(1 for t in task_list.tasks if t.status != "passed")
```

#### 6.2.3 Status Fields in `issue.json`

The `issue.json` status section will be extended with:

```json
{
  "status": {
    "designApproved": true,
    "taskDecompositionComplete": true,
    "currentTaskId": "T1",
    "taskPassed": false,
    "taskFailed": false,
    "hasMoreTasks": true,
    "allTasksComplete": false,
    "missingWork": false,
    "implementationComplete": false
  }
}
```

**Status Field Definitions**:
| Field | Type | Description |
|-------|------|-------------|
| `taskDecompositionComplete` | `bool` | Set true when tasks.json is created |
| `currentTaskId` | `str` | ID of task being worked on |
| `taskPassed` | `bool` | Set by spec_check when task passes |
| `taskFailed` | `bool` | Set by spec_check when task fails |
| `hasMoreTasks` | `bool` | True if pending tasks remain after current |
| `allTasksComplete` | `bool` | True when all tasks have status "passed" |
| `missingWork` | `bool` | Set by completeness_verification if gaps found |
| `implementationComplete` | `bool` | Final gate before code_review |

#### 6.2.4 Workflow Definition Updates (`workflows/default.yaml`)

```yaml
workflow:
  name: default
  version: 2
  start: design_draft

phases:
  # Design phases (unchanged)
  design_draft:
    prompt: design.draft.md
    type: execute
    description: Create initial design document
    transitions:
      - to: design_review
        auto: true

  design_review:
    prompt: design.review.md
    type: evaluate
    description: Review design document (read-only)
    allowed_writes:
      - ".jeeves/*"
    transitions:
      - to: design_edit
        when: "status.designNeedsChanges == true"
      - to: task_decomposition
        when: "status.designApproved == true"

  design_edit:
    prompt: design.edit.md
    type: execute
    description: Apply changes from design review
    transitions:
      - to: design_review
        auto: true

  # NEW: Task decomposition phase
  task_decomposition:
    prompt: task.decompose.md
    type: execute
    description: Extract tasks from design document
    transitions:
      - to: implement_task
        when: "status.taskDecompositionComplete == true"

  # NEW: Task implementation loop
  implement_task:
    prompt: task.implement.md
    type: execute
    description: Implement current task
    transitions:
      - to: task_spec_check
        auto: true

  task_spec_check:
    prompt: task.spec_check.md
    type: evaluate
    description: Verify task meets acceptance criteria
    allowed_writes:
      - ".jeeves/*"
    transitions:
      - to: implement_task
        when: "status.taskFailed == true"
      - to: implement_task
        when: "status.taskPassed == true and status.hasMoreTasks == true"
      - to: completeness_verification
        when: "status.allTasksComplete == true"

  # NEW: Final completeness check
  completeness_verification:
    prompt: verify.completeness.md
    type: evaluate
    description: Verify complete implementation against design
    allowed_writes:
      - ".jeeves/*"
    transitions:
      - to: implement_task
        when: "status.missingWork == true"
      - to: code_review
        when: "status.implementationComplete == true"

  # Code review loop (unchanged)
  code_review:
    prompt: review.evaluate.md
    type: evaluate
    description: Review code changes (read-only)
    allowed_writes:
      - ".jeeves/*"
    transitions:
      - to: code_fix
        when: "status.reviewNeedsChanges == true"
      - to: complete
        when: "status.reviewClean == true"

  code_fix:
    prompt: review.fix.md
    type: execute
    description: Apply fixes from code review
    transitions:
      - to: code_review
        auto: true

  # Terminal state
  complete:
    type: terminal
    description: Workflow complete
```

#### 6.2.5 New Prompts

**`prompts/task.decompose.md`** - Task decomposition guidelines:

The prompt should instruct the agent to:
1. Read the design document at `designDocPath`
2. Extract 5-15 small, scoped tasks from the Work Breakdown section
3. Each task should be completable in ~20k tokens of context
4. Each task must have clear acceptance criteria
5. Specify `filesAllowed` for each task based on what it modifies
6. Order tasks respecting dependencies
7. Write output to `.jeeves/tasks.json`
8. Set `status.taskDecompositionComplete = true`
9. Set `status.currentTaskId` to first task ID

**`prompts/task.implement.md`** - Single-task implementation:

The prompt should instruct the agent to:
1. Read current task from `tasks.json` using `currentTaskId`
2. Review only the relevant section of the design document
3. Implement ONLY what the current task requires
4. Respect `filesAllowed` - do not modify other files
5. Write tests as appropriate
6. Commit changes with task ID in message
7. Update task status to `in_progress` at start
8. Do NOT set completion flags (spec_check does that)

**`prompts/task.spec_check.md`** - Acceptance verification:

The prompt should instruct the agent to:
1. Read current task from `tasks.json`
2. For each acceptance criterion, verify it is met
3. Check code changes match task scope
4. If ALL criteria pass:
   - Set task status to `passed`
   - Set `status.taskPassed = true`, `status.taskFailed = false`
   - Advance `currentTaskId` to next pending task (or clear if none)
   - Set `status.hasMoreTasks` based on remaining tasks
   - Set `status.allTasksComplete` if all tasks passed
5. If ANY criterion fails:
   - Set task status to `failed`
   - Set `status.taskFailed = true`, `status.taskPassed = false`
   - Write failure reason to `.jeeves/task-feedback.md`
   - Keep `currentTaskId` unchanged (will retry)

**`prompts/verify.completeness.md`** - Final verification:

The prompt should instruct the agent to:
1. Read the full design document
2. Read all task acceptance criteria (should all be `passed`)
3. Verify the complete implementation matches design intent
4. Check for any gaps or missing functionality
5. If complete:
   - Set `status.implementationComplete = true`
   - Set `status.missingWork = false`
6. If gaps found:
   - Create new task(s) in `tasks.json` for missing work
   - Set `status.missingWork = true`
   - Set `currentTaskId` to first new task

#### 6.2.6 File Permission Enforcement

The existing `write_checker.py` can be reused for task-level file permission enforcement. During `implement_task`, the allowed patterns come from the current task's `filesAllowed` field plus `.jeeves/*`.

Integration point in the SDK runner or viewer:
1. Before running `implement_task`, extract `filesAllowed` from current task
2. Pass to runner configuration
3. After phase completes, use `check_forbidden_writes()` to verify
4. If violations detected, treat as spec check failure

### 6.3 Operational Considerations

- **Deployment**: No CI/CD changes required. Workflow changes are backward compatible.
- **Telemetry & Observability**: Progress tracked in `.jeeves/progress.txt` and `tasks.json` task statuses.
- **Security & Compliance**: File permission enforcement prevents tasks from modifying unrelated code.

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| T1: Create Task dataclasses | Define Task and TaskList dataclasses | Implementation Agent | None | Classes exist with all fields, serialization works |
| T2: Add task I/O functions | load_tasks, save_tasks, get/advance helpers | Implementation Agent | T1 | Functions work correctly, handle edge cases |
| T3: Write unit tests for tasks module | Test Task, TaskList, all helper functions | Implementation Agent | T2 | 100% function coverage, edge cases tested |
| T4: Create task.decompose.md prompt | Decomposition guidelines prompt | Implementation Agent | None | Prompt follows existing conventions |
| T5: Create task.implement.md prompt | Single-task implementation prompt | Implementation Agent | T4 | Prompt includes file permission guidance |
| T6: Create task.spec_check.md prompt | Acceptance verification prompt | Implementation Agent | T5 | Prompt covers all pass/fail scenarios |
| T7: Create verify.completeness.md prompt | Final completeness check prompt | Implementation Agent | T6 | Prompt handles gap detection |
| T8: Update workflows/default.yaml | Add new phases and transitions | Implementation Agent | T1-T7 | Workflow validates, transitions work |
| T9: Integration test for task loop | Test full task iteration cycle | Implementation Agent | T8 | End-to-end test passes |
| T10: Test retry on spec check failure | Verify retry mechanism works | Implementation Agent | T9 | Failed tasks trigger re-implementation |

### 7.2 Milestones

- **Phase 1** (T1-T3): Task schema and management functions - Core data structures and helpers
- **Phase 2** (T4-T7): New prompts - Agent guidance for each phase
- **Phase 3** (T8-T10): Workflow integration and testing - End-to-end functionality

### 7.3 Coordination Notes

- **Hand-off Package**: Design document, existing prompt patterns, workflow YAML schema
- **Communication Cadence**: Progress logged to `.jeeves/progress.txt` after each task

## 8. Agent Guidance & Guardrails

- **Context Packets**:
  - `src/jeeves/core/` for existing patterns
  - `prompts/` for prompt conventions
  - `workflows/default.yaml` for workflow structure
  - `tests/` for test patterns

- **Prompting & Constraints**:
  - Use existing dataclass patterns from `workflow.py`, `issue.py`
  - Follow JSON serialization patterns from `issue.py`
  - Test patterns from `test_guards.py`, `test_engine.py`
  - Prompts use markdown with `<role>`, `<context>`, `<instructions>` structure

- **Safety Rails**:
  - Do not modify existing workflow phases (add new ones)
  - Do not break backward compatibility
  - Do not modify `engine.py` (stateless design)
  - All new code must have tests

- **Validation Hooks**:
  - `pytest tests/` must pass
  - `python -m py_compile src/jeeves/core/tasks.py` for syntax check

## 9. Alternatives Considered

### Alternative 1: Modify Existing Implement Phase
**Rejected**: Would break existing workflows and lose the fresh-context benefit.

### Alternative 2: Store Tasks in issue.json
**Rejected**: Tasks can get large; separate file keeps `issue.json` manageable and allows independent updates.

### Alternative 3: Dynamic Task Creation During Implementation
**Rejected**: Adds complexity and non-determinism. Fixed task list after decomposition is simpler and more predictable.

### Alternative 4: Parallel Task Execution
**Rejected**: Adds significant complexity (merge conflicts, state management). Sequential execution is simpler and tasks are already small.

## 10. Testing & Validation Plan

- **Unit Tests** (`tests/test_tasks.py`):
  - `Task.to_dict()` / `Task.from_dict()` round-trip
  - `TaskList.to_dict()` / `TaskList.from_dict()` round-trip
  - `load_tasks()` / `save_tasks()` file I/O
  - `get_current_task()` with various task statuses
  - `get_task_by_id()` found and not found
  - `advance_task()` pass and fail scenarios
  - `all_tasks_complete()` various states
  - `get_pending_task_count()` accuracy

- **Integration Tests** (`tests/test_task_workflow.py`):
  - Full task loop: decompose → implement → check → advance
  - Retry on spec check failure
  - Completeness verification adding tasks
  - Workflow transitions with task status guards

- **Coverage Expectations**: 100% line coverage for `tasks.py`, 80%+ for integration tests

## 11. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Task decomposition produces too many/few tasks | Medium | Medium | Prompt guidance for 5-15 tasks; completeness check as safety net |
| File permission enforcement too restrictive | Medium | Low | Allow `.jeeves/*` always; prompts guide appropriate `filesAllowed` |
| Spec check too strict (false failures) | Low | Medium | Prompt emphasizes "meets intent" not "perfect match" |
| Infinite retry loop on consistently failing task | High | Low | Consider max retry count (future enhancement, not in scope) |
| Completeness check creates unbounded new tasks | Medium | Low | Prompt guidance to limit to genuine gaps only |

## 12. Rollout Plan

- **Milestones**:
  - Week 1: T1-T3 (schema and tests)
  - Week 2: T4-T7 (prompts)
  - Week 3: T8-T10 (integration)

- **Migration Strategy**: No migration needed. New workflow version coexists with existing.

- **Communication**: Update README with task decomposition workflow documentation.

## 13. Open Questions

1. **Max retry count**: Should there be a limit on task retries to prevent infinite loops? (Deferred to follow-up)
2. **Task priority/ordering**: Current design uses list order. Need explicit priority field? (Probably not - list order sufficient)
3. **Partial task completion**: How to handle tasks that are partially done when context exhausts? (Current: retry from scratch)

## 14. Follow-Up Work

- **Max retry limit**: Add configurable max retry count per task
- **Task progress persistence**: Save intermediate progress within a task
- **Parallel-safe tasks**: Allow tasks with no dependencies to run in parallel
- **Task visualization**: Add task status to viewer TUI

## 15. References

- [Issue #23](https://github.com/hansjm10/jeeves/issues/23): Original feature request
- `src/jeeves/core/workflow.py`: Existing workflow dataclasses
- `src/jeeves/core/engine.py`: Stateless workflow engine
- `src/jeeves/core/issue.py`: Issue state management
- `src/jeeves/core/guards.py`: Guard expression parser
- `src/jeeves/core/write_checker.py`: File permission checking
- `workflows/default.yaml`: Current workflow definition
- `prompts/implement.md`: Current implementation prompt
- `prompts/issue.task.implement.md`: Existing partial task implementation prompt

## Appendix A — Glossary

| Term | Definition |
|------|------------|
| Task | A small, scoped unit of implementation work with defined acceptance criteria |
| TaskList | Collection of tasks extracted from a design document |
| Spec Check | Verification that a task implementation meets its acceptance criteria |
| Completeness Verification | Final check that full design is implemented across all tasks |
| File Permission | Restriction on which files a task is allowed to modify |
| Context Window | The token limit within which an AI agent operates |

## Appendix B — Change Log

| Date | Author | Change Summary |
|------|--------|----------------|
| 2025-01-29 | Jeeves AI Agent | Initial draft |
