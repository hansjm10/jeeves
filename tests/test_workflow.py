# tests/test_workflow.py
"""Tests for workflow dataclasses."""

import pytest
from jeeves.core.workflow import (
    Workflow,
    Phase,
    Transition,
    PhaseType,
)


class TestWorkflowDataclasses:
    """Tests for workflow dataclass structures."""

    def test_create_transition(self):
        """Should create a Transition with default values."""
        t = Transition(to="implement", when="status.designApproved == true")
        assert t.to == "implement"
        assert t.when == "status.designApproved == true"
        assert t.auto is False
        assert t.priority == 0

    def test_create_auto_transition(self):
        """Should create an auto-transition without guard expression."""
        t = Transition(to="review", auto=True)
        assert t.auto is True
        assert t.when is None

    def test_create_phase(self):
        """Should create a Phase with transitions."""
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
        """Should create a script phase with command and status mapping."""
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
        """Should create a Workflow with phases."""
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
