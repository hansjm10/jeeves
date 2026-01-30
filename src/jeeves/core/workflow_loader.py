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
        model=data.get("model"),
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
