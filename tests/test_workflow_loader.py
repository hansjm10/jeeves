# tests/test_workflow_loader.py
"""Tests for YAML workflow loader."""

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

    def test_load_default_workflow(self):
        from jeeves.core.workflow_loader import load_workflow

        default_path = Path(__file__).parent.parent / "workflows" / "default.yaml"
        if default_path.exists():
            workflow = load_workflow(default_path)
            assert workflow.name == "default"
            assert workflow.start == "design_draft"
            assert "complete" in workflow.phases

    def test_execute_phase_requires_prompt(self, tmp_path):
        yaml_content = """
workflow:
  name: test
  version: 1
  start: design

phases:
  design:
    type: execute
    # Missing prompt field
    transitions:
      - to: complete
        auto: true
  complete:
    type: terminal
"""
        workflow_file = tmp_path / "test.yaml"
        workflow_file.write_text(yaml_content)

        with pytest.raises(WorkflowValidationError, match="requires a prompt"):
            load_workflow(workflow_file)

    def test_script_phase_requires_command(self, tmp_path):
        yaml_content = """
workflow:
  name: test
  version: 1
  start: ci

phases:
  ci:
    type: script
    # Missing command field
    transitions:
      - to: complete
        auto: true
  complete:
    type: terminal
"""
        workflow_file = tmp_path / "test.yaml"
        workflow_file.write_text(yaml_content)

        with pytest.raises(WorkflowValidationError, match="requires a command"):
            load_workflow(workflow_file)

    def test_invalid_phase_type_raises(self, tmp_path):
        yaml_content = """
workflow:
  name: test
  version: 1
  start: design

phases:
  design:
    type: invalid_type
    prompt: design.md
"""
        workflow_file = tmp_path / "test.yaml"
        workflow_file.write_text(yaml_content)

        with pytest.raises(WorkflowValidationError, match="Invalid phase type"):
            load_workflow(workflow_file)

    def test_load_workflow_by_name_not_found(self, tmp_path):
        from jeeves.core.workflow_loader import load_workflow_by_name

        with pytest.raises(FileNotFoundError, match="not found"):
            load_workflow_by_name("nonexistent", workflows_dir=tmp_path)
