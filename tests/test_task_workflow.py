# tests/test_task_workflow.py
"""Integration tests for task decomposition workflow."""

import pytest
from pathlib import Path

from jeeves.core.workflow_loader import load_workflow
from jeeves.core.engine import WorkflowEngine
from jeeves.core.guards import evaluate_guard
from jeeves.core.workflow import PhaseType


class TestTaskWorkflowTransitions:
    """Tests for task workflow phase transitions."""

    def test_design_review_to_task_decomposition(self):
        """Test transition from design_review to task_decomposition when approved."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        engine = WorkflowEngine(workflow)

        # design_review with designApproved -> task_decomposition
        context = {"status": {"designApproved": True}}
        next_phase = engine.evaluate_transitions("design_review", context)
        assert next_phase == "task_decomposition"

    def test_task_decomposition_to_implement_task(self):
        """Test transition from task_decomposition to implement_task."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        engine = WorkflowEngine(workflow)

        # task_decomposition complete -> implement_task
        context = {"status": {"taskDecompositionComplete": True}}
        next_phase = engine.evaluate_transitions("task_decomposition", context)
        assert next_phase == "implement_task"

    def test_implement_task_to_spec_check(self):
        """Test auto transition from implement_task to task_spec_check."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        engine = WorkflowEngine(workflow)

        # implement_task has auto transition to task_spec_check
        context = {"status": {}}
        next_phase = engine.evaluate_transitions("implement_task", context)
        assert next_phase == "task_spec_check"

    def test_spec_check_pass_with_more_tasks(self):
        """Test spec_check transition when task passes and more tasks remain."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        engine = WorkflowEngine(workflow)

        # task passed and more tasks remain -> implement_task
        context = {"status": {"taskPassed": True, "hasMoreTasks": True}}
        next_phase = engine.evaluate_transitions("task_spec_check", context)
        assert next_phase == "implement_task"

    def test_spec_check_pass_all_complete(self):
        """Test spec_check transition when all tasks are complete."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        engine = WorkflowEngine(workflow)

        # all tasks complete -> completeness_verification
        context = {"status": {"allTasksComplete": True}}
        next_phase = engine.evaluate_transitions("task_spec_check", context)
        assert next_phase == "completeness_verification"

    def test_completeness_to_prepare_pr(self):
        """Test completeness_verification to prepare_pr when complete."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        engine = WorkflowEngine(workflow)

        # implementation complete -> prepare_pr
        context = {"status": {"implementationComplete": True}}
        next_phase = engine.evaluate_transitions("completeness_verification", context)
        assert next_phase == "prepare_pr"

    def test_prepare_pr_to_code_review(self):
        """Test prepare_pr to code_review when PR is created."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        engine = WorkflowEngine(workflow)

        # PR created -> code_review
        context = {"status": {"prCreated": True}}
        next_phase = engine.evaluate_transitions("prepare_pr", context)
        assert next_phase == "code_review"

    def test_completeness_with_missing_work(self):
        """Test completeness_verification returns to implement_task when gaps found."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        engine = WorkflowEngine(workflow)

        # missing work found -> implement_task
        context = {"status": {"missingWork": True}}
        next_phase = engine.evaluate_transitions("completeness_verification", context)
        assert next_phase == "implement_task"


class TestTaskLoopCycle:
    """Tests for full task iteration cycle."""

    def test_full_task_loop(self):
        """Test complete task loop: decompose -> implement -> check -> next."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        engine = WorkflowEngine(workflow)

        # Start from design_review (approved)
        context = {"status": {"designApproved": True}}
        phase = engine.evaluate_transitions("design_review", context)
        assert phase == "task_decomposition"

        # Task decomposition complete
        context = {"status": {"taskDecompositionComplete": True}}
        phase = engine.evaluate_transitions("task_decomposition", context)
        assert phase == "implement_task"

        # Implement task (auto to spec check)
        context = {"status": {}}
        phase = engine.evaluate_transitions("implement_task", context)
        assert phase == "task_spec_check"

        # First task passes, more tasks remain
        context = {"status": {"taskPassed": True, "hasMoreTasks": True}}
        phase = engine.evaluate_transitions("task_spec_check", context)
        assert phase == "implement_task"

        # Second task (auto to spec check)
        context = {"status": {}}
        phase = engine.evaluate_transitions("implement_task", context)
        assert phase == "task_spec_check"

        # Second task passes, all complete
        context = {"status": {"allTasksComplete": True}}
        phase = engine.evaluate_transitions("task_spec_check", context)
        assert phase == "completeness_verification"

        # Completeness check passes -> prepare_pr
        context = {"status": {"implementationComplete": True}}
        phase = engine.evaluate_transitions("completeness_verification", context)
        assert phase == "prepare_pr"

        # PR created -> code_review
        context = {"status": {"prCreated": True}}
        phase = engine.evaluate_transitions("prepare_pr", context)
        assert phase == "code_review"

    def test_task_loop_with_new_tasks_from_completeness(self):
        """Test that completeness check can add new tasks and return to loop."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        engine = WorkflowEngine(workflow)

        # After all tasks complete, completeness check finds gaps
        context = {"status": {"missingWork": True}}
        phase = engine.evaluate_transitions("completeness_verification", context)
        assert phase == "implement_task"

        # New task implemented
        context = {"status": {}}
        phase = engine.evaluate_transitions("implement_task", context)
        assert phase == "task_spec_check"

        # New task passes, now all complete
        context = {"status": {"allTasksComplete": True}}
        phase = engine.evaluate_transitions("task_spec_check", context)
        assert phase == "completeness_verification"


class TestRetryOnSpecCheckFailure:
    """Tests for spec check failure retry mechanism."""

    def test_spec_check_fail_retries_same_task(self):
        """Test that failed spec check returns to implement_task for retry."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        engine = WorkflowEngine(workflow)

        # Task failed -> implement_task (retry)
        context = {"status": {"taskFailed": True}}
        next_phase = engine.evaluate_transitions("task_spec_check", context)
        assert next_phase == "implement_task"

    def test_spec_check_fail_takes_priority_over_pass(self):
        """Test that taskFailed transition is evaluated before taskPassed."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        engine = WorkflowEngine(workflow)

        # Both failed and passed set (edge case) - failed should win
        # Since transitions are evaluated in order, taskFailed comes first
        context = {"status": {"taskFailed": True, "taskPassed": True, "hasMoreTasks": True}}
        next_phase = engine.evaluate_transitions("task_spec_check", context)
        assert next_phase == "implement_task"

    def test_retry_cycle_until_pass(self):
        """Test multiple retry attempts until task passes."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        engine = WorkflowEngine(workflow)

        # First attempt - fail
        context = {"status": {"taskFailed": True}}
        phase = engine.evaluate_transitions("task_spec_check", context)
        assert phase == "implement_task"

        # Retry implement
        context = {"status": {}}
        phase = engine.evaluate_transitions("implement_task", context)
        assert phase == "task_spec_check"

        # Second attempt - fail again
        context = {"status": {"taskFailed": True}}
        phase = engine.evaluate_transitions("task_spec_check", context)
        assert phase == "implement_task"

        # Another retry
        context = {"status": {}}
        phase = engine.evaluate_transitions("implement_task", context)
        assert phase == "task_spec_check"

        # Third attempt - finally pass
        context = {"status": {"taskPassed": True, "hasMoreTasks": False, "allTasksComplete": True}}
        phase = engine.evaluate_transitions("task_spec_check", context)
        assert phase == "completeness_verification"


class TestCIFailureRecovery:
    """Tests for CI failure handling transitions."""

    def test_spec_check_routes_to_fix_ci_on_commit_failure(self):
        """Test that commit failures route to fix_ci phase."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        engine = WorkflowEngine(workflow)

        # Commit failed -> fix_ci
        context = {"status": {"commitFailed": True}}
        next_phase = engine.evaluate_transitions("task_spec_check", context)
        assert next_phase == "fix_ci"

    def test_spec_check_routes_to_fix_ci_on_push_failure(self):
        """Test that push failures route to fix_ci phase."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        engine = WorkflowEngine(workflow)

        # Push failed -> fix_ci
        context = {"status": {"pushFailed": True}}
        next_phase = engine.evaluate_transitions("task_spec_check", context)
        assert next_phase == "fix_ci"

    def test_commit_failure_priority_over_push_failure(self):
        """Test that commitFailed has higher priority than pushFailed."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        engine = WorkflowEngine(workflow)

        # Both failures - commitFailed has priority 1, pushFailed has priority 2
        context = {"status": {"commitFailed": True, "pushFailed": True}}
        next_phase = engine.evaluate_transitions("task_spec_check", context)
        assert next_phase == "fix_ci"

    def test_ci_failure_priority_over_task_failure(self):
        """Test that CI failures have priority over task failures."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        engine = WorkflowEngine(workflow)

        # CI failure with task failure - CI failure has higher priority
        context = {"status": {"commitFailed": True, "taskFailed": True}}
        next_phase = engine.evaluate_transitions("task_spec_check", context)
        assert next_phase == "fix_ci"

    def test_fix_ci_returns_to_spec_check(self):
        """Test that fix_ci has auto transition back to task_spec_check."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        engine = WorkflowEngine(workflow)

        # fix_ci has auto transition to task_spec_check
        context = {"status": {}}
        next_phase = engine.evaluate_transitions("fix_ci", context)
        assert next_phase == "task_spec_check"

    def test_fix_ci_phase_is_execute(self):
        """Test that fix_ci is an execute phase."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        phase = workflow.get_phase("fix_ci")
        assert phase is not None
        assert phase.type == PhaseType.EXECUTE


class TestPRPreparation:
    """Tests for PR preparation phase."""

    def test_prepare_pr_phase_is_execute(self):
        """Test that prepare_pr is an execute phase."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        phase = workflow.get_phase("prepare_pr")
        assert phase is not None
        assert phase.type == PhaseType.EXECUTE

    def test_prepare_pr_prompt_exists(self):
        """Test that prepare_pr has correct prompt that exists."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        phase = workflow.get_phase("prepare_pr")
        assert phase.prompt == "pr.prepare.md"
        prompt_path = Path("prompts") / phase.prompt
        assert prompt_path.exists()


class TestTaskPhaseTypes:
    """Tests for task phase type assignments."""

    def test_task_decomposition_is_execute(self):
        """Task decomposition should be an execute phase."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        phase = workflow.get_phase("task_decomposition")
        assert phase is not None
        assert phase.type == PhaseType.EXECUTE

    def test_implement_task_is_execute(self):
        """Implement task should be an execute phase."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        phase = workflow.get_phase("implement_task")
        assert phase is not None
        assert phase.type == PhaseType.EXECUTE

    def test_task_spec_check_is_evaluate(self):
        """Task spec check should be an evaluate phase (read-only)."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        phase = workflow.get_phase("task_spec_check")
        assert phase is not None
        assert phase.type == PhaseType.EVALUATE

    def test_completeness_verification_is_evaluate(self):
        """Completeness verification should be an evaluate phase (read-only)."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        phase = workflow.get_phase("completeness_verification")
        assert phase is not None
        assert phase.type == PhaseType.EVALUATE


class TestTaskPhaseAllowedWrites:
    """Tests for allowed_writes on task phases."""

    def test_task_spec_check_restricted_writes(self):
        """Spec check should only allow writing to .jeeves/*."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        phase = workflow.get_phase("task_spec_check")
        assert phase is not None
        assert ".jeeves/*" in phase.allowed_writes
        assert len(phase.allowed_writes) == 1

    def test_completeness_verification_restricted_writes(self):
        """Completeness verification should only allow writing to .jeeves/*."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        phase = workflow.get_phase("completeness_verification")
        assert phase is not None
        assert ".jeeves/*" in phase.allowed_writes
        assert len(phase.allowed_writes) == 1


class TestTaskPrompts:
    """Tests for task prompt file references."""

    def test_all_task_prompts_exist(self):
        """Verify all task prompt files exist."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        prompts_dir = Path("prompts")

        task_phases = ["task_decomposition", "implement_task", "task_spec_check",
                       "completeness_verification"]

        for phase_name in task_phases:
            phase = workflow.get_phase(phase_name)
            assert phase is not None, f"Phase {phase_name} should exist"
            assert phase.prompt is not None, f"Phase {phase_name} should have a prompt"
            prompt_path = prompts_dir / phase.prompt
            assert prompt_path.exists(), f"Prompt file {phase.prompt} for phase {phase_name} not found"

    def test_task_decomposition_prompt(self):
        """Test task decomposition has correct prompt."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        phase = workflow.get_phase("task_decomposition")
        assert phase.prompt == "task.decompose.md"

    def test_implement_task_prompt(self):
        """Test implement task has correct prompt."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        phase = workflow.get_phase("implement_task")
        assert phase.prompt == "task.implement.md"

    def test_task_spec_check_prompt(self):
        """Test task spec check has correct prompt."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        phase = workflow.get_phase("task_spec_check")
        assert phase.prompt == "task.spec_check.md"

    def test_completeness_verification_prompt(self):
        """Test completeness verification has correct prompt."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        phase = workflow.get_phase("completeness_verification")
        assert phase.prompt == "verify.completeness.md"


class TestTaskGuards:
    """Tests for task-related guard expressions."""

    def test_task_decomposition_complete_guard(self):
        """Test taskDecompositionComplete guard expression."""
        assert evaluate_guard("status.taskDecompositionComplete == true",
                             {"status": {"taskDecompositionComplete": True}}) is True
        assert evaluate_guard("status.taskDecompositionComplete == true",
                             {"status": {"taskDecompositionComplete": False}}) is False
        assert evaluate_guard("status.taskDecompositionComplete == true",
                             {"status": {}}) is False

    def test_task_passed_guard(self):
        """Test taskPassed guard expression."""
        assert evaluate_guard("status.taskPassed == true",
                             {"status": {"taskPassed": True}}) is True
        assert evaluate_guard("status.taskPassed == true",
                             {"status": {"taskPassed": False}}) is False

    def test_task_failed_guard(self):
        """Test taskFailed guard expression."""
        assert evaluate_guard("status.taskFailed == true",
                             {"status": {"taskFailed": True}}) is True
        assert evaluate_guard("status.taskFailed == true",
                             {"status": {"taskFailed": False}}) is False

    def test_has_more_tasks_guard(self):
        """Test hasMoreTasks guard expression."""
        assert evaluate_guard("status.hasMoreTasks == true",
                             {"status": {"hasMoreTasks": True}}) is True
        assert evaluate_guard("status.hasMoreTasks == true",
                             {"status": {"hasMoreTasks": False}}) is False

    def test_all_tasks_complete_guard(self):
        """Test allTasksComplete guard expression."""
        assert evaluate_guard("status.allTasksComplete == true",
                             {"status": {"allTasksComplete": True}}) is True
        assert evaluate_guard("status.allTasksComplete == true",
                             {"status": {"allTasksComplete": False}}) is False

    def test_missing_work_guard(self):
        """Test missingWork guard expression."""
        assert evaluate_guard("status.missingWork == true",
                             {"status": {"missingWork": True}}) is True
        assert evaluate_guard("status.missingWork == true",
                             {"status": {"missingWork": False}}) is False

    def test_implementation_complete_guard(self):
        """Test implementationComplete guard expression."""
        assert evaluate_guard("status.implementationComplete == true",
                             {"status": {"implementationComplete": True}}) is True
        assert evaluate_guard("status.implementationComplete == true",
                             {"status": {"implementationComplete": False}}) is False

    def test_compound_guard_task_passed_and_more_tasks(self):
        """Test compound guard: taskPassed and hasMoreTasks."""
        guard = "status.taskPassed == true and status.hasMoreTasks == true"

        # Both true
        assert evaluate_guard(guard, {"status": {"taskPassed": True, "hasMoreTasks": True}}) is True

        # One false
        assert evaluate_guard(guard, {"status": {"taskPassed": True, "hasMoreTasks": False}}) is False
        assert evaluate_guard(guard, {"status": {"taskPassed": False, "hasMoreTasks": True}}) is False

        # Both false
        assert evaluate_guard(guard, {"status": {"taskPassed": False, "hasMoreTasks": False}}) is False


class TestWorkflowVersion:
    """Tests for workflow version update."""

    def test_workflow_version_is_2(self):
        """Verify workflow version was updated to 2."""
        workflow = load_workflow(Path("workflows/default.yaml"))
        assert workflow.version == 2

    def test_workflow_has_all_expected_phases(self):
        """Verify workflow has all expected phases including new task phases."""
        workflow = load_workflow(Path("workflows/default.yaml"))

        expected_phases = [
            "design_draft",
            "design_review",
            "design_edit",
            "task_decomposition",
            "implement_task",
            "task_spec_check",
            "fix_ci",
            "completeness_verification",
            "prepare_pr",
            "code_review",
            "code_fix",
            "complete",
        ]

        for phase_name in expected_phases:
            assert phase_name in workflow.phases, f"Missing phase: {phase_name}"

        assert len(workflow.phases) == len(expected_phases)
