# tests/test_integration_workflow.py
"""Integration tests for the complete workflow system."""
import pytest
import json
from pathlib import Path

from jeeves.core.workflow_loader import load_workflow
from jeeves.core.engine import WorkflowEngine
from jeeves.core.guards import evaluate_guard
from jeeves.core.issue import IssueState
from jeeves.core.workflow import PhaseType


class TestWorkflowIntegration:
    """End-to-end tests for workflow system."""

    def test_complete_workflow_traversal(self, tmp_path):
        """Test traversing through the entire default workflow."""
        # Load workflow
        workflow = load_workflow(Path("workflows/default.yaml"))
        engine = WorkflowEngine(workflow)

        # Start at design_draft
        current = engine.get_start_phase()
        assert current.name == "design_draft"
        assert current.type == PhaseType.EXECUTE

        # design_draft has auto transition to design_review
        context = {"status": {}}
        next_phase = engine.evaluate_transitions("design_draft", context)
        assert next_phase == "design_review"

        # design_review with designApproved -> task_decomposition
        context = {"status": {"designApproved": True}}
        next_phase = engine.evaluate_transitions("design_review", context)
        assert next_phase == "task_decomposition"

        # task_decomposition with taskDecompositionComplete -> implement_task
        context = {"status": {"taskDecompositionComplete": True}}
        next_phase = engine.evaluate_transitions("task_decomposition", context)
        assert next_phase == "implement_task"

        # implement_task has auto transition to task_spec_check
        context = {"status": {}}
        next_phase = engine.evaluate_transitions("implement_task", context)
        assert next_phase == "task_spec_check"

        # task_spec_check with allTasksComplete -> completeness_verification
        context = {"status": {"allTasksComplete": True}}
        next_phase = engine.evaluate_transitions("task_spec_check", context)
        assert next_phase == "completeness_verification"

        # completeness_verification with implementationComplete -> code_review
        context = {"status": {"implementationComplete": True}}
        next_phase = engine.evaluate_transitions("completeness_verification", context)
        assert next_phase == "code_review"

        # code_review with reviewClean -> complete
        context = {"status": {"reviewClean": True}}
        next_phase = engine.evaluate_transitions("code_review", context)
        assert next_phase == "complete"

        # Verify complete is terminal
        assert engine.is_terminal("complete") is True

    def test_workflow_with_issue_state(self, tmp_path):
        """Test workflow interacts correctly with IssueState."""
        # Create issue config
        issue_dir = tmp_path / ".jeeves"
        issue_dir.mkdir()
        issue_file = issue_dir / "issue.json"
        issue_file.write_text(json.dumps({
            "repo": "test-owner/test-repo",
            "issue": {"number": 123, "title": "Test Issue"},
            "branch": "issue/123",
            "phase": "design_draft",
            "workflow": "default"
        }))

        # Load issue and workflow
        issue = IssueState.load_from_path(issue_file)
        workflow = load_workflow(Path("workflows/default.yaml"))
        engine = WorkflowEngine(workflow)

        # Verify current phase
        phase = engine.get_phase(issue.phase)
        assert phase is not None
        assert phase.name == "design_draft"
        assert phase.type == PhaseType.EXECUTE

        # Verify prompt resolution
        prompt_path = engine.get_prompt_for_phase("design_draft")
        assert prompt_path == "design.draft.md"

    def test_design_review_loop(self):
        """Test that design_review can loop back to design_edit."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        engine = WorkflowEngine(workflow)

        # Review needs changes -> design_edit
        context = {"status": {"designNeedsChanges": True}}
        next_phase = engine.evaluate_transitions("design_review", context)
        assert next_phase == "design_edit"

        # design_edit has auto transition back to design_review (loop)
        context = {"status": {}}
        next_phase = engine.evaluate_transitions("design_edit", context)
        assert next_phase == "design_review"

    def test_code_review_loop(self):
        """Test that code_review can loop back to code_fix."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        engine = WorkflowEngine(workflow)

        # Review needs changes -> code_fix
        context = {"status": {"reviewNeedsChanges": True}}
        next_phase = engine.evaluate_transitions("code_review", context)
        assert next_phase == "code_fix"

        # code_fix has auto transition back to code_review (loop)
        context = {"status": {}}
        next_phase = engine.evaluate_transitions("code_fix", context)
        assert next_phase == "code_review"

    def test_all_phases_have_correct_types(self):
        """Verify all phases in default workflow have correct types."""
        workflow = load_workflow(Path("workflows/default.yaml"))

        # Execute phases (can modify code)
        execute_phases = ["design_draft", "design_edit", "task_decomposition",
                         "implement_task", "code_fix"]
        for name in execute_phases:
            phase = workflow.get_phase(name)
            assert phase is not None, f"Phase {name} should exist"
            assert phase.type == PhaseType.EXECUTE, f"Phase {name} should be EXECUTE"

        # Evaluate phases (read-only analysis)
        evaluate_phases = ["design_review", "task_spec_check",
                          "completeness_verification", "code_review"]
        for name in evaluate_phases:
            phase = workflow.get_phase(name)
            assert phase is not None, f"Phase {name} should exist"
            assert phase.type == PhaseType.EVALUATE, f"Phase {name} should be EVALUATE"

        # Terminal phase
        complete = workflow.get_phase("complete")
        assert complete is not None
        assert complete.type == PhaseType.TERMINAL

    def test_all_prompts_exist(self):
        """Verify all prompt files referenced by workflow exist."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        prompts_dir = Path("prompts")

        for name, phase in workflow.phases.items():
            if phase.prompt:
                prompt_path = prompts_dir / phase.prompt
                assert prompt_path.exists(), f"Prompt file {phase.prompt} for phase {name} not found"

    def test_evaluate_phases_have_allowed_writes(self):
        """Verify evaluate phases have restricted allowed_writes."""
        workflow = load_workflow(Path("workflows/default.yaml"))

        evaluate_phases = ["design_review", "task_spec_check",
                          "completeness_verification", "code_review"]
        for name in evaluate_phases:
            phase = workflow.get_phase(name)
            assert phase is not None
            # Evaluate phases should only allow writing to .jeeves/*
            assert ".jeeves/*" in phase.allowed_writes
            # Should have limited writes (just .jeeves/* by default)
            assert len(phase.allowed_writes) == 1

    def test_workflow_metadata(self):
        """Verify workflow metadata is correct."""
        workflow = load_workflow(Path("workflows/default.yaml"))

        assert workflow.name == "default"
        assert workflow.version == 2
        assert workflow.start == "design_draft"

    def test_no_transition_when_no_status_match(self):
        """Test that no transition happens when status doesn't match any guard."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        engine = WorkflowEngine(workflow)

        # design_review with neither designNeedsChanges nor designApproved
        context = {"status": {}}
        next_phase = engine.evaluate_transitions("design_review", context)
        assert next_phase is None  # Should stay in current phase

        # code_review with neither reviewNeedsChanges nor reviewClean
        context = {"status": {}}
        next_phase = engine.evaluate_transitions("code_review", context)
        assert next_phase is None  # Should stay in current phase

    def test_guard_expressions_are_valid(self):
        """Test that all guard expressions in the workflow are syntactically valid."""
        workflow = load_workflow(Path("workflows/default.yaml"))

        # Test each transition's guard expression
        test_context = {"status": {"designNeedsChanges": True, "designApproved": False,
                                    "reviewNeedsChanges": True, "reviewClean": False}}

        for name, phase in workflow.phases.items():
            for transition in phase.transitions:
                if transition.when:
                    # Should not raise an exception
                    result = evaluate_guard(transition.when, test_context)
                    assert isinstance(result, bool), f"Guard {transition.when} should return bool"


class TestWorkflowLoaderIntegration:
    """Integration tests for workflow loading."""

    def test_load_default_workflow(self):
        """Test that the default workflow loads successfully."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        assert workflow is not None
        assert len(workflow.phases) == 10  # All phases including task phases and complete

    def test_workflow_phases_are_connected(self):
        """Verify all phases are reachable from start."""
        workflow = load_workflow(Path("workflows/default.yaml"))

        # Find all reachable phases from start
        reachable = set()
        to_visit = [workflow.start]

        while to_visit:
            current = to_visit.pop()
            if current in reachable:
                continue
            reachable.add(current)

            phase = workflow.get_phase(current)
            if phase:
                for transition in phase.transitions:
                    if transition.to not in reachable:
                        to_visit.append(transition.to)

        # All phases should be reachable
        assert reachable == set(workflow.phases.keys()), \
            f"Not all phases reachable. Missing: {set(workflow.phases.keys()) - reachable}"


class TestGuardEvaluation:
    """Integration tests for guard evaluation with workflow."""

    def test_design_review_guards(self):
        """Test the guard expressions used in design_review phase."""
        # designNeedsChanges == true
        assert evaluate_guard("status.designNeedsChanges == true",
                             {"status": {"designNeedsChanges": True}}) is True
        assert evaluate_guard("status.designNeedsChanges == true",
                             {"status": {"designNeedsChanges": False}}) is False

        # designApproved == true
        assert evaluate_guard("status.designApproved == true",
                             {"status": {"designApproved": True}}) is True
        assert evaluate_guard("status.designApproved == true",
                             {"status": {"designApproved": False}}) is False

    def test_code_review_guards(self):
        """Test the guard expressions used in code_review phase."""
        # reviewNeedsChanges == true
        assert evaluate_guard("status.reviewNeedsChanges == true",
                             {"status": {"reviewNeedsChanges": True}}) is True
        assert evaluate_guard("status.reviewNeedsChanges == true",
                             {"status": {"reviewNeedsChanges": False}}) is False

        # reviewClean == true
        assert evaluate_guard("status.reviewClean == true",
                             {"status": {"reviewClean": True}}) is True
        assert evaluate_guard("status.reviewClean == true",
                             {"status": {"reviewClean": False}}) is False

    def test_missing_status_fields(self):
        """Test guard evaluation when status fields are missing."""
        # Missing field should evaluate to falsy
        assert evaluate_guard("status.designApproved == true",
                             {"status": {}}) is False
        assert evaluate_guard("status.reviewClean == true",
                             {}) is False
