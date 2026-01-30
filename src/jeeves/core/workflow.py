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
        model: Optional model identifier for this phase. Valid values: sonnet, opus, haiku.
               If not set, inherits from workflow default_model or system default.
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
    model: Optional[str] = None


@dataclass
class Workflow:
    """A complete workflow definition.

    Attributes:
        name: Workflow identifier
        version: Schema version
        start: Name of the starting phase
        phases: Map of phase name to Phase object
        default_model: Optional default model for phases in this workflow.
                       Valid values: sonnet, opus, haiku. If not set, uses system default.
    """
    name: str
    version: int
    start: str
    phases: Dict[str, Phase]
    default_model: Optional[str] = None

    def get_phase(self, name: str) -> Optional[Phase]:
        """Get a phase by name."""
        return self.phases.get(name)

    def get_start_phase(self) -> Phase:
        """Get the starting phase."""
        phase = self.phases.get(self.start)
        if not phase:
            raise ValueError(f"Start phase '{self.start}' not found in workflow")
        return phase
