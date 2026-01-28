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
