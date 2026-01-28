# tests/test_viewer_workflow.py
"""Integration tests for workflow engine in the viewer."""

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

    def test_design_review_needs_changes(self):
        """Test design review transition when changes are needed."""
        workflows_dir = Path(__file__).parent.parent / "workflows"
        if (workflows_dir / "default.yaml").exists():
            workflow = load_workflow(workflows_dir / "default.yaml")
            engine = WorkflowEngine(workflow)

            # With designNeedsChanges set, should go to design_edit
            context = {"status": {"designNeedsChanges": True}}
            next_phase = engine.evaluate_transitions("design_review", context)
            assert next_phase == "design_edit"

    def test_design_review_approved(self):
        """Test design review transition when approved."""
        workflows_dir = Path(__file__).parent.parent / "workflows"
        if (workflows_dir / "default.yaml").exists():
            workflow = load_workflow(workflows_dir / "default.yaml")
            engine = WorkflowEngine(workflow)

            # With designApproved set, should go to implement
            context = {"status": {"designApproved": True}}
            next_phase = engine.evaluate_transitions("design_review", context)
            assert next_phase == "implement"

    def test_code_review_clean_to_complete(self):
        """Test code review transition to complete when clean."""
        workflows_dir = Path(__file__).parent.parent / "workflows"
        if (workflows_dir / "default.yaml").exists():
            workflow = load_workflow(workflows_dir / "default.yaml")
            engine = WorkflowEngine(workflow)

            # With reviewClean set, should go to complete (terminal)
            context = {"status": {"reviewClean": True}}
            next_phase = engine.evaluate_transitions("code_review", context)
            assert next_phase == "complete"
            assert engine.is_terminal("complete")

    def test_implement_to_code_review_auto(self):
        """Test auto-transition from implement to code_review."""
        workflows_dir = Path(__file__).parent.parent / "workflows"
        if (workflows_dir / "default.yaml").exists():
            workflow = load_workflow(workflows_dir / "default.yaml")
            engine = WorkflowEngine(workflow)

            # After implement completes, should auto-transition to code_review
            next_phase = engine.evaluate_transitions("implement", {})
            assert next_phase == "code_review"

    def test_terminal_phase_no_transitions(self):
        """Test that terminal phases have no transitions."""
        workflows_dir = Path(__file__).parent.parent / "workflows"
        if (workflows_dir / "default.yaml").exists():
            workflow = load_workflow(workflows_dir / "default.yaml")
            engine = WorkflowEngine(workflow)

            # Terminal phase should not transition
            next_phase = engine.evaluate_transitions("complete", {})
            assert next_phase is None

    def test_get_prompt_for_phases(self):
        """Test prompt file retrieval for each phase."""
        workflows_dir = Path(__file__).parent.parent / "workflows"
        if (workflows_dir / "default.yaml").exists():
            workflow = load_workflow(workflows_dir / "default.yaml")
            engine = WorkflowEngine(workflow)

            # Check prompts for key phases
            assert engine.get_prompt_for_phase("design_draft") == "design.draft.md"
            assert engine.get_prompt_for_phase("design_review") == "design.review.md"
            assert engine.get_prompt_for_phase("implement") == "implement.md"
            assert engine.get_prompt_for_phase("code_review") == "review.evaluate.md"
            # Terminal phase has no prompt
            assert engine.get_prompt_for_phase("complete") is None
