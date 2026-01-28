# YAML-Based Workflow Engine Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace hardcoded phase system with a declarative YAML-based workflow engine supporting graph transitions, loops, and script phases.

**Architecture:** Finite State Machine where phases are states and transitions are edges with guard expressions. Workflow definitions live in YAML files. A lightweight guard expression parser evaluates transition conditions against issue.json status fields. Script phases run shell commands for non-AI checks like CI status.

**Tech Stack:** Python 3.10+, PyYAML, dataclasses, existing Jeeves viewer infrastructure

---

## Phase Types Reference

| Type | Runs | Can Modify Code | Use Case |
|------|------|-----------------|----------|
| `execute` | AI agent | Yes | Create, implement, fix code |
| `evaluate` | AI agent | No (`.jeeves/*` only) | Review, analyze |
| `script` | Shell command | No | CI checks, external API calls |
| `terminal` | Nothing | N/A | End state |

---

## Task 1: Guard Expression Parser

**Files:**
- Create: `src/jeeves/core/guards.py`
- Test: `tests/test_guards.py`

### Step 1.1: Write failing test for simple equality

```python
# tests/test_guards.py
import pytest
from jeeves.core.guards import evaluate_guard


class TestEvaluateGuard:
    def test_simple_equality_true(self):
        context = {"status": {"reviewClean": True}}
        assert evaluate_guard("status.reviewClean == true", context) is True

    def test_simple_equality_false(self):
        context = {"status": {"reviewClean": False}}
        assert evaluate_guard("status.reviewClean == true", context) is False

    def test_not_equal(self):
        context = {"status": {"phase": "review"}}
        assert evaluate_guard("status.phase != design", context) is True
```

### Step 1.2: Run test to verify it fails

Run: `cd /work/jeeves && python -m pytest tests/test_guards.py -v`
Expected: FAIL with "No module named 'jeeves.core.guards'"

### Step 1.3: Write minimal implementation

```python
# src/jeeves/core/guards.py
"""Guard expression parser for workflow transitions.

Supports simple expressions:
- field.path == value
- field.path != value
- expr and expr
- expr or expr
"""

import re
from typing import Any, Dict


def _get_nested_value(obj: Dict[str, Any], path: str) -> Any:
    """Get a nested value from a dict using dot notation."""
    parts = path.split(".")
    current = obj
    for part in parts:
        if isinstance(current, dict):
            current = current.get(part)
        else:
            return None
    return current


def _parse_value(value_str: str) -> Any:
    """Parse a string value into its Python type."""
    value_str = value_str.strip()
    if value_str.lower() == "true":
        return True
    if value_str.lower() == "false":
        return False
    if value_str.lower() == "null" or value_str.lower() == "none":
        return None
    if value_str.isdigit():
        return int(value_str)
    # Remove quotes if present
    if (value_str.startswith('"') and value_str.endswith('"')) or \
       (value_str.startswith("'") and value_str.endswith("'")):
        return value_str[1:-1]
    return value_str


def _evaluate_comparison(expr: str, context: Dict[str, Any]) -> bool:
    """Evaluate a single comparison expression."""
    expr = expr.strip()

    # Handle != operator
    if "!=" in expr:
        parts = expr.split("!=", 1)
        if len(parts) != 2:
            return False
        field_path = parts[0].strip()
        expected = _parse_value(parts[1])
        actual = _get_nested_value(context, field_path)
        return actual != expected

    # Handle == operator
    if "==" in expr:
        parts = expr.split("==", 1)
        if len(parts) != 2:
            return False
        field_path = parts[0].strip()
        expected = _parse_value(parts[1])
        actual = _get_nested_value(context, field_path)
        return actual == expected

    # Bare field name treated as truthy check
    value = _get_nested_value(context, expr)
    return bool(value)


def evaluate_guard(expression: str, context: Dict[str, Any]) -> bool:
    """Evaluate a guard expression against a context.

    Args:
        expression: Guard expression like "status.reviewClean == true"
        context: Dictionary containing the evaluation context (usually issue.json)

    Returns:
        True if the guard passes, False otherwise
    """
    if not expression or not expression.strip():
        return True  # Empty guard always passes

    expression = expression.strip()

    # Handle 'or' (lower precedence)
    if " or " in expression:
        parts = expression.split(" or ")
        return any(_evaluate_comparison(p, context) if " and " not in p
                   else evaluate_guard(p, context) for p in parts)

    # Handle 'and' (higher precedence)
    if " and " in expression:
        parts = expression.split(" and ")
        return all(_evaluate_comparison(p, context) for p in parts)

    # Single comparison
    return _evaluate_comparison(expression, context)
```

### Step 1.4: Run test to verify it passes

Run: `cd /work/jeeves && python -m pytest tests/test_guards.py -v`
Expected: PASS

### Step 1.5: Add tests for 'and' / 'or' operators

```python
# Add to tests/test_guards.py

    def test_and_operator_both_true(self):
        context = {"status": {"implemented": True, "prCreated": True}}
        assert evaluate_guard("status.implemented == true and status.prCreated == true", context) is True

    def test_and_operator_one_false(self):
        context = {"status": {"implemented": True, "prCreated": False}}
        assert evaluate_guard("status.implemented == true and status.prCreated == true", context) is False

    def test_or_operator(self):
        context = {"status": {"ciFailed": True, "reviewFailed": False}}
        assert evaluate_guard("status.ciFailed == true or status.reviewFailed == true", context) is True

    def test_nested_field_access(self):
        context = {"config": {"workflow": {"name": "default"}}}
        assert evaluate_guard("config.workflow.name == default", context) is True

    def test_missing_field_is_none(self):
        context = {"status": {}}
        assert evaluate_guard("status.nonexistent == null", context) is True

    def test_empty_guard_passes(self):
        context = {}
        assert evaluate_guard("", context) is True
```

### Step 1.6: Run tests to verify they pass

Run: `cd /work/jeeves && python -m pytest tests/test_guards.py -v`
Expected: PASS

### Step 1.7: Commit

```bash
git add src/jeeves/core/guards.py tests/test_guards.py
git commit -m "feat(workflow): add guard expression parser

Supports simple equality DSL for workflow transition guards:
- field.path == value / != value
- and / or operators
- Nested field access via dot notation

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 2: Workflow Dataclasses

**Files:**
- Create: `src/jeeves/core/workflow.py`
- Test: `tests/test_workflow.py`

### Step 2.1: Write failing test for dataclasses

```python
# tests/test_workflow.py
import pytest
from jeeves.core.workflow import (
    Workflow,
    Phase,
    Transition,
    PhaseType,
)


class TestWorkflowDataclasses:
    def test_create_transition(self):
        t = Transition(to="implement", when="status.designApproved == true")
        assert t.to == "implement"
        assert t.when == "status.designApproved == true"
        assert t.auto is False
        assert t.priority == 0

    def test_create_auto_transition(self):
        t = Transition(to="review", auto=True)
        assert t.auto is True
        assert t.when is None

    def test_create_phase(self):
        p = Phase(
            name="design",
            prompt="design.draft.md",
            type=PhaseType.EXECUTE,
            description="Create design doc",
            transitions=[Transition(to="review", auto=True)],
        )
        assert p.name == "design"
        assert p.type == PhaseType.EXECUTE
        assert len(p.transitions) == 1

    def test_create_script_phase(self):
        p = Phase(
            name="ci_check",
            type=PhaseType.SCRIPT,
            command="gh run list --json conclusion",
            status_mapping={"success": {"ciPassed": True}},
        )
        assert p.type == PhaseType.SCRIPT
        assert p.command is not None
        assert p.prompt is None

    def test_create_workflow(self):
        w = Workflow(
            name="default",
            version=1,
            start="design",
            phases={
                "design": Phase(name="design", type=PhaseType.EXECUTE, prompt="design.md"),
                "complete": Phase(name="complete", type=PhaseType.TERMINAL),
            },
        )
        assert w.name == "default"
        assert w.start == "design"
        assert "design" in w.phases
```

### Step 2.2: Run test to verify it fails

Run: `cd /work/jeeves && python -m pytest tests/test_workflow.py::TestWorkflowDataclasses -v`
Expected: FAIL with "No module named 'jeeves.core.workflow'"

### Step 2.3: Write implementation

```python
# src/jeeves/core/workflow.py
"""Workflow dataclasses for YAML-based workflow engine.

Defines the structure of workflows, phases, and transitions.
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


class PhaseType(Enum):
    """Type of phase determining execution behavior."""
    EXECUTE = "execute"      # AI agent, can modify code
    EVALUATE = "evaluate"    # AI agent, read-only analysis
    SCRIPT = "script"        # Shell command, no AI
    TERMINAL = "terminal"    # End state


@dataclass
class Transition:
    """A transition from one phase to another.

    Attributes:
        to: Target phase name
        when: Guard expression (evaluated against issue.json)
        auto: If True, transition immediately when phase completes
        priority: Lower priority transitions are evaluated first
    """
    to: str
    when: Optional[str] = None
    auto: bool = False
    priority: int = 0


@dataclass
class Phase:
    """A phase in the workflow.

    Attributes:
        name: Unique phase identifier
        type: Phase type (execute, evaluate, script, terminal)
        prompt: Prompt file name (for execute/evaluate phases)
        command: Shell command (for script phases)
        description: Human-readable description
        transitions: List of possible transitions from this phase
        allowed_writes: Glob patterns for allowed file modifications (evaluate phases)
        status_mapping: Map command output to status fields (script phases)
        output_file: File for script progress output
    """
    name: str
    type: PhaseType
    prompt: Optional[str] = None
    command: Optional[str] = None
    description: Optional[str] = None
    transitions: List[Transition] = field(default_factory=list)
    allowed_writes: List[str] = field(default_factory=lambda: [".jeeves/*"])
    status_mapping: Optional[Dict[str, Dict[str, Any]]] = None
    output_file: Optional[str] = None


@dataclass
class Workflow:
    """A complete workflow definition.

    Attributes:
        name: Workflow identifier
        version: Schema version
        start: Name of the starting phase
        phases: Map of phase name to Phase object
    """
    name: str
    version: int
    start: str
    phases: Dict[str, Phase]

    def get_phase(self, name: str) -> Optional[Phase]:
        """Get a phase by name."""
        return self.phases.get(name)

    def get_start_phase(self) -> Phase:
        """Get the starting phase."""
        phase = self.phases.get(self.start)
        if not phase:
            raise ValueError(f"Start phase '{self.start}' not found in workflow")
        return phase
```

### Step 2.4: Run test to verify it passes

Run: `cd /work/jeeves && python -m pytest tests/test_workflow.py::TestWorkflowDataclasses -v`
Expected: PASS

### Step 2.5: Commit

```bash
git add src/jeeves/core/workflow.py tests/test_workflow.py
git commit -m "feat(workflow): add workflow dataclasses

Defines Workflow, Phase, Transition, and PhaseType for the
YAML-based workflow engine. Supports execute, evaluate, script,
and terminal phase types.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 3: YAML Workflow Loader

**Files:**
- Create: `src/jeeves/core/workflow_loader.py`
- Create: `workflows/default.yaml`
- Test: `tests/test_workflow_loader.py`

### Step 3.1: Write failing test for YAML loading

```python
# tests/test_workflow_loader.py
import pytest
from pathlib import Path
from jeeves.core.workflow_loader import load_workflow, WorkflowValidationError
from jeeves.core.workflow import PhaseType


class TestWorkflowLoader:
    def test_load_minimal_workflow(self, tmp_path):
        yaml_content = """
workflow:
  name: test
  version: 1
  start: design

phases:
  design:
    prompt: design.md
    type: execute
    transitions:
      - to: complete
        auto: true
  complete:
    type: terminal
"""
        workflow_file = tmp_path / "test.yaml"
        workflow_file.write_text(yaml_content)

        workflow = load_workflow(workflow_file)

        assert workflow.name == "test"
        assert workflow.start == "design"
        assert len(workflow.phases) == 2
        assert workflow.phases["design"].type == PhaseType.EXECUTE
        assert workflow.phases["complete"].type == PhaseType.TERMINAL

    def test_load_workflow_with_guards(self, tmp_path):
        yaml_content = """
workflow:
  name: test
  version: 1
  start: review

phases:
  review:
    prompt: review.md
    type: evaluate
    transitions:
      - to: fix
        when: "status.needsChanges == true"
      - to: complete
        when: "status.approved == true"
  fix:
    prompt: fix.md
    type: execute
    transitions:
      - to: review
        auto: true
  complete:
    type: terminal
"""
        workflow_file = tmp_path / "test.yaml"
        workflow_file.write_text(yaml_content)

        workflow = load_workflow(workflow_file)

        assert len(workflow.phases["review"].transitions) == 2
        assert workflow.phases["review"].transitions[0].when == "status.needsChanges == true"

    def test_load_script_phase(self, tmp_path):
        yaml_content = """
workflow:
  name: test
  version: 1
  start: ci_check

phases:
  ci_check:
    type: script
    command: "gh run list --json conclusion"
    output_file: ".jeeves/ci-status.txt"
    status_mapping:
      success:
        ciPassed: true
      failure:
        ciFailed: true
    transitions:
      - to: complete
        when: "status.ciPassed == true"
  complete:
    type: terminal
"""
        workflow_file = tmp_path / "test.yaml"
        workflow_file.write_text(yaml_content)

        workflow = load_workflow(workflow_file)

        ci_phase = workflow.phases["ci_check"]
        assert ci_phase.type == PhaseType.SCRIPT
        assert ci_phase.command == "gh run list --json conclusion"
        assert ci_phase.status_mapping["success"]["ciPassed"] is True

    def test_invalid_transition_target_raises(self, tmp_path):
        yaml_content = """
workflow:
  name: test
  version: 1
  start: design

phases:
  design:
    prompt: design.md
    type: execute
    transitions:
      - to: nonexistent
        auto: true
"""
        workflow_file = tmp_path / "test.yaml"
        workflow_file.write_text(yaml_content)

        with pytest.raises(WorkflowValidationError, match="nonexistent"):
            load_workflow(workflow_file)

    def test_invalid_start_phase_raises(self, tmp_path):
        yaml_content = """
workflow:
  name: test
  version: 1
  start: nonexistent

phases:
  design:
    prompt: design.md
    type: execute
"""
        workflow_file = tmp_path / "test.yaml"
        workflow_file.write_text(yaml_content)

        with pytest.raises(WorkflowValidationError, match="Start phase"):
            load_workflow(workflow_file)
```

### Step 3.2: Run test to verify it fails

Run: `cd /work/jeeves && python -m pytest tests/test_workflow_loader.py -v`
Expected: FAIL with "No module named 'jeeves.core.workflow_loader'"

### Step 3.3: Write implementation

```python
# src/jeeves/core/workflow_loader.py
"""YAML workflow loader with validation.

Loads workflow definitions from YAML files and validates structure.
"""

import yaml
from pathlib import Path
from typing import Any, Dict, Optional

from .workflow import Workflow, Phase, Transition, PhaseType


class WorkflowValidationError(Exception):
    """Error during workflow validation."""
    pass


def _parse_phase_type(type_str: str) -> PhaseType:
    """Parse a phase type string into PhaseType enum."""
    try:
        return PhaseType(type_str.lower())
    except ValueError:
        valid = [t.value for t in PhaseType]
        raise WorkflowValidationError(
            f"Invalid phase type '{type_str}'. Must be one of: {valid}"
        )


def _parse_transition(data: Dict[str, Any]) -> Transition:
    """Parse a transition from YAML data."""
    return Transition(
        to=data["to"],
        when=data.get("when"),
        auto=data.get("auto", False),
        priority=data.get("priority", 0),
    )


def _parse_phase(name: str, data: Dict[str, Any]) -> Phase:
    """Parse a phase from YAML data."""
    phase_type = _parse_phase_type(data.get("type", "execute"))

    transitions = []
    for t_data in data.get("transitions", []):
        transitions.append(_parse_transition(t_data))

    # Sort transitions by priority
    transitions.sort(key=lambda t: t.priority)

    return Phase(
        name=name,
        type=phase_type,
        prompt=data.get("prompt"),
        command=data.get("command"),
        description=data.get("description"),
        transitions=transitions,
        allowed_writes=data.get("allowed_writes", [".jeeves/*"]),
        status_mapping=data.get("status_mapping"),
        output_file=data.get("output_file"),
    )


def _validate_workflow(workflow: Workflow) -> None:
    """Validate workflow structure."""
    # Check start phase exists
    if workflow.start not in workflow.phases:
        raise WorkflowValidationError(
            f"Start phase '{workflow.start}' not found in workflow phases"
        )

    # Check all transition targets exist
    for phase_name, phase in workflow.phases.items():
        for transition in phase.transitions:
            if transition.to not in workflow.phases:
                raise WorkflowValidationError(
                    f"Phase '{phase_name}' has transition to unknown phase '{transition.to}'"
                )

    # Check execute/evaluate phases have prompts
    for phase_name, phase in workflow.phases.items():
        if phase.type in (PhaseType.EXECUTE, PhaseType.EVALUATE):
            if not phase.prompt:
                raise WorkflowValidationError(
                    f"Phase '{phase_name}' of type '{phase.type.value}' requires a prompt"
                )

    # Check script phases have commands
    for phase_name, phase in workflow.phases.items():
        if phase.type == PhaseType.SCRIPT:
            if not phase.command:
                raise WorkflowValidationError(
                    f"Script phase '{phase_name}' requires a command"
                )


def load_workflow(path: Path) -> Workflow:
    """Load a workflow from a YAML file.

    Args:
        path: Path to the workflow YAML file

    Returns:
        Parsed and validated Workflow object

    Raises:
        WorkflowValidationError: If the workflow is invalid
        FileNotFoundError: If the file doesn't exist
        yaml.YAMLError: If the YAML is malformed
    """
    with open(path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)

    workflow_data = data.get("workflow", {})
    phases_data = data.get("phases", {})

    phases = {}
    for name, phase_data in phases_data.items():
        phases[name] = _parse_phase(name, phase_data)

    workflow = Workflow(
        name=workflow_data.get("name", path.stem),
        version=workflow_data.get("version", 1),
        start=workflow_data.get("start", "design"),
        phases=phases,
    )

    _validate_workflow(workflow)

    return workflow


def load_workflow_by_name(name: str, workflows_dir: Optional[Path] = None) -> Workflow:
    """Load a workflow by name from the workflows directory.

    Args:
        name: Workflow name (without .yaml extension)
        workflows_dir: Directory containing workflow files (defaults to package workflows/)

    Returns:
        Parsed and validated Workflow object
    """
    if workflows_dir is None:
        # Default to package workflows directory
        workflows_dir = Path(__file__).parent.parent.parent.parent / "workflows"

    path = workflows_dir / f"{name}.yaml"
    if not path.exists():
        raise FileNotFoundError(f"Workflow '{name}' not found at {path}")

    return load_workflow(path)
```

### Step 3.4: Run test to verify it passes

Run: `cd /work/jeeves && python -m pytest tests/test_workflow_loader.py -v`
Expected: PASS

### Step 3.5: Create default workflow file

```yaml
# workflows/default.yaml
workflow:
  name: default
  version: 1
  start: design_draft

phases:
  # Design phases
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
      - to: implement
        when: "status.designApproved == true"

  design_edit:
    prompt: design.edit.md
    type: execute
    description: Apply changes from design review
    transitions:
      - to: design_review
        auto: true

  # Implementation phase
  implement:
    prompt: implement.md
    type: execute
    description: Implement the design
    transitions:
      - to: code_review
        auto: true

  # Code review loop
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

### Step 3.6: Add test for loading default workflow

```python
# Add to tests/test_workflow_loader.py

    def test_load_default_workflow(self):
        from jeeves.core.workflow_loader import load_workflow

        default_path = Path(__file__).parent.parent / "workflows" / "default.yaml"
        if default_path.exists():
            workflow = load_workflow(default_path)
            assert workflow.name == "default"
            assert workflow.start == "design_draft"
            assert "complete" in workflow.phases
```

### Step 3.7: Run all tests

Run: `cd /work/jeeves && python -m pytest tests/test_workflow_loader.py -v`
Expected: PASS

### Step 3.8: Commit

```bash
git add src/jeeves/core/workflow_loader.py tests/test_workflow_loader.py workflows/default.yaml
git commit -m "feat(workflow): add YAML workflow loader

- Parses workflow YAML files into Workflow objects
- Validates transition targets, start phase, required fields
- Creates default.yaml with design/implement/review workflow
- Supports all phase types: execute, evaluate, script, terminal

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 4: Workflow Engine

**Files:**
- Create: `src/jeeves/core/engine.py`
- Test: `tests/test_engine.py`

### Step 4.1: Write failing test for transition evaluation

```python
# tests/test_engine.py
import pytest
from jeeves.core.engine import WorkflowEngine
from jeeves.core.workflow import Workflow, Phase, Transition, PhaseType


class TestWorkflowEngine:
    @pytest.fixture
    def simple_workflow(self):
        return Workflow(
            name="test",
            version=1,
            start="design",
            phases={
                "design": Phase(
                    name="design",
                    type=PhaseType.EXECUTE,
                    prompt="design.md",
                    transitions=[
                        Transition(to="review", auto=True),
                    ],
                ),
                "review": Phase(
                    name="review",
                    type=PhaseType.EVALUATE,
                    prompt="review.md",
                    transitions=[
                        Transition(to="fix", when="status.needsChanges == true"),
                        Transition(to="complete", when="status.approved == true"),
                    ],
                ),
                "fix": Phase(
                    name="fix",
                    type=PhaseType.EXECUTE,
                    prompt="fix.md",
                    transitions=[
                        Transition(to="review", auto=True),
                    ],
                ),
                "complete": Phase(
                    name="complete",
                    type=PhaseType.TERMINAL,
                ),
            },
        )

    def test_get_current_phase(self, simple_workflow):
        engine = WorkflowEngine(simple_workflow)
        phase = engine.get_phase("design")
        assert phase.name == "design"
        assert phase.type == PhaseType.EXECUTE

    def test_evaluate_auto_transition(self, simple_workflow):
        engine = WorkflowEngine(simple_workflow)
        context = {"status": {}}

        next_phase = engine.evaluate_transitions("design", context)

        assert next_phase == "review"

    def test_evaluate_guarded_transition_passes(self, simple_workflow):
        engine = WorkflowEngine(simple_workflow)
        context = {"status": {"needsChanges": True}}

        next_phase = engine.evaluate_transitions("review", context)

        assert next_phase == "fix"

    def test_evaluate_guarded_transition_second_match(self, simple_workflow):
        engine = WorkflowEngine(simple_workflow)
        context = {"status": {"approved": True}}

        next_phase = engine.evaluate_transitions("review", context)

        assert next_phase == "complete"

    def test_evaluate_no_matching_transition(self, simple_workflow):
        engine = WorkflowEngine(simple_workflow)
        context = {"status": {}}  # Neither needsChanges nor approved

        next_phase = engine.evaluate_transitions("review", context)

        assert next_phase is None  # Stay in current phase

    def test_terminal_phase_no_transitions(self, simple_workflow):
        engine = WorkflowEngine(simple_workflow)
        context = {"status": {}}

        next_phase = engine.evaluate_transitions("complete", context)

        assert next_phase is None

    def test_is_terminal(self, simple_workflow):
        engine = WorkflowEngine(simple_workflow)

        assert engine.is_terminal("complete") is True
        assert engine.is_terminal("design") is False
```

### Step 4.2: Run test to verify it fails

Run: `cd /work/jeeves && python -m pytest tests/test_engine.py -v`
Expected: FAIL with "No module named 'jeeves.core.engine'"

### Step 4.3: Write implementation

```python
# src/jeeves/core/engine.py
"""Workflow engine for evaluating and transitioning between phases.

The engine is stateless - it evaluates transitions based on the current
phase and context (issue.json), returning the next phase if a transition
should occur.
"""

from typing import Any, Dict, Optional

from .workflow import Workflow, Phase, PhaseType
from .guards import evaluate_guard


class WorkflowEngine:
    """Engine for evaluating workflow transitions.

    The engine does not manage state directly - it only evaluates
    which transition (if any) should be taken given the current
    phase and context.
    """

    def __init__(self, workflow: Workflow):
        self.workflow = workflow

    def get_phase(self, phase_name: str) -> Optional[Phase]:
        """Get a phase by name."""
        return self.workflow.get_phase(phase_name)

    def get_start_phase(self) -> Phase:
        """Get the starting phase of the workflow."""
        return self.workflow.get_start_phase()

    def is_terminal(self, phase_name: str) -> bool:
        """Check if a phase is a terminal state."""
        phase = self.get_phase(phase_name)
        return phase is not None and phase.type == PhaseType.TERMINAL

    def evaluate_transitions(
        self,
        current_phase: str,
        context: Dict[str, Any],
    ) -> Optional[str]:
        """Evaluate transitions and return the next phase if any.

        Args:
            current_phase: Name of the current phase
            context: Evaluation context (typically issue.json contents)

        Returns:
            Name of the next phase, or None if no transition should occur
        """
        phase = self.get_phase(current_phase)
        if phase is None:
            return None

        # Terminal phases have no transitions
        if phase.type == PhaseType.TERMINAL:
            return None

        # Evaluate transitions in priority order (already sorted)
        for transition in phase.transitions:
            # Auto transitions always fire
            if transition.auto:
                return transition.to

            # Evaluate guard expression
            if transition.when and evaluate_guard(transition.when, context):
                return transition.to

        # No transition matched
        return None

    def get_prompt_for_phase(self, phase_name: str) -> Optional[str]:
        """Get the prompt file name for a phase."""
        phase = self.get_phase(phase_name)
        if phase is None:
            return None
        return phase.prompt

    def get_phase_type(self, phase_name: str) -> Optional[PhaseType]:
        """Get the type of a phase."""
        phase = self.get_phase(phase_name)
        if phase is None:
            return None
        return phase.type
```

### Step 4.4: Run test to verify it passes

Run: `cd /work/jeeves && python -m pytest tests/test_engine.py -v`
Expected: PASS

### Step 4.5: Commit

```bash
git add src/jeeves/core/engine.py tests/test_engine.py
git commit -m "feat(workflow): add workflow engine

Stateless engine for evaluating workflow transitions:
- Evaluates transitions in priority order
- Handles auto transitions and guard expressions
- Identifies terminal phases

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 5: Script Phase Runner

**Files:**
- Create: `src/jeeves/core/script_runner.py`
- Test: `tests/test_script_runner.py`

### Step 5.1: Write failing test for script execution

```python
# tests/test_script_runner.py
import pytest
from pathlib import Path
from jeeves.core.script_runner import run_script_phase, ScriptResult
from jeeves.core.workflow import Phase, PhaseType


class TestScriptRunner:
    def test_run_simple_command(self, tmp_path):
        phase = Phase(
            name="test",
            type=PhaseType.SCRIPT,
            command="echo success",
            status_mapping={
                "success": {"passed": True},
            },
        )

        result = run_script_phase(phase, tmp_path, {})

        assert result.exit_code == 0
        assert result.output.strip() == "success"
        assert result.status_updates == {"passed": True}

    def test_run_command_with_variable_substitution(self, tmp_path):
        phase = Phase(
            name="test",
            type=PhaseType.SCRIPT,
            command="echo ${branch}",
        )
        context = {"branch": "issue/123"}

        result = run_script_phase(phase, tmp_path, context)

        assert result.output.strip() == "issue/123"

    def test_run_command_failure(self, tmp_path):
        phase = Phase(
            name="test",
            type=PhaseType.SCRIPT,
            command="exit 1",
            status_mapping={
                "failure": {"failed": True},
            },
        )

        result = run_script_phase(phase, tmp_path, {})

        assert result.exit_code == 1
        assert result.status_updates == {"failed": True}

    def test_output_file_written(self, tmp_path):
        output_file = ".jeeves/script-output.txt"
        phase = Phase(
            name="test",
            type=PhaseType.SCRIPT,
            command="echo 'line1' && echo 'line2'",
            output_file=output_file,
        )

        result = run_script_phase(phase, tmp_path, {})

        output_path = tmp_path / output_file
        assert output_path.exists()
        assert "line1" in output_path.read_text()

    def test_status_mapping_by_output(self, tmp_path):
        phase = Phase(
            name="test",
            type=PhaseType.SCRIPT,
            command="echo 'success'",
            status_mapping={
                "success": {"ciPassed": True},
                "failure": {"ciFailed": True},
            },
        )

        result = run_script_phase(phase, tmp_path, {})

        assert result.status_updates == {"ciPassed": True}
```

### Step 5.2: Run test to verify it fails

Run: `cd /work/jeeves && python -m pytest tests/test_script_runner.py -v`
Expected: FAIL with "No module named 'jeeves.core.script_runner'"

### Step 5.3: Write implementation

```python
# src/jeeves/core/script_runner.py
"""Script phase runner for non-AI workflow phases.

Runs shell commands, captures output, and maps results to status updates.
"""

import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

from .workflow import Phase


@dataclass
class ScriptResult:
    """Result of running a script phase."""
    exit_code: int
    output: str
    status_updates: Dict[str, Any]


def _substitute_variables(command: str, context: Dict[str, Any]) -> str:
    """Substitute ${variable} patterns in command string."""
    def replace(match):
        var_name = match.group(1)
        # Support nested access like ${status.field}
        parts = var_name.split(".")
        value = context
        for part in parts:
            if isinstance(value, dict):
                value = value.get(part, "")
            else:
                value = ""
                break
        return str(value)

    return re.sub(r'\$\{([^}]+)\}', replace, command)


def _determine_status_updates(
    exit_code: int,
    output: str,
    status_mapping: Optional[Dict[str, Dict[str, Any]]],
) -> Dict[str, Any]:
    """Determine status updates based on exit code and output."""
    if not status_mapping:
        return {}

    # Check for output-based mapping first (check if output contains key)
    output_lower = output.lower().strip()
    for key, updates in status_mapping.items():
        if key.lower() in output_lower:
            return updates

    # Fall back to exit code mapping
    if exit_code == 0 and "success" in status_mapping:
        return status_mapping["success"]
    if exit_code != 0 and "failure" in status_mapping:
        return status_mapping["failure"]

    return {}


def run_script_phase(
    phase: Phase,
    work_dir: Path,
    context: Dict[str, Any],
    timeout: int = 900,  # 15 minutes default
) -> ScriptResult:
    """Run a script phase.

    Args:
        phase: The script phase to run
        work_dir: Working directory for the script
        context: Context for variable substitution (typically issue.json)
        timeout: Maximum execution time in seconds

    Returns:
        ScriptResult with exit code, output, and status updates
    """
    if not phase.command:
        return ScriptResult(
            exit_code=1,
            output="No command specified for script phase",
            status_updates={},
        )

    # Substitute variables in command
    command = _substitute_variables(phase.command, context)

    # Ensure output directory exists if output_file specified
    output_path = None
    if phase.output_file:
        output_path = work_dir / phase.output_file
        output_path.parent.mkdir(parents=True, exist_ok=True)

    # Run the command
    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=work_dir,
            capture_output=True,
            text=True,
            timeout=timeout,
            env={**os.environ, **_flatten_context(context)},
        )
        exit_code = result.returncode
        output = result.stdout + result.stderr
    except subprocess.TimeoutExpired as e:
        exit_code = 124  # Standard timeout exit code
        output = f"Command timed out after {timeout}s\n{e.stdout or ''}"
    except Exception as e:
        exit_code = 1
        output = f"Error running command: {e}"

    # Write output to file if specified
    if output_path:
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(output)

    # Determine status updates
    status_updates = _determine_status_updates(
        exit_code,
        output,
        phase.status_mapping,
    )

    return ScriptResult(
        exit_code=exit_code,
        output=output,
        status_updates=status_updates,
    )


def _flatten_context(context: Dict[str, Any], prefix: str = "") -> Dict[str, str]:
    """Flatten nested context dict into environment variables."""
    result = {}
    for key, value in context.items():
        env_key = f"{prefix}{key}".upper().replace(".", "_")
        if isinstance(value, dict):
            result.update(_flatten_context(value, f"{env_key}_"))
        else:
            result[env_key] = str(value) if value is not None else ""
    return result
```

### Step 5.4: Run test to verify it passes

Run: `cd /work/jeeves && python -m pytest tests/test_script_runner.py -v`
Expected: PASS

### Step 5.5: Commit

```bash
git add src/jeeves/core/script_runner.py tests/test_script_runner.py
git commit -m "feat(workflow): add script phase runner

Runs shell commands for non-AI workflow phases:
- Variable substitution in commands
- Output file for progress streaming
- Status mapping from exit code or output content
- Timeout handling

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 6: Update IssueState for Workflow

**Files:**
- Modify: `src/jeeves/core/issue.py`
- Modify: `tests/test_issue.py` (if exists) or create

### Step 6.1: Write test for workflow field

```python
# tests/test_issue_workflow.py
import pytest
import json
from pathlib import Path
from jeeves.core.issue import IssueState, GitHubIssue


class TestIssueStateWorkflow:
    def test_default_workflow(self):
        state = IssueState(
            owner="test",
            repo="repo",
            issue=GitHubIssue(number=1),
            branch="issue/1",
        )
        assert state.workflow == "default"

    def test_custom_workflow(self):
        state = IssueState(
            owner="test",
            repo="repo",
            issue=GitHubIssue(number=1),
            branch="issue/1",
            workflow="review-only",
        )
        assert state.workflow == "review-only"

    def test_workflow_in_to_dict(self):
        state = IssueState(
            owner="test",
            repo="repo",
            issue=GitHubIssue(number=1),
            branch="issue/1",
            workflow="custom",
        )
        data = state.to_dict()
        assert data["workflow"] == "custom"

    def test_workflow_from_dict(self):
        data = {
            "repo": "test/repo",
            "issue": {"number": 1},
            "branch": "issue/1",
            "workflow": "review-only",
        }
        state = IssueState.from_dict(data)
        assert state.workflow == "review-only"

    def test_workflow_defaults_in_from_dict(self):
        data = {
            "repo": "test/repo",
            "issue": {"number": 1},
            "branch": "issue/1",
        }
        state = IssueState.from_dict(data)
        assert state.workflow == "default"
```

### Step 6.2: Run test to verify it fails

Run: `cd /work/jeeves && python -m pytest tests/test_issue_workflow.py -v`
Expected: FAIL (workflow attribute doesn't exist)

### Step 6.3: Update IssueState

Modify `src/jeeves/core/issue.py`:

1. Add `workflow: str = "default"` field to IssueState dataclass (after `phase` field, around line 64)

2. Update `to_dict()` method to include workflow:
```python
result["workflow"] = self.workflow
```

3. Update `from_dict()` method to parse workflow:
```python
workflow = data.get("workflow", "default")
```
And add to the return statement.

4. Update `create_issue_state()` to accept workflow parameter.

### Step 6.4: Run test to verify it passes

Run: `cd /work/jeeves && python -m pytest tests/test_issue_workflow.py -v`
Expected: PASS

### Step 6.5: Commit

```bash
git add src/jeeves/core/issue.py tests/test_issue_workflow.py
git commit -m "feat(workflow): add workflow field to IssueState

Supports per-issue workflow selection via 'workflow' field in issue.json.
Defaults to 'default' for backward compatibility.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 7: Viewer Integration

**Files:**
- Modify: `src/jeeves/viewer/server.py`

This is the largest task - integrating the workflow engine into the viewer.

### Step 7.1: Add workflow engine imports and initialization

At the top of `server.py`, add imports:
```python
from jeeves.core.workflow import PhaseType
from jeeves.core.workflow_loader import load_workflow_by_name
from jeeves.core.engine import WorkflowEngine
from jeeves.core.script_runner import run_script_phase
```

### Step 7.2: Remove PHASE_TO_PROMPT dict

Delete lines 62-66:
```python
PHASE_TO_PROMPT = {
    "design": "issue.design.md",
    "implement": "issue.implement.md",
    "review": "issue.review.md",
}
```

### Step 7.3: Update resolve_prompt_path function

Replace with:
```python
def resolve_prompt_path(phase: str, prompts_dir: Path, engine: WorkflowEngine) -> Path:
    """Resolve the prompt file path for a phase using the workflow engine."""
    if engine.is_terminal(phase):
        raise ValueError("Phase is complete; no prompt to run.")

    prompt_name = engine.get_prompt_for_phase(phase)
    if not prompt_name:
        raise ValueError(f"No prompt defined for phase: {phase}")

    prompt_path = (prompts_dir / prompt_name).resolve()
    if not prompt_path.exists():
        raise FileNotFoundError(f"Prompt not found: {prompt_path}")
    return prompt_path
```

### Step 7.4: Add workflow engine to JeevesRunManager

In `JeevesRunManager.__init__`, add:
```python
self._workflow_engine: Optional[WorkflowEngine] = None
```

Add method to load workflow:
```python
def _get_workflow_engine(self, workflow_name: str = "default") -> WorkflowEngine:
    """Get or create workflow engine for the given workflow."""
    if self._workflow_engine is None or self._workflow_engine.workflow.name != workflow_name:
        workflow = load_workflow_by_name(workflow_name)
        self._workflow_engine = WorkflowEngine(workflow)
    return self._workflow_engine
```

### Step 7.5: Remove _is_phase_complete method

Delete the entire `_is_phase_complete` method (lines 819-850). The workflow engine handles this via transition evaluation.

### Step 7.6: Update iteration loop for auto-transitions

In `_run_iteration_loop`, after a phase completes, evaluate transitions:

```python
# After phase completes, evaluate transitions
issue_json = self._read_issue_json()
if issue_json:
    workflow_name = issue_json.get("workflow", "default")
    engine = self._get_workflow_engine(workflow_name)
    current_phase = issue_json.get("phase", "design")

    next_phase = engine.evaluate_transitions(current_phase, issue_json)
    if next_phase:
        # Update phase in issue.json
        issue_json["phase"] = next_phase
        self._write_issue_json(issue_json)

        if engine.is_terminal(next_phase):
            self._log_to_file(viewer_log_path, f"[COMPLETE] Reached terminal phase: {next_phase}")
            break

        # Continue to next phase
        self._log_to_file(viewer_log_path, f"[TRANSITION] {current_phase} -> {next_phase}")
```

### Step 7.7: Handle script phases

Add script phase handling in `_run_single_iteration`:

```python
phase_type = engine.get_phase_type(current_phase)

if phase_type == PhaseType.SCRIPT:
    # Run script phase instead of spawning agent
    phase = engine.get_phase(current_phase)
    result = run_script_phase(phase, self.work_dir, issue_json)

    # Update status from script result
    if result.status_updates:
        status = issue_json.get("status", {})
        status.update(result.status_updates)
        issue_json["status"] = status
        self._write_issue_json(issue_json)

    return result.exit_code == 0
```

### Step 7.8: Update prompt resolution calls

Update all calls to `resolve_prompt_path` to pass the engine:
```python
prompt_path = resolve_prompt_path(issue_state.phase, prompts_dir, self._get_workflow_engine(workflow_name))
```

### Step 7.9: Write integration test

```python
# tests/test_viewer_workflow.py
import pytest
from pathlib import Path
from jeeves.core.workflow_loader import load_workflow
from jeeves.core.engine import WorkflowEngine


class TestViewerWorkflowIntegration:
    def test_workflow_loads_from_default(self):
        """Verify the default workflow can be loaded."""
        workflows_dir = Path(__file__).parent.parent / "workflows"
        if (workflows_dir / "default.yaml").exists():
            workflow = load_workflow(workflows_dir / "default.yaml")
            engine = WorkflowEngine(workflow)

            assert engine.get_start_phase().name == "design_draft"
            assert engine.is_terminal("complete")

    def test_design_to_review_transition(self):
        """Test auto-transition from design to review."""
        workflows_dir = Path(__file__).parent.parent / "workflows"
        if (workflows_dir / "default.yaml").exists():
            workflow = load_workflow(workflows_dir / "default.yaml")
            engine = WorkflowEngine(workflow)

            # After design_draft completes, should auto-transition to design_review
            next_phase = engine.evaluate_transitions("design_draft", {})
            assert next_phase == "design_review"
```

### Step 7.10: Run tests

Run: `cd /work/jeeves && python -m pytest tests/test_viewer_workflow.py -v`
Expected: PASS

### Step 7.11: Commit

```bash
git add src/jeeves/viewer/server.py tests/test_viewer_workflow.py
git commit -m "feat(workflow): integrate workflow engine into viewer

- Remove hardcoded PHASE_TO_PROMPT dict
- Remove _is_phase_complete method
- Add workflow engine for transition evaluation
- Handle script phases without spawning AI
- Auto-evaluate transitions after phase completion

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 8: Create New Prompt Files

**Files:**
- Create: `prompts/design.draft.md`
- Create: `prompts/design.review.md`
- Create: `prompts/design.edit.md`
- Create: `prompts/implement.md`
- Create: `prompts/review.evaluate.md`
- Create: `prompts/review.fix.md`

### Step 8.1: Create design.draft.md

```markdown
# Design Phase - Draft

## Phase Type: execute

You are creating the initial design document for this issue.

## Your Task

1. Read the issue requirements from `.jeeves/issue.json`
2. Analyze the codebase to understand the relevant areas
3. Create a design document at the path specified in `designDocPath`
4. Update `.jeeves/issue.json` with `status.designDraftComplete = true`

## Design Document Structure

Your design document should include:
- Summary of the problem
- Proposed solution approach
- Files to be created/modified
- Key implementation details
- Testing strategy

## Completion

When done, update `.jeeves/issue.json`:
```json
{
  "status": {
    "designDraftComplete": true
  }
}
```
```

### Step 8.2: Create design.review.md

```markdown
# Design Phase - Review

## Phase Type: evaluate

IMPORTANT: This is a read-only evaluation phase.
- You MUST NOT modify source code files
- You CAN modify: `.jeeves/issue.json`, `.jeeves/progress.txt`
- Your role is to review and set status flags

## Your Task

1. Read the design document at `designDocPath`
2. Evaluate against the issue requirements
3. Set appropriate status flags

## Review Criteria

- Does the design address all requirements?
- Is the approach sound and maintainable?
- Are there any missing considerations?
- Is the testing strategy adequate?

## Completion

Update `.jeeves/issue.json` with ONE of:

**If changes needed:**
```json
{
  "status": {
    "designNeedsChanges": true,
    "designApproved": false,
    "designFeedback": "Specific feedback here..."
  }
}
```

**If approved:**
```json
{
  "status": {
    "designNeedsChanges": false,
    "designApproved": true
  }
}
```
```

### Step 8.3: Create design.edit.md

```markdown
# Design Phase - Edit

## Phase Type: execute

You are applying changes to the design document based on review feedback.

## Your Task

1. Read the feedback from `.jeeves/issue.json` `status.designFeedback`
2. Update the design document at `designDocPath`
3. Clear the feedback flag

## Completion

When done, update `.jeeves/issue.json`:
```json
{
  "status": {
    "designNeedsChanges": false,
    "designFeedback": null
  }
}
```
```

### Step 8.4: Create implement.md

Copy from existing `issue.implement.md` and update phase type header:
```markdown
# Implementation Phase

## Phase Type: execute

...existing content...
```

### Step 8.5: Create review.evaluate.md

```markdown
# Code Review - Evaluate

## Phase Type: evaluate

IMPORTANT: This is a read-only evaluation phase.
- You MUST NOT modify source code files
- You CAN modify: `.jeeves/issue.json`, `.jeeves/progress.txt`, `.jeeves/review.md`
- Your role is to review and set status flags

## Your Task

1. Review all code changes (use `git diff main...HEAD`)
2. Check for:
   - Code quality and best practices
   - Test coverage
   - Security issues
   - Performance concerns
3. Write review to `.jeeves/review.md`
4. Set appropriate status flags

## Completion

Update `.jeeves/issue.json` with ONE of:

**If changes needed:**
```json
{
  "status": {
    "reviewNeedsChanges": true,
    "reviewClean": false
  }
}
```

**If clean:**
```json
{
  "status": {
    "reviewNeedsChanges": false,
    "reviewClean": true
  }
}
```
```

### Step 8.6: Create review.fix.md

```markdown
# Code Review - Fix

## Phase Type: execute

You are applying fixes based on code review feedback.

## Your Task

1. Read the review from `.jeeves/review.md`
2. Apply the necessary fixes
3. Run tests to verify
4. Clear the fix flags

## Completion

When done, update `.jeeves/issue.json`:
```json
{
  "status": {
    "reviewNeedsChanges": false
  }
}
```
```

### Step 8.7: Commit prompts

```bash
git add prompts/design.draft.md prompts/design.review.md prompts/design.edit.md \
        prompts/implement.md prompts/review.evaluate.md prompts/review.fix.md
git commit -m "feat(workflow): add workflow-aware prompt files

Split monolithic prompts into single-responsibility phases:
- design.draft.md, design.review.md, design.edit.md
- implement.md
- review.evaluate.md, review.fix.md

Each prompt includes phase type header for enforcement.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 9: File Write Enforcement for Evaluate Phases

**Files:**
- Create: `src/jeeves/core/write_checker.py`
- Test: `tests/test_write_checker.py`

### Step 9.1: Write failing test

```python
# tests/test_write_checker.py
import pytest
from pathlib import Path
from jeeves.core.write_checker import check_forbidden_writes


class TestWriteChecker:
    def test_allowed_write_jeeves_dir(self):
        allowed = [".jeeves/*"]
        changed_files = [".jeeves/issue.json", ".jeeves/progress.txt"]

        violations = check_forbidden_writes(changed_files, allowed)

        assert violations == []

    def test_forbidden_write_src(self):
        allowed = [".jeeves/*"]
        changed_files = [".jeeves/issue.json", "src/main.py"]

        violations = check_forbidden_writes(changed_files, allowed)

        assert "src/main.py" in violations

    def test_multiple_allowed_patterns(self):
        allowed = [".jeeves/*", "docs/plans/*"]
        changed_files = [".jeeves/issue.json", "docs/plans/design.md"]

        violations = check_forbidden_writes(changed_files, allowed)

        assert violations == []

    def test_empty_changed_files(self):
        allowed = [".jeeves/*"]
        changed_files = []

        violations = check_forbidden_writes(changed_files, allowed)

        assert violations == []
```

### Step 9.2: Run test to verify it fails

Run: `cd /work/jeeves && python -m pytest tests/test_write_checker.py -v`
Expected: FAIL

### Step 9.3: Write implementation

```python
# src/jeeves/core/write_checker.py
"""Check for forbidden file writes in evaluate phases."""

import fnmatch
from typing import List


def check_forbidden_writes(
    changed_files: List[str],
    allowed_patterns: List[str],
) -> List[str]:
    """Check if any changed files violate the allowed patterns.

    Args:
        changed_files: List of file paths that were modified
        allowed_patterns: Glob patterns for allowed modifications

    Returns:
        List of file paths that were modified but not allowed
    """
    violations = []

    for file_path in changed_files:
        is_allowed = False
        for pattern in allowed_patterns:
            if fnmatch.fnmatch(file_path, pattern):
                is_allowed = True
                break

        if not is_allowed:
            violations.append(file_path)

    return violations
```

### Step 9.4: Run test to verify it passes

Run: `cd /work/jeeves && python -m pytest tests/test_write_checker.py -v`
Expected: PASS

### Step 9.5: Integrate into viewer (after evaluate phase)

Add to viewer after evaluate phase completes:
```python
if phase_type == PhaseType.EVALUATE:
    # Check for forbidden writes
    changed_files = self._get_changed_files()  # git diff --name-only
    phase = engine.get_phase(current_phase)
    violations = check_forbidden_writes(changed_files, phase.allowed_writes)
    if violations:
        self._log_to_file(
            viewer_log_path,
            f"[WARNING] Evaluate phase modified forbidden files: {violations}"
        )
```

### Step 9.6: Commit

```bash
git add src/jeeves/core/write_checker.py tests/test_write_checker.py
git commit -m "feat(workflow): add write checker for evaluate phases

Detects when evaluate phases modify files outside allowed patterns.
Logs warnings but doesn't block (enforcement is advisory).

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 10: Final Integration and Testing

### Step 10.1: Run full test suite

Run: `cd /work/jeeves && python -m pytest tests/ -v`
Expected: All tests PASS

### Step 10.2: Manual integration test

1. Create a test issue with the viewer
2. Verify workflow loads from `workflows/default.yaml`
3. Verify phase transitions work correctly
4. Verify design loop (draft → review → edit → review)
5. Verify script phases run without AI

### Step 10.3: Update CLAUDE.md with workflow patterns

Add to CLAUDE.md:
```markdown
## Workflow System

Jeeves uses a YAML-based workflow engine. Workflows are defined in `workflows/` directory.

### Phase Types
- `execute`: AI agent, can modify code
- `evaluate`: AI agent, read-only (only .jeeves/* allowed)
- `script`: Shell command, no AI
- `terminal`: End state

### Adding a New Phase
1. Add phase to `workflows/default.yaml`
2. Create prompt file in `prompts/`
3. Define transitions with guards

### Guard Expressions
Simple DSL: `status.field == true`, `status.field != value`, `and`, `or`
```

### Step 10.4: Final commit

```bash
git add -A
git commit -m "feat(workflow): complete YAML workflow engine implementation

Implements GitHub issue #20:
- YAML-based workflow definitions in workflows/
- Guard expression parser for transitions
- Script phases for non-AI checks
- Auto-evaluation of transitions
- File write enforcement for evaluate phases
- Split prompts into single-responsibility phases

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Summary

| Task | Description | New Files | Modified Files |
|------|-------------|-----------|----------------|
| 1 | Guard expression parser | `guards.py`, `test_guards.py` | - |
| 2 | Workflow dataclasses | `workflow.py`, `test_workflow.py` | - |
| 3 | YAML loader | `workflow_loader.py`, `test_workflow_loader.py`, `default.yaml` | - |
| 4 | Workflow engine | `engine.py`, `test_engine.py` | - |
| 5 | Script runner | `script_runner.py`, `test_script_runner.py` | - |
| 6 | IssueState workflow field | `test_issue_workflow.py` | `issue.py` |
| 7 | Viewer integration | `test_viewer_workflow.py` | `server.py` |
| 8 | New prompts | 6 prompt files | - |
| 9 | Write checker | `write_checker.py`, `test_write_checker.py` | `server.py` |
| 10 | Final integration | - | `CLAUDE.md` |

**Total: ~15 commits, ~10 new files, ~3 modified files**
