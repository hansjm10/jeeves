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


class TestPhaseModel:
    """Tests for Phase model field."""

    def test_phase_model_default_none(self):
        """Phase model defaults to None when not specified."""
        phase = Phase(name="test", type=PhaseType.EXECUTE, prompt="test.md")
        assert phase.model is None

    def test_phase_model_can_be_set(self):
        """Phase model can be set to a valid value."""
        phase = Phase(name="test", type=PhaseType.EXECUTE, prompt="test.md", model="opus")
        assert phase.model == "opus"

    def test_phase_model_all_valid_values(self):
        """Phase model accepts all valid model values."""
        for model in ["sonnet", "opus", "haiku"]:
            phase = Phase(name="test", type=PhaseType.EXECUTE, prompt="test.md", model=model)
            assert phase.model == model


class TestWorkflowDefaultModel:
    """Tests for Workflow default_model field."""

    def test_workflow_default_model_none(self):
        """Workflow default_model defaults to None when not specified."""
        workflow = Workflow(
            name="test",
            version=1,
            start="start",
            phases={"start": Phase(name="start", type=PhaseType.TERMINAL)}
        )
        assert workflow.default_model is None

    def test_workflow_default_model_can_be_set(self):
        """Workflow default_model can be set to a valid value."""
        workflow = Workflow(
            name="test",
            version=1,
            start="start",
            phases={"start": Phase(name="start", type=PhaseType.TERMINAL)},
            default_model="sonnet"
        )
        assert workflow.default_model == "sonnet"


class TestGetEffectiveModel:
    """Tests for Workflow.get_effective_model method."""

    def test_get_effective_model_phase_override(self):
        """Phase model overrides workflow default."""
        phases = {
            "design": Phase(name="design", type=PhaseType.EXECUTE, prompt="d.md", model="opus")
        }
        workflow = Workflow(
            name="test", version=1, start="design",
            phases=phases, default_model="sonnet"
        )
        assert workflow.get_effective_model("design") == "opus"

    def test_get_effective_model_workflow_default(self):
        """Workflow default used when phase has no model."""
        phases = {
            "design": Phase(name="design", type=PhaseType.EXECUTE, prompt="d.md")
        }
        workflow = Workflow(
            name="test", version=1, start="design",
            phases=phases, default_model="haiku"
        )
        assert workflow.get_effective_model("design") == "haiku"

    def test_get_effective_model_none(self):
        """Returns None when no model configured anywhere."""
        phases = {
            "design": Phase(name="design", type=PhaseType.EXECUTE, prompt="d.md")
        }
        workflow = Workflow(name="test", version=1, start="design", phases=phases)
        assert workflow.get_effective_model("design") is None

    def test_get_effective_model_nonexistent_phase(self):
        """Returns None for non-existent phase."""
        phases = {
            "design": Phase(name="design", type=PhaseType.EXECUTE, prompt="d.md")
        }
        workflow = Workflow(name="test", version=1, start="design", phases=phases)
        assert workflow.get_effective_model("nonexistent") is None
